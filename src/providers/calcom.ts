import { env, missingConfig } from "@/lib/env";
import { recordIntegration } from "@/domain/audit";
import { httpJson, ProviderError } from "./http";

const BASE = () => env.get("CAL_API_BASE") ?? "https://api.cal.com/v2";
// Slots and bookings are versioned independently in Cal.com API v2. Bookings value verified against the docs on 2026-10-10.
const SLOTS_VERSION = () => env.get("CAL_SLOTS_API_VERSION") ?? "2024-09-04";
const BOOKINGS_VERSION = () => env.get("CAL_BOOKINGS_API_VERSION") ?? "2026-02-25";

export interface CalSlot {
  start: string; // ISO
  end: string; // ISO
}

export interface CalBooking {
  uid: string;
  status: string; // provider's status: accepted | pending | ...
  start: string;
  end: string;
  designer: string | null;
}

function headers(version: string) {
  return {
    Authorization: `Bearer ${env.get("CAL_API_KEY")}`,
    "cal-api-version": version,
    "Content-Type": "application/json",
  };
}

function requireConfig() {
  const missing = missingConfig("calcom");
  if (missing.length) throw new ProviderError("not_configured", `Cal.com not configured: missing ${missing.join(", ")}`);
}

export const eventDurationMinutes = () => Number(env.get("CAL_EVENT_DURATION_MIN") ?? 60);

/** Real availability from Cal.com. Never synthesised: failure throws. */
export async function getAvailableSlots(fromIso: string, toIso: string): Promise<CalSlot[]> {
  requireConfig();
  const qs = new URLSearchParams({
    eventTypeId: env.get("CAL_EVENT_TYPE_ID")!,
    start: fromIso,
    end: toIso,
    timeZone: env.timezone(),
    format: "range",
  });
  try {
    const { body } = await httpJson(`${BASE()}/slots?${qs}`, { headers: headers(SLOTS_VERSION()) });
    const data = (body as { data?: Record<string, unknown[]> })?.data;
    if (!data || typeof data !== "object") throw new ProviderError("invalid_response", "slots response missing data");
    const out: CalSlot[] = [];
    for (const day of Object.values(data)) {
      if (!Array.isArray(day)) continue;
      for (const s of day) {
        const start = typeof s === "string" ? s : (s as { start?: string }).start;
        const end = typeof s === "string" ? undefined : (s as { end?: string }).end;
        if (!start || Number.isNaN(Date.parse(start))) continue;
        out.push({
          start: new Date(start).toISOString(),
          end: end ? new Date(end).toISOString() : new Date(Date.parse(start) + eventDurationMinutes() * 60_000).toISOString(),
        });
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    await recordIntegration("calcom", true, "get_slots", `${out.length} slots`);
    return out;
  } catch (e) {
    await recordIntegration("calcom", false, "get_slots", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Creates the event. Caller must treat the booking as confirmed only if this returns status "accepted". */
export async function createCalBooking(input: {
  startIso: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}): Promise<CalBooking> {
  requireConfig();
  const attendee: Record<string, unknown> = { name: input.name, timeZone: env.timezone(), language: "en" };
  if (input.email) attendee.email = input.email;
  if (input.phone) attendee.phoneNumber = input.phone;
  try {
    const { body } = await httpJson(`${BASE()}/bookings`, {
      method: "POST",
      headers: headers(BOOKINGS_VERSION()),
      body: JSON.stringify({
        start: input.startIso,
        eventTypeId: Number(env.get("CAL_EVENT_TYPE_ID")),
        attendee,
        metadata: { source: "aangan-voice" },
      }),
      timeoutMs: 15_000,
    });
    const d = (body as { status?: string; data?: Record<string, unknown> })?.data;
    if (!d || typeof d.uid !== "string" || typeof d.start !== "string" || typeof d.end !== "string")
      throw new ProviderError("invalid_response", "booking response missing uid/start/end");
    const hosts = Array.isArray(d.hosts) ? (d.hosts as { name?: string }[]) : [];
    await recordIntegration("calcom", true, "create_booking", `uid ${d.uid} status ${String(d.status)}`);
    return { uid: d.uid, status: String(d.status), start: d.start, end: d.end, designer: hosts[0]?.name ?? env.pinnedDesigner() ?? env.get("CAL_DEFAULT_DESIGNER") ?? null };
  } catch (e) {
    await recordIntegration("calcom", false, "create_booking", e instanceof Error ? e.message : String(e));
    throw e;
  }
}
