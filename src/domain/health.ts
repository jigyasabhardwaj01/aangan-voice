import { getDb } from "@/db";
import { env, isConfigured, missingConfig, REQUIRED, type Integration } from "@/lib/env";

export interface IntegrationHealth {
  id: Integration;
  label: string;
  configured: boolean;
  missing: string[];
  status: "ok" | "degraded" | "not_configured" | "no_data";
  lastSuccess: string | null;
  lastFailure: string | null;
  lastFailureDetail: string | null;
  failures24h: number;
}

const LABELS: Record<Integration, string> = {
  vaani: "Vaani Labs (voice)", supabase: "Supabase (database)", calcom: "Cal.com (calendar)", gemini: "Gemini Flash (summaries)",
  hubspot: "HubSpot (CRM)", telegram: "Telegram (alerts)", dashboard: "Dashboard auth",
};

export async function integrationHealth(now = new Date()) {
  const db = getDb();
  const events = await db.find("integration_events", {}, { order: ["at", "desc"], limit: 2000 });
  const jobs = await db.find("jobs", {});
  const hooks = await db.find("webhook_events", {}, { order: ["received_at", "desc"], limit: 500 });
  const dayAgo = now.getTime() - 86_400_000;

  const rows: IntegrationHealth[] = (Object.keys(REQUIRED) as Integration[]).map((id) => {
    const mine = events.filter((e) => e.provider === id);
    const ok = mine.find((e) => e.ok);
    const bad = mine.find((e) => !e.ok);
    const configured = id === "supabase" ? getDb().kind === "supabase" : isConfigured(id);
    const failures24h = mine.filter((e) => !e.ok && Date.parse(e.at) > dayAgo).length;
    const lastIsFailure = mine[0] ? !mine[0].ok : false;
    return {
      id, label: LABELS[id], configured, missing: missingConfig(id),
      status: !configured ? "not_configured" : !mine.length && id !== "supabase" && id !== "dashboard" ? "no_data" : lastIsFailure ? "degraded" : "ok",
      lastSuccess: ok?.at ?? null, lastFailure: bad?.at ?? null, lastFailureDetail: bad?.detail ?? null, failures24h,
    };
  });

  return {
    integrations: rows,
    storage: getDb().kind,
    demoMode: env.demoMode(),
    webhook: {
      processed: hooks.filter((h) => h.status === "processed").length,
      failed: hooks.filter((h) => h.status === "failed").length,
      rejected: hooks.filter((h) => h.status === "rejected").length,
      recentProblems: hooks.filter((h) => h.status === "failed" || h.status === "rejected").slice(0, 10),
      unsignedAllowed: env.allowUnsignedWebhooks(),
    },
    jobs: {
      pending: jobs.filter((j) => j.status === "pending").length,
      blocked: jobs.filter((j) => j.status === "blocked").length,
      dead: jobs.filter((j) => j.status === "dead").length,
      sent: jobs.filter((j) => j.status === "sent").length,
      problems: jobs.filter((j) => ["blocked", "dead"].includes(j.status) || (j.status === "pending" && j.attempts > 0)).slice(0, 20),
    },
  };
}
