import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Vaani Labs payload adapter.
 *
 * ASSUMPTION: Vaani's public webhook schema could not be verified when this was built. This adapter accepts the
 * shape below (plus a few common aliases) and rejects anything else visibly (stored as a `rejected` webhook event,
 * shown on the Integration health page). After capturing a real payload from a test call, adjust ONLY this file.
 *
 *   { event_id, event_type|type, call_id|callId, from, to, direction, started_at, answered_at, ended_at,
 *     duration_seconds, end_reason, handled_by: "ai"|"human",
 *     transcript: [{ speaker: "agent"|"caller"|"human", text, at? }] | "Agent: ...\nCaller: ...",
 *     extracted: {...Fields}, cost: { amount, currency } }
 */

export type EventKind = "call_started" | "call_final" | "call_missed" | "call_failed";

export interface Turn {
  speaker: "agent" | "caller" | "human";
  text: string;
  at?: string;
}

export interface NormalizedEvent {
  eventId: string;
  kind: EventKind;
  providerCallId: string;
  from: string | null;
  to: string | null;
  direction: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  endReason: string | null;
  handledBy: "ai" | "human" | null;
  transcript: Turn[] | null;
  extracted: unknown | null;
  cost: { amount: number; currency: string } | null;
}

const KIND_MAP: Record<string, EventKind> = {
  "call.started": "call_started", call_started: "call_started", "call-started": "call_started", call_start: "call_started",
  "call.ended": "call_final", call_ended: "call_final", "call.completed": "call_final", call_completed: "call_final",
  "call.final": "call_final", call_final: "call_final", "call.final_payload": "call_final", "end-of-call-report": "call_final",
  "call.missed": "call_missed", call_missed: "call_missed",
  "call.failed": "call_failed", call_failed: "call_failed",
};

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

const TurnSchema = z.object({
  speaker: z.enum(["agent", "caller", "human"]),
  text: z.string().max(5000),
  at: z.string().optional(),
});

function parseTranscript(raw: unknown): Turn[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const turns: Turn[] = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(agent|ai|assistant|caller|customer|user|human|front desk)\s*:\s*(.*)$/i);
      if (m) {
        const s = m[1].toLowerCase();
        turns.push({ speaker: ["caller", "customer", "user"].includes(s) ? "caller" : s === "human" || s === "front desk" ? "human" : "agent", text: m[2].slice(0, 5000) });
      } else if (turns.length && line.trim()) turns[turns.length - 1].text += " " + line.trim();
    }
    return turns;
  }
  if (Array.isArray(raw)) {
    const out: Turn[] = [];
    for (const t of raw) {
      const o = t as Record<string, unknown>;
      const sp = String(o.speaker ?? o.role ?? "").toLowerCase();
      const speaker = ["caller", "customer", "user"].includes(sp) ? "caller" : sp === "human" ? "human" : ["agent", "ai", "assistant", "bot"].includes(sp) ? "agent" : null;
      const text = typeof (o.text ?? o.content) === "string" ? String(o.text ?? o.content) : null;
      if (!speaker || text === null) continue;
      const parsed = TurnSchema.safeParse({ speaker, text, at: typeof o.at === "string" ? o.at : undefined });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }
  return null;
}

export function eventIdFor(raw: Record<string, unknown>, rawBody: string): string {
  const id = raw.event_id ?? raw.eventId ?? raw.id;
  if (typeof id === "string" && id) return id;
  // No provider event id: identical retries share the body hash and therefore dedupe.
  return "sha256:" + createHash("sha256").update(rawBody).digest("hex");
}

/**
 * Events Vaani Labs documents that we deliberately do not act on. They must be acknowledged with 2xx:
 * Vaani retries non-2xx up to 8 times and AUTO-DISABLES the webhook after 5 consecutive failures.
 */
const IGNORED_TYPES = new Set(["lead.created", "usage.charged", "low_balance.warned", "meeting.ended", "webhook.ping"]);

export type NormalizeResult = { ok: true; event: NormalizedEvent } | { ok: false; reason: string; ignore?: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function normalizeVaani(raw: unknown, rawBody: string): NormalizeResult {
  if (!isObj(raw)) return { ok: false, reason: "payload is not an object" };
  // Vaani Labs envelope: { id: "evt_…", type, created, data: {…} }. Event-specific fields live in `data`;
  // flat payloads (no `data`) are still accepted.
  const data = isObj(raw.data) ? raw.data : null;
  const r: Record<string, unknown> = data ? { ...data, event_type: raw.type ?? raw.event_type, event_id: raw.id ?? raw.event_id } : raw;
  const type = String(raw.type ?? raw.event_type ?? raw.event ?? "").toLowerCase();
  if (IGNORED_TYPES.has(type)) return { ok: false, reason: `ignored event type "${type}"`, ignore: true };
  const kind = KIND_MAP[type];
  if (!kind) return { ok: false, reason: `unrecognised event type "${type}"` };
  const callId = strOrNull(r.call_id ?? r.callId ?? r.id_call ?? (isObj(r.call) ? r.call.id : undefined) ?? (data ? data.id : undefined));
  if (!callId) return { ok: false, reason: "missing call_id" };

  const cost = r.cost as { amount?: unknown; currency?: unknown } | undefined;
  const handled = String(r.handled_by ?? r.handledBy ?? "").toLowerCase();
  return {
    ok: true,
    event: {
      eventId: eventIdFor(r, rawBody),
      kind,
      providerCallId: callId,
      from: strOrNull(r.from ?? r.caller_number),
      to: strOrNull(r.to ?? r.called_number),
      direction: strOrNull(r.direction),
      startedAt: isoOrNull(r.started_at ?? r.startedAt ?? r.start_time),
      answeredAt: isoOrNull(r.answered_at ?? r.answeredAt),
      endedAt: isoOrNull(r.ended_at ?? r.endedAt ?? r.end_time),
      durationSeconds: numOrNull(r.duration_seconds ?? r.durationSeconds ?? r.duration),
      endReason: strOrNull(r.end_reason ?? r.endReason ?? r.disconnection_reason),
      handledBy: handled === "ai" || handled === "human" ? handled : null,
      transcript: parseTranscript(r.transcript),
      extracted: r.extracted ?? null,
      cost: cost && typeof cost.amount === "number" && cost.amount >= 0 ? { amount: cost.amount, currency: typeof cost.currency === "string" ? cost.currency : "USD" } : null,
    },
  };
}
