import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { runDueJobs } from "@/domain/jobs";
import { ensureHandlers } from "@/domain/notifications";
import { runSweep } from "@/domain/sweep";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sweep + retry. Call hourly from an external cron (cron-job.org with `Authorization: Bearer $CRON_SECRET`);
 * vercel.json adds a daily fallback because Vercel Hobby only allows daily crons.
 * 1) queue nudges for overdue follow-ups, 2) send/retry every due notification and CRM job.
 */
export async function GET(req: Request) {
  const secret = env.get("CRON_SECRET");
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret)))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  ensureHandlers();
  const sweep = await runSweep();
  const jobs = await runDueJobs(50);
  return Response.json({ sweep, jobs });
}
