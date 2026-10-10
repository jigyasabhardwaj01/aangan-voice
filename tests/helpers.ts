import { afterEach, beforeEach, vi } from "vitest";
import { freshMemoryDb, getDb, setDb } from "@/db";
import { sign } from "@/domain/webhooks/signature";

const MANAGED = [
  "VAANI_WEBHOOK_SECRET", "VOICE_TOOL_SECRET", "CAL_API_KEY", "CAL_EVENT_TYPE_ID", "CAL_REQUIRE_EMAIL", "GEMINI_API_KEY",
  "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEAL_STAGE_ID", "TELEGRAM_BOT_TOKEN", "TELEGRAM_DESIGNER_CHAT_ID",
  "TELEGRAM_ESCALATION_CHAT_ID", "ALLOW_UNSIGNED_WEBHOOKS", "HUBSPOT_REVIEW_POLICY", "VAANI_COST_PER_MIN", "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY", "MAX_JOB_ATTEMPTS", "CAL_MIN_NOTICE_HOURS",
];

export function useCleanEnv(extra: Record<string, string> = {}) {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of MANAGED) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, { ALLOW_UNSIGNED_WEBHOOKS: "true", ...extra });
    setDb(freshMemoryDb());
  });
  afterEach(() => {
    for (const k of MANAGED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
    setDb(null);
  });
}

export const db = () => getDb();

export function vaaniEvent(over: Record<string, unknown> = {}) {
  return {
    event_id: "evt-1", event_type: "call.ended", call_id: "call-1", from: "+919876500001", direction: "inbound",
    started_at: "2026-10-12T22:10:00+05:30", ended_at: "2026-10-12T22:15:00+05:30", duration_seconds: 300, end_reason: "completed",
    handled_by: "ai",
    transcript: [
      { speaker: "agent", text: "Good evening, Aangan Studio. How can I help?" },
      { speaker: "caller", text: "I want to redo my 2BHK in Baner." },
      { speaker: "agent", text: "Lovely. Is that design with full execution?" },
      { speaker: "caller", text: "Yes, full design and execution. We have time until March." },
    ],
    extracted: {
      call_kind: "new_enquiry", caller_name: "Test Caller", engagement: "design_and_execution", property_use: "residential",
      scope_summary: "Full 2BHK redo", city: "Pune", locality: "Baner", deadline_weeks: 20, timeline_text: "By March", decision_maker: "caller_is_decider",
    },
    ...over,
  };
}

export function signed(body: unknown, secret: string) {
  const raw = JSON.stringify(body);
  return { raw, headers: new Headers({ "x-vaani-signature": sign(raw, secret) }) };
}

export interface FetchCall { url: string; init?: RequestInit }
/** Stubs global fetch with a router. Returns the recorded calls. */
export function stubFetch(router: (url: string, init?: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }> | "timeout") {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = await router(String(url), init);
    if (r === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }));
  return calls;
}
