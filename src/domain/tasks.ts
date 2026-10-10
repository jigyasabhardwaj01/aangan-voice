import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";

export type TaskKind = "callback" | "booking_followup" | "review" | "complaint_callback" | "verify_booking";

/** Idempotent via dedupe_key; returns false if the task already existed. */
export async function createTask(t: {
  dedupeKey: string;
  kind: TaskKind;
  leadId: string | null;
  callId: string | null;
  dueInMinutes?: number;
  assignee?: string | null;
  notes?: string | null;
}): Promise<boolean> {
  const { conflict } = await getDb().insert("followup_tasks", {
    id: newId(),
    dedupe_key: t.dedupeKey,
    lead_id: t.leadId,
    call_id: t.callId,
    kind: t.kind,
    due_at: t.dueInMinutes !== undefined ? new Date(Date.now() + t.dueInMinutes * 60_000).toISOString() : null,
    status: "open",
    assignee: t.assignee ?? null,
    notes: t.notes ?? null,
    created_at: nowIso(),
    completed_at: null,
  });
  return !conflict;
}

export async function completeTask(id: string): Promise<Row | null> {
  return getDb().update("followup_tasks", id, { status: "done", completed_at: nowIso() });
}
