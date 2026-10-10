import { getDb } from "@/db";
import type { Row } from "@/db/adapter";
import { env } from "@/lib/env";
import { formatLocal } from "@/lib/time";
import { escapeHtml, sendTelegram } from "@/providers/telegram";
import { createDeal, upsertContact } from "@/providers/hubspot";
import { ProviderError } from "@/providers/http";
import { audit } from "./audit";
import { registerJobHandler } from "./jobs";
import { HandoffNoteSchema, type HandoffNote } from "./summary";
import { regenerateSummary } from "./finalize";

const EMOJI: Record<string, string> = {
  GREEN_QUALIFIED: "🟢", AMBER_REVIEW: "🟠", RED_NOT_QUALIFIED: "🔴", URGENT_ESCALATION: "🚨", INCOMPLETE: "⚪",
};

export const dashboardLink = (leadId: string) => `${env.appBaseUrl()}/leads/${leadId}`;

export function renderTelegram(kind: "handoff" | "escalation" | "incomplete" | "pricing_violation", call: Row, lead: Row, note: HandoffNote | null): string {
  const e = (s: string | null | undefined) => escapeHtml(s ?? "unknown");
  const outcome = call.effective_outcome ?? call.system_outcome ?? "INCOMPLETE";
  const head =
    kind === "escalation" ? "🚨 <b>URGENT — existing client complaint</b>"
    : kind === "incomplete" ? "⚪ <b>Missed / incomplete call — callback needed</b>"
    : kind === "pricing_violation" ? "⛔ <b>PRICING POLICY BREACH on a call</b> — the agent/front desk may have quoted a price. Review the transcript."
    : `${EMOJI[outcome] ?? ""} <b>${outcome === "AMBER_REVIEW" ? "Enquiry needs review" : "New qualified enquiry"}</b>`;
  const lines = [head, ""];
  lines.push(`<b>${e(note?.caller_name ?? lead.name)}</b> · ${e(note?.contact.phone ?? lead.phone_e164)}`);
  if (note) {
    lines.push(`Outcome: <b>${e(outcome)}</b>`);
    if (note.qualification.flags.length) lines.push(`Flags: ${e(note.qualification.flags.join(", "))}`);
    lines.push(`Project: ${e(note.project_type)} · ${e(note.location)}${note.carpet_area_sqft ? ` · ${note.carpet_area_sqft} sq ft` : ""}`);
    if (note.requested_scope) lines.push(`Scope: ${e(note.requested_scope)}`);
    lines.push(`Timeline: ${e(note.timeline)} · Site: ${e(note.site_readiness)}`);
    if (note.budget_volunteered) lines.push(`Budget (volunteered): ${e(note.budget_volunteered)}`);
    lines.push(`Decision-maker: ${e(note.decision_maker)}`);
    if (note.constraints_preferences_concerns.length) lines.push(`Notes: ${e(note.constraints_preferences_concerns.join("; "))}`);
    if (note.previous_contact_history) lines.push(`History: ${e(note.previous_contact_history)}`);
    const b = note.booking;
    lines.push("");
    lines.push(`Booking: <b>${e(b.status)}</b>${b.start ? ` — ${e(formatLocal(b.start, b.timezone ?? undefined))}` : ""}${b.designer ? ` with ${e(b.designer)}` : ""}`);
    lines.push(`Next action: ${e(note.next_action)} (${e(note.responsible_person)})`);
  }
  lines.push("", `<a href="${escapeHtml(dashboardLink(lead.id))}">Open in dashboard</a>`);
  return lines.join("\n");
}

async function loadCall(payload: Row) {
  const db = getDb();
  const call = await db.get("calls", String(payload.call_id));
  if (!call) throw new Error("call not found for job");
  const lead = call.lead_id ? await db.get("leads", call.lead_id) : null;
  if (!lead) throw new Error("lead not found for job");
  const parsed = HandoffNoteSchema.safeParse(call.summary);
  return { call, lead, note: parsed.success ? parsed.data : null };
}

let registered = false;
export function ensureHandlers() {
  if (registered) return;
  registered = true;

  registerJobHandler("telegram_handoff", async (p) => {
    const { call, lead, note } = await loadCall(p);
    return sendTelegram(env.get("TELEGRAM_DESIGNER_CHAT_ID"), renderTelegram("handoff", call, lead, note));
  });

  registerJobHandler("telegram_alert", async (p) => {
    const { call, lead, note } = await loadCall(p);
    const kind = p.reason as "escalation" | "incomplete" | "pricing_violation";
    // Complaints go to the designated human owner; if that chat is not configured the job is "blocked" and visible — never silently rerouted.
    const chat = kind === "escalation" ? env.get("TELEGRAM_ESCALATION_CHAT_ID") : env.get("TELEGRAM_DESIGNER_CHAT_ID");
    return sendTelegram(chat, renderTelegram(kind, call, lead, note));
  });

  registerJobHandler("telegram_overdue", async (p) => {
    const db = getDb();
    const task = await db.get("followup_tasks", String(p.task_id));
    if (!task || task.status !== "open") return "skipped:closed";
    const designerChat = env.get("TELEGRAM_DESIGNER_CHAT_ID");
    const ownerChat = env.get("TELEGRAM_ESCALATION_CHAT_ID");
    if (p.target === "owner" && designerChat && ownerChat === designerChat) return "skipped:same-chat";
    const lead = task.lead_id ? await db.get("leads", task.lead_id) : null;
    const who = lead?.name ?? lead?.phone_e164 ?? "unknown caller";
    const text = [
      `⏰ <b>Overdue ${escapeHtml(String(task.kind).replace("_", " "))}</b>: ${escapeHtml(who)}`,
      `Assigned: ${escapeHtml(task.assignee ?? "unassigned")} · was due ${escapeHtml(formatLocal(task.due_at))}`,
      task.notes ? escapeHtml(task.notes) : "",
      lead ? `<a href="${escapeHtml(dashboardLink(lead.id))}">Open in dashboard</a>` : "",
    ].filter(Boolean).join("\n");
    return sendTelegram(p.target === "owner" ? ownerChat : designerChat, text);
  });

  registerJobHandler("hubspot_sync", async (p) => {
    const db = getDb();
    const lead = await db.get("leads", String(p.lead_id));
    if (!lead) throw new Error("lead not found");
    if (lead.hubspot_deal_id) return lead.hubspot_deal_id; // already synced: no duplicate deal
    const effective = lead.effective_outcome;
    const allowed = effective === "GREEN_QUALIFIED" || (effective === "AMBER_REVIEW" && env.hubspotReviewPolicy() === "auto");
    if (!allowed) return "skipped:not-eligible"; // RED / URGENT / INCOMPLETE / unapproved AMBER never reach the CRM
    const call = lead.last_call_id ? await db.get("calls", lead.last_call_id) : null;
    const note = call ? HandoffNoteSchema.safeParse(call.summary) : null;
    let contactId = lead.hubspot_contact_id as string | null;
    if (!contactId) {
      contactId = await upsertContact({ phone: lead.phone_e164, email: lead.email, name: lead.name });
      await db.update("leads", lead.id, { hubspot_contact_id: contactId });
    }
    const n = note?.success ? note.data : null;
    const desc = n
      ? [`Outcome: ${n.qualification.outcome}`, `Scope: ${n.requested_scope ?? "unknown"}`, `Location: ${n.location ?? "unknown"}`, `Timeline: ${n.timeline ?? "unknown"}`,
         n.budget_volunteered ? `Budget (volunteered): ${n.budget_volunteered}` : "", `Next: ${n.next_action}`, `Dashboard: ${dashboardLink(lead.id)}`].filter(Boolean).join("\n")
      : `Dashboard: ${dashboardLink(lead.id)}`;
    const dealId = await createDeal({ contactId, name: `Voice enquiry — ${lead.name ?? lead.phone_e164 ?? "unknown caller"}${n ? ` — ${n.project_type}` : ""}`, description: desc });
    await db.update("leads", lead.id, { hubspot_deal_id: dealId });
    await audit({ actor: "system", actorType: "system", action: "hubspot.deal_created", entityType: "lead", entityId: lead.id, after: { dealId, contactId } });
    return dealId;
  });

  registerJobHandler("summary_retry", async (p) => {
    const ok = await regenerateSummary(String(p.call_id));
    if (!ok) throw new ProviderError("http", "summary regeneration failed");
    return "regenerated";
  });
}
