import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";

/** Indian-default E.164 normalisation. Returns null when no usable number (e.g. withheld caller ID). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits.length >= 8 ? digits : null;
  const d = digits.replace(/^0+/, "");
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  return d.length >= 8 ? "+" + d : null;
}

/** One lead per phone number: repeat calls (e.g. a dropped call then a call-back) attach to the same lead. */
export async function findOrCreateLead(phone: string | null): Promise<Row> {
  const db = getDb();
  const e164 = normalizePhone(phone);
  if (e164) {
    const [existing] = await db.find("leads", { phone_e164: e164 });
    if (existing) return existing;
  }
  const row = {
    id: newId(),
    phone_e164: e164,
    name: null,
    email: null,
    system_outcome: null,
    effective_outcome: null,
    review_status: "none",
    flags: [],
    hubspot_contact_id: null,
    hubspot_deal_id: null,
    last_call_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { row: created, conflict } = await db.insert("leads", row);
  if (created) return created;
  if (conflict && e164) {
    const [existing] = await db.find("leads", { phone_e164: e164 });
    if (existing) return existing;
  }
  throw new Error("could not create lead");
}

export async function previousCalls(leadId: string, excludeCallId: string): Promise<Row[]> {
  const calls = await getDb().find("calls", { lead_id: leadId }, { order: ["started_at", "asc"] });
  return calls.filter((c) => c.id !== excludeCallId);
}
