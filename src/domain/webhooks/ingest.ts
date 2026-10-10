import { createHash } from "node:crypto";
import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";
import { audit, recordIntegration } from "../audit";
import { classifyEnd, upsertCall } from "../calls";
import { finalizeCall } from "../finalize";
import { ensureHandlers } from "../notifications";
import { verifyVaaniSignature } from "./signature";
import { normalizeVaani, type NormalizedEvent } from "./vaani-adapter";

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

const IN_FLIGHT_MS = 2 * 60_000;

async function logRejected(eventId: string, type: string | null, reason: string, sigValid: boolean | null, payload: unknown) {
  await getDb().insert("webhook_events", {
    id: newId(), provider: "vaani", event_id: eventId, event_type: type, status: "rejected", signature_valid: sigValid,
    payload: sigValid === false ? null : payload, error: reason, attempts: 1, received_at: nowIso(), processed_at: nowIso(),
  });
  await recordIntegration("vaani", false, "webhook", reason);
}

async function process(ev: NormalizedEvent, receivedAt: Date, source: "vaani" | "demo") {
  const call = await upsertCall(ev, receivedAt, source);
  if (ev.kind === "call_started") return;
  // Never let a final-state call regress; only terminal events move status forward.
  const turns = Array.isArray(call.transcript) ? call.transcript.length : 0;
  const status = classifyEnd(ev, turns);
  const patch: Row = { status, updated_at: nowIso() };
  // Nobody picked up: do not label an unanswered call as AI-handled just because Vaani received it.
  if (status === "missed" && call.handling_mode_source === "inferred") patch.handling_mode = "none";
  await getDb().update("calls", call.id, patch);
  await finalizeCall(call.id, ev);
}

/**
 * Idempotent Vaani webhook handler: verify → normalise → claim event id → process.
 * Retries and duplicate deliveries return 200 without repeating any action.
 */
export async function ingestVaani(rawBody: string, headers: Headers, receivedAt = new Date()): Promise<IngestResult> {
  ensureHandlers();
  const db = getDb();

  const sig = verifyVaaniSignature(rawBody, headers);
  if (!sig.ok) {
    await logRejected("rejected:" + createHash("sha256").update(rawBody + receivedAt.getTime()).digest("hex").slice(0, 24), null, sig.reason, false, null);
    return { status: sig.status, body: { error: sig.reason } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    await logRejected("rejected:" + createHash("sha256").update(rawBody).digest("hex").slice(0, 24), null, "invalid JSON", true, rawBody.slice(0, 500));
    return { status: 400, body: { error: "invalid JSON" } };
  }
  return ingestPayload(parsed, rawBody, sig.signed, receivedAt);
}

/** Everything after authentication. Also used by demo seeding (source "demo"), which has no signature to check. */
export async function ingestPayload(parsed: unknown, rawBody: string, signed: boolean, receivedAt = new Date(), source: "vaani" | "demo" = "vaani"): Promise<IngestResult> {
  ensureHandlers();
  const db = getDb();
  const norm = normalizeVaani(parsed, rawBody);
  if (!norm.ok) {
    await logRejected("rejected:" + createHash("sha256").update(rawBody).digest("hex").slice(0, 24), null, norm.reason, true, parsed);
    return { status: 422, body: { error: norm.reason } };
  }
  const ev = norm.event;

  const claim = await db.insert("webhook_events", {
    id: newId(), provider: "vaani", event_id: ev.eventId, event_type: ev.kind, status: "processing", signature_valid: signed ? true : null,
    payload: parsed, error: null, attempts: 1, received_at: receivedAt.toISOString(), processed_at: null,
  });

  let eventRow: Row | null = claim.row;
  if (claim.conflict) {
    const [existing] = await db.find("webhook_events", { provider: "vaani", event_id: ev.eventId });
    if (!existing) return { status: 500, body: { error: "event claim race" } };
    if (existing.status === "processed") return { status: 200, body: { duplicate: true } };
    const inFlight = existing.status === "processing" && Date.now() - Date.parse(existing.received_at) < IN_FLIGHT_MS;
    if (inFlight) return { status: 200, body: { duplicate: true, in_flight: true } };
    // failed or stale processing: take it over atomically for a safe retry
    eventRow = await db.cas("webhook_events", existing.id, { status: existing.status }, {
      status: "processing", attempts: (existing.attempts ?? 0) + 1, received_at: receivedAt.toISOString(), error: null,
    });
    if (!eventRow) return { status: 200, body: { duplicate: true, in_flight: true } };
  }

  try {
    await process(ev, receivedAt, source);
    await db.update("webhook_events", eventRow!.id, { status: "processed", processed_at: nowIso(), error: null });
    await recordIntegration("vaani", true, "webhook", ev.kind);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update("webhook_events", eventRow!.id, { status: "failed", error: msg.slice(0, 500) });
    await recordIntegration("vaani", false, "webhook", msg);
    await audit({ actor: "system", actorType: "system", action: "webhook.failed", entityType: "webhook_event", entityId: eventRow!.id, reason: msg.slice(0, 300) });
    // 500 makes Vaani retry; the failed row above is re-claimed on the retry.
    return { status: 500, body: { error: "processing failed; safe to retry" } };
  }
}
