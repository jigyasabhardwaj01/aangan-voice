import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";
import { env } from "@/lib/env";
import { ProviderError } from "@/providers/http";
import { audit } from "./audit";

export type JobKind = "telegram_handoff" | "telegram_alert" | "hubspot_sync" | "summary_retry";
export type JobHandler = (payload: Row, job: Row) => Promise<string | void>;

const handlers = new Map<JobKind, JobHandler>();
export const registerJobHandler = (k: JobKind, h: JobHandler) => handlers.set(k, h);

/** Idempotent: the same key never creates a second job (and so never a second Telegram message or CRM deal). */
export async function enqueue(key: string, kind: JobKind, payload: Row): Promise<{ created: boolean }> {
  const { conflict } = await getDb().insert("jobs", {
    id: newId(), key, kind, payload, status: "pending", attempts: 0,
    next_attempt_at: nowIso(), last_error: null, provider_ref: null, created_at: nowIso(), sent_at: null,
  });
  return { created: !conflict };
}

const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000;
const STALE_PROCESSING_MS = 10 * 60_000;

/** Runs due jobs. Safe to call concurrently (compare-and-set claim) and repeatedly (retry with backoff). */
export async function runDueJobs(limit = 25): Promise<{ ran: number; sent: number; failed: number; blocked: number }> {
  const db = getDb();
  const now = Date.now();
  const candidates = (await db.find("jobs", { status: ["pending", "blocked", "processing"] }, { order: ["created_at", "asc"] }))
    .filter((j) => Date.parse(j.next_attempt_at) <= now)
    .slice(0, limit);
  const result = { ran: 0, sent: 0, failed: 0, blocked: 0 };

  for (const j of candidates) {
    const claimed = await db.cas("jobs", j.id, { status: j.status }, {
      status: "processing",
      next_attempt_at: new Date(now + STALE_PROCESSING_MS).toISOString(),
    });
    if (!claimed) continue; // another worker has it
    result.ran++;
    const handler = handlers.get(j.kind);
    try {
      if (!handler) throw new Error(`no handler for job kind ${j.kind}`);
      const ref = await handler(j.payload ?? {}, j);
      await db.update("jobs", j.id, { status: "sent", sent_at: nowIso(), provider_ref: ref ?? null, last_error: null });
      result.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ProviderError && e.kind === "not_configured") {
        // Visible, retried once config exists, and does not burn attempts.
        await db.update("jobs", j.id, { status: "blocked", last_error: msg, next_attempt_at: new Date(now + 15 * 60_000).toISOString() });
        result.blocked++;
        continue;
      }
      const attempts = (j.attempts ?? 0) + 1;
      const dead = attempts >= env.maxJobAttempts();
      await db.update("jobs", j.id, {
        status: dead ? "dead" : "pending",
        attempts,
        last_error: msg.slice(0, 500),
        next_attempt_at: new Date(now + backoffMs(attempts)).toISOString(),
      });
      if (dead) await audit({ actor: "system", actorType: "system", action: "job.dead", entityType: "job", entityId: j.id, reason: `${j.kind}: ${msg.slice(0, 200)}` });
      result.failed++;
    }
  }
  return result;
}
