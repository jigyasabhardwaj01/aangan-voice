import { getDb } from "@/db";
import { newId, nowIso } from "@/db/adapter";

export interface AuditInput {
  actor: string;
  actorType: "user" | "system" | "provider";
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Append-only audit trail for classification changes, bookings and manual actions. */
export async function audit(a: AuditInput): Promise<void> {
  await getDb().insert("audit_logs", {
    id: newId(),
    at: nowIso(),
    actor: a.actor,
    actor_type: a.actorType,
    action: a.action,
    entity_type: a.entityType,
    entity_id: a.entityId ?? null,
    before: a.before ?? null,
    after: a.after ?? null,
    reason: a.reason ?? null,
  });
}

export type Provider = "vaani" | "calcom" | "gemini" | "hubspot" | "telegram" | "supabase";

/** Every provider call outcome is recorded so the dashboard can show last success / failures honestly. */
export async function recordIntegration(provider: Provider, ok: boolean, operation: string, detail?: string) {
  try {
    await getDb().insert("integration_events", {
      id: newId(),
      provider,
      ok,
      operation,
      detail: detail ? detail.slice(0, 500) : null,
      at: nowIso(),
    });
  } catch {
    /* never let health logging break the primary flow */
  }
}
