import { ingestPayload } from "@/domain/webhooks/ingest";
import { DEMO_CALLS } from "./fixtures";

/** Replays the 20 September phone calls through the real pipeline, marked source "demo". Never used in production. */
export async function seedDemo(): Promise<number> {
  for (const c of DEMO_CALLS) {
    const missed = c.endReason === "no-answer";
    const end = new Date(Date.parse(c.startedAt) + (c.durationSeconds ?? 0) * 1000).toISOString();
    const payload = {
      event_id: `demo-${c.id}-final`,
      event_type: missed ? "call.missed" : "call.ended",
      call_id: `demo-${c.id}`,
      from: c.from,
      direction: "inbound",
      started_at: new Date(c.startedAt).toISOString(),
      ended_at: end,
      duration_seconds: c.durationSeconds,
      end_reason: c.endReason,
      handled_by: missed ? undefined : "human",
      transcript: c.turns.map((t) => ({ speaker: t.speaker, text: t.text })),
      extracted: c.fields,
    };
    await ingestPayload(payload, JSON.stringify(payload), false, new Date(end), "demo");
  }
  return DEMO_CALLS.length;
}

const g = globalThis as unknown as { __aanganSeeded?: Promise<number> };
export function ensureDemoSeed() {
  g.__aanganSeeded ??= seedDemo();
  return g.__aanganSeeded;
}
