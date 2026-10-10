import { getDb } from "@/db";
import { nowIso, type Row } from "@/db/adapter";
import { env } from "@/lib/env";
import { audit } from "./audit";
import { latestBookingForLead } from "./booking";
import { recordCallCosts } from "./costs";
import { previousCalls } from "./leads";
import { enqueue, runDueJobs } from "./jobs";
import { containsPrice } from "./pricing-guard";
import { applyEvaluation, latestLiveFields, mergeFields, saveQualification } from "./qualification/service";
import { evaluate } from "./qualification/rules";
import { FieldsSchema, type Fields } from "./qualification/schema";
import { buildHandoffNote, deterministicNarrative, extractWithGemini, geminiAvailable, type BookingInfo, type Narrative } from "./summary";
import { createTask } from "./tasks";
import type { NormalizedEvent, Turn } from "./webhooks/vaani-adapter";

const asFields = (v: unknown): Partial<Fields> | null => {
  const r = FieldsSchema.safeParse(v ?? {});
  return v && typeof v === "object" && r.success ? r.data : null;
};

async function historyOf(call: Row) {
  const prev = call.lead_id ? await previousCalls(call.lead_id, call.id) : [];
  const history = prev.map((p) => ({ at: p.started_at as string | null, outcome: (p.effective_outcome ?? p.system_outcome) as string | null, status: p.status as string }));
  const note = prev.length
    ? `${prev.length} earlier call(s) from this number: ` + prev.map((p) => `${String(p.started_at).slice(0, 10)} (${p.status}${p.system_outcome ? `, ${p.system_outcome}` : ""})`).join("; ")
    : null;
  return { history, note };
}

function bookingInfo(b: Row | null): BookingInfo | null {
  return b ? { status: b.status, designer: b.designer, start_at: b.start_at, timezone: b.timezone, provider_booking_uid: b.provider_booking_uid } : null;
}

/**
 * Runs after a call ends (and again, harmlessly, on duplicate/late payloads). Every step is idempotent:
 * qualification rows dedupe on input hash, jobs/tasks on their keys, costs on (call, provider, kind).
 */
export async function finalizeCall(callId: string, ev?: NormalizedEvent): Promise<void> {
  const db = getDb();
  let call = (await db.get("calls", callId))!;
  const transcript: Turn[] = Array.isArray(call.transcript) ? call.transcript : [];

  // Pricing-policy audit: nothing the studio side said may contain a price.
  const violated = transcript.some((t) => t.speaker !== "caller" && containsPrice(t.text));
  if (violated && !call.pricing_violation) {
    call = (await db.update("calls", callId, { pricing_violation: true }))!;
    await audit({ actor: "system", actorType: "system", action: "pricing.violation_detected", entityType: "call", entityId: callId, reason: "Studio-side turn matched a price pattern" });
    await enqueue(`tg:pricing:${callId}`, "telegram_alert", { call_id: callId, reason: "pricing_violation" });
  }

  const callerTurns = transcript.filter((t) => t.speaker === "caller").length;
  const incomplete = call.status !== "completed" || callerTurns < 2;

  // Facts: Gemini (lowest priority) < payload/prior merged < live tool call (highest).
  const { history, note: historyNote } = await historyOf(call);
  let geminiFields: Partial<Fields> | null = null;
  let narrative: Narrative | null = null;
  let source: "gemini" | "deterministic_fallback" = call.summary_source === "gemini" ? "gemini" : "deterministic_fallback";
  let usage: { promptTokens: number | null; outputTokens: number | null; model: string } | null = null;

  if (geminiAvailable() && call.source !== "demo" && callerTurns > 0 && call.summary_source !== "gemini") {
    try {
      const r = await extractWithGemini({ transcript, callStartedAt: call.started_at, history });
      geminiFields = r.output.fields;
      narrative = r.output.narrative;
      usage = r.usage;
      source = "gemini";
    } catch (e) {
      await audit({ actor: "system", actorType: "system", action: "gemini.failed", entityType: "call", entityId: callId, reason: e instanceof Error ? e.message : String(e) });
      await enqueue(`summary_retry:${callId}`, "summary_retry", { call_id: callId });
    }
  }

  const fields = mergeFields(geminiFields, asFields(call.extracted), await latestLiveFields(callId));
  fields.caller_phone = fields.caller_phone ?? call.from_number;
  const evaluation = evaluate(fields, { callIncomplete: incomplete });
  await saveQualification({ call, source: "merged", fields, evaluation });
  const { effective } = await applyEvaluation(callId, fields, evaluation);

  await recordCallCosts({ callId, durationSeconds: call.duration_seconds, reported: ev?.cost ?? null, gemini: usage });

  const booking = call.lead_id ? await latestBookingForLead(call.lead_id) : null;
  const note = buildHandoffNote({
    fields, evaluation: { ...evaluation, outcome: effective }, narrative: narrative ?? deterministicNarrative(fields, historyNote),
    booking: bookingInfo(booking), source, callerPhone: call.from_number,
  });
  if (call.summary_source !== "gemini" || source === "gemini") {
    await db.update("calls", callId, { summary: note, summary_source: source, updated_at: nowIso() });
  }

  await dispatchActions(callId, call.lead_id, effective, booking);
  await runDueJobs().catch(() => undefined); // best effort now; the cron retries anything left
}

async function dispatchActions(callId: string, leadId: string | null, effective: string, booking: Row | null) {
  const hubspotAuto = env.hubspotReviewPolicy() === "auto";
  switch (effective) {
    case "URGENT_ESCALATION":
      await enqueue(`tg:escalation:${callId}`, "telegram_alert", { call_id: callId, reason: "escalation" });
      await createTask({ dedupeKey: `complaint:${callId}`, kind: "complaint_callback", leadId, callId, dueInMinutes: env.escalationSlaMinutes(), assignee: env.get("ESCALATION_OWNER_NAME") ?? "Nikhil Deshpande", notes: "Existing-client complaint; senior callback" });
      break;
    case "GREEN_QUALIFIED":
      await enqueue(`tg:handoff:${callId}`, "telegram_handoff", { call_id: callId });
      if (leadId) await enqueue(`hubspot:${leadId}`, "hubspot_sync", { lead_id: leadId });
      if (booking?.status !== "confirmed")
        await createTask({ dedupeKey: `booking_followup:${leadId}`, kind: "booking_followup", leadId, callId, dueInMinutes: env.callbackSlaMinutes(), notes: booking ? `Booking ${booking.status}: ${booking.failure_reason ?? ""}` : "Qualified but no consultation booked on the call" });
      break;
    case "AMBER_REVIEW":
      await enqueue(`tg:handoff:${callId}`, "telegram_handoff", { call_id: callId });
      await createTask({ dedupeKey: `review:${leadId}`, kind: "review", leadId, callId, notes: "Review qualification" });
      if (leadId && hubspotAuto) await enqueue(`hubspot:${leadId}`, "hubspot_sync", { lead_id: leadId });
      break;
    case "INCOMPLETE":
      await enqueue(`tg:incomplete:${callId}`, "telegram_alert", { call_id: callId, reason: "incomplete" });
      await createTask({ dedupeKey: `callback:${leadId}`, kind: "callback", leadId, callId, dueInMinutes: env.callbackSlaMinutes(), notes: "Missed/incomplete call: call back" });
      break;
    default:
      break; // RED: recorded and visible in the dashboard, nothing forwarded
  }
}

/** Re-run Gemini for the narrative only (used by the retry job). Does not change the qualification decision. */
export async function regenerateSummary(callId: string): Promise<boolean> {
  const db = getDb();
  const call = await db.get("calls", callId);
  if (!call || !Array.isArray(call.transcript)) return false;
  const { history, note } = await historyOf(call);
  const r = await extractWithGemini({ transcript: call.transcript, callStartedAt: call.started_at, history });
  const fields = mergeFields(r.output.fields, asFields(call.extracted), await latestLiveFields(callId));
  const evaluation = call.evaluation ?? evaluate(fields);
  const booking = call.lead_id ? await latestBookingForLead(call.lead_id) : null;
  const summary = buildHandoffNote({
    fields, evaluation: { ...evaluation, outcome: call.effective_outcome ?? evaluation.outcome }, narrative: r.output.narrative ?? deterministicNarrative(fields, note),
    booking: bookingInfo(booking), source: "gemini", callerPhone: call.from_number,
  });
  await db.update("calls", callId, { summary, summary_source: "gemini", updated_at: nowIso() });
  await recordCallCosts({ callId, durationSeconds: call.duration_seconds, reported: null, gemini: r.usage });
  return true;
}
