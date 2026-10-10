import { getDb } from "@/db";
import { enqueue } from "./jobs";

const NUDGE_WINDOW_MS = 12 * 3_600_000;

/**
 * Keeps the promises made on the phone: every open follow-up task that is past its due time nudges the designer
 * (and the owner) on Telegram — at most once per 12-hour window per task (the job key carries the window), so
 * hourly sweeps and retries never spam. Closed tasks are skipped at send time.
 */
export async function runSweep(now = new Date()): Promise<{ overdueTasks: number; nudgesQueued: number }> {
  const open = await getDb().find("followup_tasks", { status: "open" });
  const overdue = open.filter((t) => t.due_at && Date.parse(t.due_at) < now.getTime());
  const bucket = Math.floor(now.getTime() / NUDGE_WINDOW_MS);
  let queued = 0;
  for (const t of overdue) {
    for (const target of ["designer", "owner"] as const) {
      const { created } = await enqueue(`tg:overdue:${t.id}:${bucket}:${target}`, "telegram_overdue", { task_id: t.id, target });
      if (created) queued++;
    }
  }
  return { overdueTasks: overdue.length, nudgesQueued: queued };
}
