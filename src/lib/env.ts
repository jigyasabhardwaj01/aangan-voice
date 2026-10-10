/** Central, typed access to configuration. Secrets stay server-side; never import this from client components. */

export type Integration = "vaani" | "supabase" | "calcom" | "gemini" | "hubspot" | "telegram" | "dashboard";

const get = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

export const env = {
  get,
  appBaseUrl: () => get("APP_BASE_URL") ?? "http://localhost:3000",
  timezone: () => get("STUDIO_TIMEZONE") ?? "Asia/Kolkata",
  humanHoursStart: () => Number(get("HUMAN_HOURS_START") ?? 10),
  humanHoursEnd: () => Number(get("HUMAN_HOURS_END") ?? 19),
  /** 0=Sun … 6=Sat. Source says "10am to 7pm" without naming days; default Mon–Sat and flag it. */
  humanDays: () =>
    (get("HUMAN_DAYS") ?? "1,2,3,4,5,6").split(",").map((d) => Number(d.trim())).filter((n) => !Number.isNaN(n)),
  responseTargetSeconds: () => Number(get("RESPONSE_TARGET_SECONDS") ?? 300),
  callbackPromiseText: () => get("CALLBACK_PROMISE_TEXT") ?? "within the hour",
  callbackSlaMinutes: () => Number(get("CALLBACK_SLA_MINUTES") ?? 60),
  escalationSlaMinutes: () => Number(get("ESCALATION_SLA_MINUTES") ?? 15),
  /** require_approval (default): AMBER leads reach HubSpot only after designer approval. auto: sync AMBER too. */
  hubspotReviewPolicy: () => (get("HUBSPOT_REVIEW_POLICY") === "auto" ? "auto" : "require_approval"),
  allowUnsignedWebhooks: () => get("ALLOW_UNSIGNED_WEBHOOKS") === "true",
  /** One-designer mode: every task and handoff is assigned to this designer (name). Unset = shared "designer on duty". */
  pinnedDesigner: () => get("ASSIGN_ALL_TO_DESIGNER"),
  reviewSlaHours: () => Number(get("REVIEW_SLA_HOURS") ?? 24),
  demoMode: () => get("DEMO_MODE") === "true",
  maxJobAttempts: () => Number(get("MAX_JOB_ATTEMPTS") ?? 6),
};

/** Variables each integration needs. Used for health display and to refuse to pretend. */
export const REQUIRED: Record<Integration, { key: string; note?: string }[]> = {
  vaani: [{ key: "VAANI_WEBHOOK_SECRET" }, { key: "VOICE_TOOL_SECRET", note: "shared secret Vaani sends to /api/voice/tools/*" }],
  supabase: [{ key: "SUPABASE_URL" }, { key: "SUPABASE_SERVICE_ROLE_KEY" }],
  calcom: [{ key: "CAL_API_KEY" }, { key: "CAL_EVENT_TYPE_ID" }],
  gemini: [{ key: "GEMINI_API_KEY" }],
  hubspot: [{ key: "HUBSPOT_ACCESS_TOKEN" }, { key: "HUBSPOT_PIPELINE_ID" }, { key: "HUBSPOT_DEAL_STAGE_ID" }],
  telegram: [
    { key: "TELEGRAM_BOT_TOKEN" },
    { key: "TELEGRAM_DESIGNER_CHAT_ID" },
    { key: "TELEGRAM_ESCALATION_CHAT_ID", note: "designated human owner for complaints" },
  ],
  dashboard: [{ key: "SESSION_SECRET" }, { key: "DASHBOARD_USERS" }],
};

export function missingConfig(i: Integration): string[] {
  return REQUIRED[i].filter((r) => !get(r.key)).map((r) => r.key);
}
export const isConfigured = (i: Integration) => missingConfig(i).length === 0;
