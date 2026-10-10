import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";
import { env } from "@/lib/env";

export type CostBasis = "measured" | "estimated" | "unknown";
const RANK: Record<CostBasis, number> = { unknown: 0, estimated: 1, measured: 2 };

/**
 * Records one cost line. An absent figure is stored as amount NULL with basis "unknown" — never 0.
 * A better basis (measured > estimated > unknown) replaces a worse one; otherwise the existing line is kept.
 */
export async function recordCost(c: {
  callId: string;
  provider: string;
  kind: string;
  amount: number | null;
  currency: string | null;
  basis: CostBasis;
  units?: Row;
}) {
  const db = getDb();
  const row = {
    id: newId(), call_id: c.callId, provider: c.provider, kind: c.kind,
    amount: c.basis === "unknown" ? null : c.amount, currency: c.basis === "unknown" ? null : c.currency,
    basis: c.basis, units: c.units ?? null, created_at: nowIso(),
  };
  const { conflict } = await db.insert("cost_events", row);
  if (!conflict) return;
  const [existing] = await db.find("cost_events", { call_id: c.callId, provider: c.provider, kind: c.kind });
  if (existing && RANK[c.basis] > RANK[existing.basis as CostBasis]) {
    await db.update("cost_events", existing.id, { amount: row.amount, currency: row.currency, basis: c.basis, units: row.units });
  }
}

export async function recordCallCosts(a: {
  callId: string;
  durationSeconds: number | null;
  reported: { amount: number; currency: string } | null;
  gemini?: { promptTokens: number | null; outputTokens: number | null; model: string } | null;
}) {
  // Vaani: measured if the provider reported it; estimated from a configured per-minute rate; else unknown.
  const perMin = Number(env.get("VAANI_COST_PER_MIN") ?? NaN);
  if (a.reported) {
    await recordCost({ callId: a.callId, provider: "vaani", kind: "voice_minutes", amount: a.reported.amount, currency: a.reported.currency, basis: "measured", units: { seconds: a.durationSeconds } });
  } else if (Number.isFinite(perMin) && a.durationSeconds !== null) {
    await recordCost({ callId: a.callId, provider: "vaani", kind: "voice_minutes", amount: (a.durationSeconds / 60) * perMin, currency: env.get("VAANI_COST_CURRENCY") ?? "INR", basis: "estimated", units: { seconds: a.durationSeconds, rate_per_min: perMin } });
  } else {
    await recordCost({ callId: a.callId, provider: "vaani", kind: "voice_minutes", amount: null, currency: null, basis: "unknown", units: { seconds: a.durationSeconds } });
  }

  if (a.gemini) {
    const inRate = Number(env.get("GEMINI_INPUT_RATE_PER_M") ?? NaN);
    const outRate = Number(env.get("GEMINI_OUTPUT_RATE_PER_M") ?? NaN);
    const tokens = { prompt_tokens: a.gemini.promptTokens, output_tokens: a.gemini.outputTokens, model: a.gemini.model };
    if (Number.isFinite(inRate) && Number.isFinite(outRate) && a.gemini.promptTokens !== null && a.gemini.outputTokens !== null) {
      await recordCost({
        callId: a.callId, provider: "gemini", kind: "tokens",
        amount: (a.gemini.promptTokens / 1e6) * inRate + (a.gemini.outputTokens / 1e6) * outRate,
        currency: env.get("GEMINI_RATE_CURRENCY") ?? "USD", basis: "estimated", units: tokens,
      });
    } else {
      await recordCost({ callId: a.callId, provider: "gemini", kind: "tokens", amount: null, currency: null, basis: "unknown", units: tokens });
    }
  }
}
