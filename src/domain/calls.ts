import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";
import { decideRoute } from "./routing";
import { isAfterHours } from "@/lib/time";
import { findOrCreateLead } from "./leads";
import type { NormalizedEvent } from "./webhooks/vaani-adapter";

export type CallStatus = "in_progress" | "completed" | "missed" | "disconnected" | "failed";

/** Classify how the call ended. Conservative: only clear signals make a call "missed"/"failed". */
export function classifyEnd(ev: NormalizedEvent, transcriptTurns: number): CallStatus {
  if (ev.kind === "call_missed") return "missed";
  if (ev.kind === "call_failed") return "failed";
  const reason = (ev.endReason ?? "").toLowerCase();
  if (/no[-_ ]?answer|missed|unanswered|busy|voicemail/.test(reason)) return "missed";
  if (/fail|error|timeout/.test(reason)) return "failed";
  if (/disconnect|drop|dropped|hung[-_ ]?up[-_ ]?early|network|abandon/.test(reason)) return "disconnected";
  if (!ev.answeredAt && (ev.durationSeconds ?? 0) === 0 && transcriptTurns === 0) return "missed";
  return "completed";
}

/** Create/update the call row from an event. Idempotent; never regresses a finished call to in_progress. */
export async function upsertCall(ev: NormalizedEvent, receivedAt = new Date(), source: "vaani" | "demo" = "vaani"): Promise<Row> {
  const db = getDb();
  let [call] = await db.find("calls", { provider_call_id: ev.providerCallId });
  const started = ev.startedAt ?? call?.started_at ?? receivedAt.toISOString();
  const startedDate = new Date(started);

  if (!call) {
    const lead = await findOrCreateLead(ev.from);
    const row = {
      id: newId(),
      provider_call_id: ev.providerCallId,
      lead_id: lead.id,
      source,
      direction: ev.direction ?? "inbound",
      from_number: ev.from,
      to_number: ev.to,
      started_at: started,
      answered_at: null,
      ended_at: null,
      duration_seconds: null,
      handling_mode: ev.handledBy ?? "ai",
      handling_mode_source: ev.handledBy ? "reported" : "inferred",
      expected_route: decideRoute(startedDate),
      after_hours: isAfterHours(startedDate),
      status: "in_progress",
      end_reason: null,
      transcript: null,
      first_response_at: null,
      response_seconds: null,
      response_basis: "none",
      system_outcome: null,
      effective_outcome: null,
      extracted: null,
      evaluation: null,
      summary: null,
      summary_source: null,
      asked_criteria: [],
      pricing_violation: false,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const ins = await db.insert("calls", row);
    if (ins.row) call = ins.row;
    else [call] = await db.find("calls", { provider_call_id: ev.providerCallId });
    if (!call) throw new Error("call upsert failed");
  }

  const patch: Row = { updated_at: nowIso() };
  const set = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) patch[k] = v;
  };
  set("started_at", ev.startedAt);
  set("answered_at", ev.answeredAt);
  set("ended_at", ev.endedAt);
  set("duration_seconds", ev.durationSeconds);
  set("end_reason", ev.endReason);
  set("from_number", ev.from);
  set("to_number", ev.to);
  if (ev.handledBy) {
    patch.handling_mode = ev.handledBy;
    patch.handling_mode_source = "reported";
  }
  if (ev.transcript && ev.transcript.length) patch.transcript = ev.transcript;
  if (ev.extracted && typeof ev.extracted === "object") patch.extracted = ev.extracted;

  const answered = (ev.answeredAt ?? call.answered_at) as string | null;
  const start = (ev.startedAt ?? call.started_at) as string | null;
  if (answered && start && !call.first_response_at) {
    patch.first_response_at = answered;
    patch.response_seconds = Math.max(0, Math.round((Date.parse(answered) - Date.parse(start)) / 1000));
    patch.response_basis = "answered";
  }
  const updated = await db.update("calls", call.id, patch);
  return updated ?? call;
}

/** Record a human callback to a missed/incomplete call, which defines response time for those calls. */
export async function markCallbackDone(callId: string, at = new Date()): Promise<Row | null> {
  const db = getDb();
  const call = await db.get("calls", callId);
  if (!call) return null;
  if (call.first_response_at) return call;
  return db.update("calls", callId, {
    first_response_at: at.toISOString(),
    response_seconds: Math.max(0, Math.round((at.getTime() - Date.parse(call.started_at)) / 1000)),
    response_basis: "callback",
    updated_at: nowIso(),
  });
}
