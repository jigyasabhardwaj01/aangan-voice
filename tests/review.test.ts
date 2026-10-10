import { describe, expect, it } from "vitest";
import { ingestVaani } from "@/domain/webhooks/ingest";
import { reviewLead, ReviewError } from "@/domain/review";
import { db, useCleanEnv, vaaniEvent } from "./helpers";
import { computeMetrics } from "@/domain/metrics";

const ambiguous = () => vaaniEvent({ extracted: { ...vaaniEvent().extracted, deadline_weeks: null, timeline_text: null } });

async function ambLead() {
  await ingestVaani(JSON.stringify(ambiguous()), new Headers());
  const [lead] = await db().find("leads");
  return lead;
}

describe("review queue and human overrides", () => {
  useCleanEnv();

  it("an uncertain lead lands in the review queue with a review task", async () => {
    const lead = await ambLead();
    expect(lead).toMatchObject({ effective_outcome: "AMBER_REVIEW", review_status: "pending" });
    expect((await computeMetrics()).reviewQueue).toBe(1);
    expect((await db().find("followup_tasks")).some((t) => t.kind === "review")).toBe(true);
  });

  it("every manual override requires a reason", async () => {
    const lead = await ambLead();
    await expect(reviewLead({ leadId: lead.id, action: "approve", reason: "", actor: "d@x.com" })).rejects.toBeInstanceOf(ReviewError);
    await expect(reviewLead({ leadId: lead.id, action: "decline", reason: "no", actor: "d@x.com" })).rejects.toThrow(/reason/);
    await expect(reviewLead({ leadId: lead.id, action: "keep", reason: "   ", actor: "d@x.com" })).rejects.toThrow(/reason/);
    expect(await db().find("overrides")).toHaveLength(0);
  });

  it("approve: overrides outcome, keeps the system decision, records audit trail, syncs CRM once", async () => {
    const lead = await ambLead();
    const r = await reviewLead({ leadId: lead.id, action: "approve", reason: "Customer confirmed March on callback", actor: "designer@aangan.in" });
    expect(r).toMatchObject({ from: "AMBER_REVIEW", to: "GREEN_QUALIFIED", reviewStatus: "approved" });
    const [call] = await db().find("calls");
    expect(call.system_outcome).toBe("AMBER_REVIEW"); // original decision preserved
    expect(call.effective_outcome).toBe("GREEN_QUALIFIED");
    const [o] = await db().find("overrides");
    expect(o).toMatchObject({ actor: "designer@aangan.in", reason: "Customer confirmed March on callback", from_outcome: "AMBER_REVIEW", to_outcome: "GREEN_QUALIFIED" });
    const audit = (await db().find("audit_logs")).find((a) => a.action === "review.approve")!;
    expect(audit).toMatchObject({ actor: "designer@aangan.in", entity_id: lead.id, reason: "Customer confirmed March on callback" });
    expect(audit.before.outcome).toBe("AMBER_REVIEW");
    expect(audit.after.outcome).toBe("GREEN_QUALIFIED");
    expect((await db().find("jobs")).filter((j) => j.kind === "hubspot_sync")).toHaveLength(1);
    expect((await computeMetrics()).reviewQueue).toBe(0);
    // approving twice does not enqueue a second CRM job
    await reviewLead({ leadId: lead.id, action: "approve", reason: "double click", actor: "designer@aangan.in" });
    expect((await db().find("jobs")).filter((j) => j.kind === "hubspot_sync")).toHaveLength(1);
  });

  it("decline and keep-under-review", async () => {
    const lead = await ambLead();
    await reviewLead({ leadId: lead.id, action: "keep", reason: "Waiting for the owner to call back", actor: "a@x.com" });
    expect((await db().get("leads", lead.id))!.review_status).toBe("kept");
    expect((await db().get("leads", lead.id))!.effective_outcome).toBe("AMBER_REVIEW");
    await reviewLead({ leadId: lead.id, action: "decline", reason: "Out of scope on follow-up", actor: "a@x.com" });
    expect((await db().get("leads", lead.id))).toMatchObject({ effective_outcome: "RED_NOT_QUALIFIED", review_status: "declined" });
    expect((await db().find("overrides")).length).toBe(2);
  });

  it("a human decision survives a re-delivered/late final webhook", async () => {
    const lead = await ambLead();
    await reviewLead({ leadId: lead.id, action: "approve", reason: "Confirmed by phone", actor: "a@x.com" });
    await ingestVaani(JSON.stringify({ ...ambiguous(), event_id: "evt-late", event_type: "call.final" }), new Headers());
    expect((await db().find("calls"))[0].effective_outcome).toBe("GREEN_QUALIFIED");
    expect((await db().get("leads", lead.id))!.effective_outcome).toBe("GREEN_QUALIFIED");
  });

  it("can reclassify any outcome (e.g. reopen a RED) with a reason", async () => {
    await ingestVaani(JSON.stringify(vaaniEvent({ extracted: { ...vaaniEvent().extracted, city: "Nashik", locality: null } })), new Headers());
    const [lead] = await db().find("leads");
    expect(lead.effective_outcome).toBe("RED_NOT_QUALIFIED");
    await reviewLead({ leadId: lead.id, action: "reclassify", to: "AMBER_REVIEW", reason: "Caller says site is actually in Pimpri", actor: "a@x.com" });
    expect((await db().get("leads", lead.id))).toMatchObject({ effective_outcome: "AMBER_REVIEW", review_status: "pending" });
  });
});
