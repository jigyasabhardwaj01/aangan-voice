import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { runDueJobs } from "@/domain/jobs";
import { ensureHandlers } from "@/domain/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Retries pending/blocked notification and CRM jobs. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  const secret = env.get("CRON_SECRET");
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret)))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  ensureHandlers();
  return Response.json(await runDueJobs(50));
}
