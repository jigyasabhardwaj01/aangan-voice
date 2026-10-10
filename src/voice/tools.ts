import { z } from "zod";
import { getDb } from "@/db";
import { nowIso, type Row } from "@/db/adapter";
import { env } from "@/lib/env";
import { upsertCall } from "@/domain/calls";
import { bookSlot, offerSlots } from "@/domain/booking";
import { assertNoPriceDeep } from "@/domain/pricing-guard";
import { closingLine, evaluate, nextQuestion } from "@/domain/qualification/rules";
import { FieldsSchema } from "@/domain/qualification/schema";
import { latestLiveFields, mergeFields, saveQualification } from "@/domain/qualification/service";
import { ensureHandlers } from "@/domain/notifications";
import { normalizePhone } from "@/domain/leads";
import { activeBookingForLead } from "@/domain/booking";
import { containsPrice } from "@/domain/pricing-guard";
import { formatLocal } from "@/lib/time";
import type { NormalizedEvent } from "@/domain/webhooks/vaani-adapter";

/**
 * Caller-facing tool endpoints used by the live Vaani agent. Everything returned here may be spoken to the caller,
 * so every response is passed through assertNoPriceDeep. This module must never import internal pricing guidance.
 */

export const QualifyBody = z.object({ call_id: z.string().min(1).max(200), fields: z.record(z.string(), z.unknown()).default({}) });
export const LookupBody = z.object({ call_id: z.string().max(200).nullish(), phone: z.string().max(40).nullish() });
export const AvailabilityBody = z.object({ call_id: z.string().min(1).max(200) });
export const BookBody = z.object({
  call_id: z.string().min(1).max(200),
  slot_id: z.string().min(1).max(100),
  confirmed: z.boolean(),
  email: z.string().email().max(200).nullable().optional(),
  name: z.string().max(200).nullable().optional(),
});

async function callFor(providerCallId: string): Promise<Row> {
  ensureHandlers();
  const [existing] = await getDb().find("calls", { provider_call_id: providerCallId });
  if (existing) return existing;
  // Tool call can arrive before the call-start webhook: create the call row now; the webhook merges into it later.
  const ev: NormalizedEvent = {
    eventId: "tool", kind: "call_started", providerCallId, from: null, to: null, direction: "inbound", startedAt: nowIso(),
    answeredAt: null, endedAt: null, durationSeconds: null, endReason: null, handledBy: "ai", transcript: null, extracted: null, cost: null,
  };
  return upsertCall(ev);
}

export type Decision = "ask_question" | "proceed_to_booking" | "close_gracefully" | "human_callback" | "escalate_urgent";

export async function qualifyTool(body: z.infer<typeof QualifyBody>) {
  const db = getDb();
  const call = await callFor(body.call_id);
  const incoming = FieldsSchema.partial().safeParse(body.fields);
  if (!incoming.success) throw new Error("invalid fields: " + incoming.error.issues[0]?.message);

  const fields = mergeFields(await latestLiveFields(call.id), incoming.data);
  const evaluation = evaluate(fields, { callIncomplete: false });
  await saveQualification({ call, source: "live_tool", fields, evaluation });

  // Provisional decision on the call so booking eligibility is server-enforced. Lead review state is set only at call end.
  const override = (await db.find("overrides", { call_id: call.id }, { order: ["created_at", "desc"], limit: 1 }))[0];
  const effective = override?.to_outcome ?? evaluation.outcome;
  await db.update("calls", call.id, { system_outcome: evaluation.outcome, effective_outcome: effective, evaluation, extracted: fields, updated_at: nowIso() });

  let res: { decision: Decision; say?: string; ask?: { criterion: number; question: string }; can_book: boolean };
  const asked: number[] = call.asked_criteria ?? [];
  switch (evaluation.outcome) {
    case "URGENT_ESCALATION":
      res = { decision: "escalate_urgent", can_book: false, say: "I'm so sorry about that. I'm passing this to our senior team right now, and someone senior will call you back." };
      break;
    case "RED_NOT_QUALIFIED":
      res = { decision: "close_gracefully", can_book: false, say: closingLine(evaluation) };
      break;
    case "GREEN_QUALIFIED":
      res = { decision: "proceed_to_booking", can_book: true };
      break;
    default: {
      const q = nextQuestion(evaluation, asked);
      if (q) {
        await db.update("calls", call.id, { asked_criteria: [...asked, q.criterion] });
        res = { decision: "ask_question", can_book: false, ask: { criterion: q.criterion, question: q.question } };
      } else {
        res = { decision: "human_callback", can_book: false, say: `Thank you — I'll have a designer from our team call you ${env.callbackPromiseText()} to take this forward.` };
      }
    }
  }
  assertNoPriceDeep(res, "qualify tool response");
  return res;
}

export async function availabilityTool(body: z.infer<typeof AvailabilityBody>) {
  const call = await callFor(body.call_id);
  const r = await offerSlots(call);
  const res = r.ok
    ? { available: true as const, slots: r.slots.map((s) => ({ slot_id: s.slot_id, label: s.label })) }
    : { available: false as const, reason: r.reason, say: r.say };
  assertNoPriceDeep(res, "availability tool response");
  return res;
}

export async function bookTool(body: z.infer<typeof BookBody>) {
  const call = await callFor(body.call_id);
  const r = await bookSlot(call, { slotId: body.slot_id, confirmed: body.confirmed, email: body.email ?? null, name: body.name ?? null });
  // Only expose status + the sentence to say. "confirmed" is only ever returned after Cal.com confirmed the event.
  const res = { status: r.status, say: r.say };
  assertNoPriceDeep(res, "book tool response");
  return res;
}

const REMEMBER = ["scope_summary", "property_use", "commercial_kind", "engagement", "ownership", "city", "locality", "carpet_area_sqft", "site_readiness", "timeline_text", "decision_maker"] as const;
const todayIst = () => new Intl.DateTimeFormat("en-IN", { timeZone: env.timezone(), weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

/**
 * Called at the START of a call so repeat callers are recognised and not asked the same questions twice.
 * Privacy: a caller ID can be spoofed, so only non-contact project facts are returned (never phone, email, budget or earlier concerns),
 * the agent is told to confirm rather than recite, and strings that look like prices are dropped. Also returns today's date,
 * because the agent has no clock to turn "by March" into deadline_weeks.
 */
export async function lookupTool(body: z.infer<typeof LookupBody>) {
  const db = getDb();
  const today = todayIst();
  const phone = normalizePhone(body.phone);
  const [lead] = phone ? await db.find("leads", { phone_e164: phone }) : [];
  const fresh = lead && Date.now() - Date.parse(lead.updated_at) < 60 * 86_400_000;
  if (!lead || !fresh) {
    const res = { known: false as const, today };
    assertNoPriceDeep(res, "lookup tool response");
    return res;
  }
  const call = lead.last_call_id ? await db.get("calls", lead.last_call_id) : null;
  if (lead.effective_outcome === "URGENT_ESCALATION") {
    const res = {
      known: true as const, today, existing_client_open_issue: true,
      instruction: "This number recently reported a problem with an ongoing project. Do not treat it as a new enquiry. Ask gently whether they are calling about that, and if so follow the existing-client complaint steps. Do not discuss details.",
    };
    assertNoPriceDeep(res, "lookup tool response");
    return res;
  }
  const already: Record<string, unknown> = {};
  for (const k of REMEMBER) {
    const v = call?.extracted?.[k];
    if (v === null || v === undefined || v === "unknown" || v === "") continue;
    if (typeof v === "string" && containsPrice(v)) continue;
    already[k] = v;
  }
  const b = await activeBookingForLead(lead.id);
  const booking = b && b.start_at ? { status: b.status, when: formatLocal(b.start_at, b.timezone ?? undefined), designer: b.designer ?? null } : null;
  const first = typeof lead.name === "string" ? lead.name.split(" ")[0] : null;
  const res = {
    known: true as const, today, first_name: first, booking, already_collected: already,
    instruction: "Greet them by first name and say welcome back. Do not re-ask anything in already_collected: confirm it briefly and ask only what is missing. Never read out phone numbers or email addresses. If they have a booking, confirm the time.",
  };
  assertNoPriceDeep(res, "lookup tool response");
  return res;
}
