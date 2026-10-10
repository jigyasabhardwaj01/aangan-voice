import { getDb } from "@/db";
import { newId, nowIso } from "@/db/adapter";
import { audit } from "./audit";
import { enqueue, runDueJobs } from "./jobs";
import { ensureHandlers } from "./notifications";
import { OUTCOMES, type Outcome } from "./qualification/schema";
import { createTask } from "./tasks";
import { env } from "@/lib/env";

export type ReviewAction = "approve" | "keep" | "decline" | "reclassify";

export class ReviewError extends Error {}

/**
 * Human review/override. A written reason is mandatory; the override is stored as its own row (the system's
 * original decision is never erased) and mirrored in the audit log.
 */
export async function reviewLead(a: {
  leadId: string;
  action: ReviewAction;
  reason: string;
  actor: string;
  to?: Outcome; // for reclassify
}) {
  ensureHandlers();
  const reason = a.reason.trim();
  if (reason.length < 5) throw new ReviewError("A reason of at least 5 characters is required for any manual override.");

  const db = getDb();
  const lead = await db.get("leads", a.leadId);
  if (!lead || !lead.last_call_id) throw new ReviewError("Lead not found.");
  const call = await db.get("calls", lead.last_call_id);
  if (!call) throw new ReviewError("Call not found.");

  const before: Outcome = (call.effective_outcome ?? call.system_outcome) as Outcome;
  let to: Outcome = before;
  let reviewStatus: string = lead.review_status;
  if (a.action === "approve") { to = "GREEN_QUALIFIED"; reviewStatus = "approved"; }
  else if (a.action === "decline") { to = "RED_NOT_QUALIFIED"; reviewStatus = "declined"; }
  else if (a.action === "keep") { reviewStatus = "kept"; }
  else if (a.action === "reclassify") {
    if (!a.to || !OUTCOMES.includes(a.to)) throw new ReviewError("Choose a valid outcome.");
    to = a.to;
    reviewStatus = to === "GREEN_QUALIFIED" ? "approved" : to === "RED_NOT_QUALIFIED" ? "declined" : to === "AMBER_REVIEW" ? "pending" : "kept";
  }

  await db.insert("overrides", {
    id: newId(), lead_id: lead.id, call_id: call.id, action: a.action, from_outcome: before, to_outcome: to, reason, actor: a.actor, created_at: nowIso(),
  });
  await db.update("calls", call.id, { effective_outcome: to, updated_at: nowIso() });
  await db.update("leads", lead.id, { effective_outcome: to, review_status: reviewStatus, updated_at: nowIso() });
  await audit({
    actor: a.actor, actorType: "user", action: `review.${a.action}`, entityType: "lead", entityId: lead.id,
    before: { outcome: before, review_status: lead.review_status }, after: { outcome: to, review_status: reviewStatus }, reason,
  });

  // Close the review task whenever a decision (not "keep") is made.
  if (a.action !== "keep") {
    const tasks = await db.find("followup_tasks", { lead_id: lead.id, kind: "review", status: "open" });
    for (const t of tasks) await db.update("followup_tasks", t.id, { status: "done", completed_at: nowIso() });
  }

  if (to === "GREEN_QUALIFIED" && before !== "GREEN_QUALIFIED") {
    // Approved by a human: now eligible for CRM, and a designer must contact the caller to book (no auto-dial from here).
    await enqueue(`hubspot:${lead.id}`, "hubspot_sync", { lead_id: lead.id });
    await enqueue(`tg:handoff:${call.id}:approved`, "telegram_handoff", { call_id: call.id });
    await createTask({ dedupeKey: `booking_followup:${lead.id}`, kind: "booking_followup", leadId: lead.id, callId: call.id, dueInMinutes: env.callbackSlaMinutes(), notes: "Approved after review: contact caller to book consultation" });
    await runDueJobs().catch(() => undefined);
  }
  return { from: before, to, reviewStatus };
}
