import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";
import { env, isConfigured, missingConfig } from "@/lib/env";
import { formatLocal } from "@/lib/time";
import { createCalBooking, eventDurationMinutes, getAvailableSlots } from "@/providers/calcom";
import { ProviderError } from "@/providers/http";
import { audit } from "./audit";
import { createTask } from "./tasks";

const SLOT_TTL_MS = 30 * 60_000;
const ACTIVE = ["requested", "pending", "confirmed"];

export interface OfferedSlot {
  slot_id: string;
  start: string;
  end: string;
  timezone: string;
  label: string;
}

export type OfferResult =
  | { ok: true; slots: OfferedSlot[] }
  | { ok: false; reason: "not_eligible" | "calendar_unavailable" | "no_slots"; say: string };

const CALLBACK_SAY = () =>
  `I'm not able to check the calendar right now, but I've noted your details and a designer will call you ${env.callbackPromiseText()} to fix a time.`;

/** Only GREEN (or human-approved) leads enter automatic booking. */
export function eligibleForAutoBooking(call: Row): boolean {
  return (call.effective_outcome ?? call.system_outcome) === "GREEN_QUALIFIED";
}

export async function activeBookingForLead(leadId: string): Promise<Row | null> {
  const rows = await getDb().find("bookings", { lead_id: leadId, status: ACTIVE }, { order: ["created_at", "desc"], limit: 1 });
  return rows[0] ?? null;
}

export async function latestBookingForLead(leadId: string): Promise<Row | null> {
  const rows = await getDb().find("bookings", { lead_id: leadId }, { order: ["created_at", "desc"], limit: 1 });
  return rows[0] ?? null;
}

/** First slot of each of the first days with availability: gives the caller a real spread, never invented times. */
function pickSpread(slots: { start: string; end: string }[], max = 3) {
  const seenDays = new Set<string>();
  const picked: typeof slots = [];
  for (const s of slots) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: env.timezone() }).format(new Date(s.start));
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    picked.push(s);
    if (picked.length === max) break;
  }
  if (picked.length < max) for (const s of slots) if (!picked.includes(s) && picked.length < max) picked.push(s);
  return picked.sort((a, b) => a.start.localeCompare(b.start));
}

export async function offerSlots(call: Row, now = new Date()): Promise<OfferResult> {
  if (!eligibleForAutoBooking(call))
    return { ok: false, reason: "not_eligible", say: `A designer will be in touch ${env.callbackPromiseText()} to take this forward.` };

  let slots;
  try {
    const noticeH = Number(env.get("CAL_MIN_NOTICE_HOURS") ?? 12);
    const from = new Date(now.getTime() + noticeH * 3_600_000);
    const to = new Date(from.getTime() + 14 * 86_400_000);
    slots = await getAvailableSlots(from.toISOString(), to.toISOString());
  } catch (e) {
    await createTask({
      dedupeKey: `booking_followup:${call.lead_id}`, kind: "booking_followup", leadId: call.lead_id, callId: call.id,
      dueInMinutes: env.callbackSlaMinutes(), notes: `Calendar unavailable during call: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { ok: false, reason: "calendar_unavailable", say: CALLBACK_SAY() };
  }
  if (slots.length === 0) {
    await createTask({ dedupeKey: `booking_followup:${call.lead_id}`, kind: "booking_followup", leadId: call.lead_id, callId: call.id, dueInMinutes: env.callbackSlaMinutes(), notes: "No free slots in the next 14 days" });
    return { ok: false, reason: "no_slots", say: `I don't see any free consultation slots in the next couple of weeks, so a designer will call you ${env.callbackPromiseText()} to arrange one.` };
  }

  const tz = env.timezone();
  const out: OfferedSlot[] = [];
  for (const s of pickSpread(slots)) {
    const id = newId();
    await getDb().insert("offered_slots", { id, call_id: call.id, start_at: s.start, end_at: s.end, timezone: tz, designer: null, offered_at: nowIso() });
    out.push({ slot_id: id, start: s.start, end: s.end, timezone: tz, label: formatLocal(s.start, tz) });
  }
  return { ok: true, slots: out };
}

export type BookResult =
  | { status: "confirmed"; say: string; booking: Row }
  | { status: "pending"; say: string; booking: Row | null }
  | { status: "needs_confirmation" | "needs_email" | "slot_unavailable" | "not_eligible"; say: string };

const PENDING_SAY = () => `I haven't been able to lock that time in just yet, but I've noted it and a designer will confirm with you ${env.callbackPromiseText()}.`;

export async function bookSlot(
  call: Row,
  input: { slotId: string; confirmed: boolean; email?: string | null; name?: string | null; phone?: string | null },
  now = new Date(),
): Promise<BookResult> {
  const db = getDb();
  if (!eligibleForAutoBooking(call)) return { status: "not_eligible", say: `A designer will be in touch ${env.callbackPromiseText()}.` };
  if (input.confirmed !== true)
    return { status: "needs_confirmation", say: "Please confirm that exact time with the caller before I book it." };

  const slot = await db.get("offered_slots", input.slotId);
  if (!slot || slot.call_id !== call.id || now.getTime() - Date.parse(slot.offered_at) > SLOT_TTL_MS)
    return { status: "slot_unavailable", say: "That time is no longer on offer. Let me check the calendar again." };

  // Idempotency: one active booking per lead.
  const existing = await activeBookingForLead(call.lead_id);
  if (existing) return existingResult(existing);

  const email = input.email ?? call.extracted?.caller_email ?? null;
  const requireEmail = env.get("CAL_REQUIRE_EMAIL") !== "false";
  if (requireEmail && !email) return { status: "needs_email", say: "May I have an email address to send the calendar invite to?" };

  const row = {
    id: newId(), call_id: call.id, lead_id: call.lead_id, active_key: call.lead_id, provider: "cal.com", provider_booking_uid: null,
    status: "requested", designer: null, start_at: slot.start_at, end_at: slot.end_at, timezone: slot.timezone,
    attendee_email: email, failure_reason: null, created_at: nowIso(), updated_at: nowIso(),
  };
  const ins = await db.insert("bookings", row);
  if (ins.conflict) {
    const again = await activeBookingForLead(call.lead_id);
    if (again) return existingResult(again);
    return { status: "pending", say: PENDING_SAY(), booking: null };
  }
  await audit({ actor: "voice-agent", actorType: "provider", action: "booking.requested", entityType: "booking", entityId: row.id, after: { start: row.start_at } });

  const fail = async (status: "failed" | "pending", reason: string, task: "booking_followup" | "verify_booking") => {
    const patch: Row = { status, failure_reason: reason, updated_at: nowIso() };
    if (status === "failed") patch.active_key = null; // free the lead to be booked again
    const updated = await db.update("bookings", row.id, patch);
    await audit({ actor: "system", actorType: "system", action: `booking.${status}`, entityType: "booking", entityId: row.id, reason });
    await createTask({
      dedupeKey: `${task}:${call.lead_id}`, kind: task, leadId: call.lead_id, callId: call.id, dueInMinutes: env.callbackSlaMinutes(),
      notes: task === "verify_booking" ? `Booking outcome unknown (${reason}). Check Cal.com before re-booking to avoid a duplicate.` : `Booking failed: ${reason}`,
    });
    return updated;
  };

  if (!isConfigured("calcom")) {
    const b = await fail("failed", `Cal.com not configured: missing ${missingConfig("calcom").join(", ")}`, "booking_followup");
    return { status: "pending", say: CALLBACK_SAY(), booking: b };
  }

  try {
    const cal = await createCalBooking({ startIso: slot.start_at, name: input.name ?? call.extracted?.caller_name ?? "Caller", email, phone: input.phone ?? call.from_number });
    if (cal.status === "accepted") {
      const confirmed = await db.update("bookings", row.id, {
        status: "confirmed", provider_booking_uid: cal.uid, designer: cal.designer, start_at: cal.start, end_at: cal.end, failure_reason: null, updated_at: nowIso(),
      });
      await audit({ actor: "cal.com", actorType: "provider", action: "booking.confirmed", entityType: "booking", entityId: row.id, after: { uid: cal.uid, start: cal.start, designer: cal.designer } });
      return { status: "confirmed", booking: confirmed!, say: `You're booked for ${formatLocal(cal.start, slot.timezone)}. A calendar invite is on its way to you.` };
    }
    // Provider created it but it is not confirmed (e.g. awaiting host approval): never claim confirmed.
    const pending = await db.update("bookings", row.id, { status: "pending", provider_booking_uid: cal.uid, designer: cal.designer, failure_reason: `provider status ${cal.status}`, updated_at: nowIso() });
    await createTask({ dedupeKey: `verify_booking:${call.lead_id}`, kind: "verify_booking", leadId: call.lead_id, callId: call.id, dueInMinutes: env.callbackSlaMinutes(), notes: `Cal.com status "${cal.status}", not yet accepted` });
    return { status: "pending", say: PENDING_SAY(), booking: pending };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ProviderError && e.outcomeUnknown) {
      const b = await fail("pending", `unknown outcome: ${msg}`, "verify_booking");
      return { status: "pending", say: PENDING_SAY(), booking: b };
    }
    if (e instanceof ProviderError && e.kind === "http" && [400, 409, 422].includes(e.status ?? 0)) {
      await fail("failed", `slot rejected by provider: ${msg}`, "booking_followup");
      return { status: "slot_unavailable", say: "That time has just been taken. Let me check the calendar again." };
    }
    const b = await fail("failed", msg, "booking_followup");
    return { status: "pending", say: PENDING_SAY(), booking: b };
  }
}

function existingResult(b: Row): BookResult {
  if (b.status === "confirmed")
    return { status: "confirmed", booking: b, say: `You're already booked for ${formatLocal(b.start_at, b.timezone)}.` };
  return { status: "pending", booking: b, say: PENDING_SAY() };
}

/** Manual dashboard transitions. Provider-side cancellation/reschedule must be done in Cal.com; we record and audit. */
export async function setBookingStatus(id: string, status: "cancelled" | "rescheduled", actor: string, reason: string) {
  const db = getDb();
  const b = await db.get("bookings", id);
  if (!b) return null;
  const updated = await db.update("bookings", id, { status, active_key: null, updated_at: nowIso(), failure_reason: reason });
  await audit({ actor, actorType: "user", action: `booking.${status}`, entityType: "booking", entityId: id, before: { status: b.status }, after: { status }, reason });
  return updated;
}

export { eventDurationMinutes };
