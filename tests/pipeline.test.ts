import { describe, expect, it } from "vitest";
import { seedDemo } from "@/demo/seed";
import { DEMO_CALLS } from "@/demo/fixtures";
import { computeMetrics } from "@/domain/metrics";
import { ingestVaani } from "@/domain/webhooks/ingest";
import { db, useCleanEnv, vaaniEvent } from "./helpers";

const send = (b: unknown) => ingestVaani(JSON.stringify(b), new Headers());

describe("end-to-end replay of the 20 September phone calls", () => {
  useCleanEnv();

  it("every call is classified as the rubric says, and demo rows are labelled", async () => {
    await seedDemo();
    const calls = await db().find("calls");
    expect(calls).toHaveLength(DEMO_CALLS.length);
    for (const d of DEMO_CALLS) {
      const c = calls.find((x) => x.provider_call_id === `demo-${d.id}`)!;
      expect(c.effective_outcome, d.id).toBe(d.expected);
      expect(c.source).toBe("demo");
    }
  });

  it("the two T17 calls (dropped + call-back) share one lead", async () => {
    await seedDemo();
    expect((await db().find("leads")).length).toBe(DEMO_CALLS.length - 1);
  });

  it("review queue = exactly the ambiguous leads (T07, T11, T13, T14, T16, T18)", async () => {
    await seedDemo();
    const m = await computeMetrics();
    expect(m.reviewQueue).toBe(6);
    const queued = (await db().find("leads", { review_status: "pending" })).map((l) => l.last_call_id);
    const ids = (await db().find("calls", { id: queued })).map((c) => c.provider_call_id.replace("demo-", "")).sort();
    expect(ids).toEqual(["T07", "T11", "T13", "T14", "T16", "T18"]);
  });

  it("complaint T09 escalates and is never treated as a sales enquiry", async () => {
    await seedDemo();
    const c = (await db().find("calls", { provider_call_id: "demo-T09" }))[0];
    expect(c.effective_outcome).toBe("URGENT_ESCALATION");
    expect(c.summary.next_action).toMatch(/complaint/i);
    expect((await db().find("jobs", { key: `tg:escalation:${c.id}` }))).toHaveLength(1);
    expect((await db().find("jobs", { key: `tg:handoff:${c.id}` }))).toHaveLength(0);
  });

  it("T08 (missed after-hours call) is INCOMPLETE with a callback task and counted as a missed call", async () => {
    await seedDemo();
    const c = (await db().find("calls", { provider_call_id: "demo-T08" }))[0];
    expect(c).toMatchObject({ status: "missed", after_hours: true, expected_route: "vaani", effective_outcome: "INCOMPLETE" });
    expect((await computeMetrics()).totals.missed).toBe(1);
    expect((await db().find("followup_tasks")).some((t) => t.call_id === c.id && t.kind === "callback")).toBe(true);
  });

  it("T10's volunteered mismatched budget is declined gracefully; T04 advice-only is declined", async () => {
    await seedDemo();
    for (const id of ["T04", "T10", "T03", "T19"]) {
      const c = (await db().find("calls", { provider_call_id: `demo-${id}` }))[0];
      expect(c.effective_outcome).toBe("RED_NOT_QUALIFIED");
    }
    const t10 = (await db().find("calls", { provider_call_id: "demo-T10" }))[0];
    expect(t10.evaluation.criteria.find((x: { id: number }) => x.id === 4).status).toBe("fail");
  });

  it("calls answered by the human front desk are recorded as human-handled", async () => {
    await seedDemo();
    const m = await computeMetrics();
    expect(m.totals.humanHandled).toBe(20);
    expect(m.totals.aiHandled).toBe(0); // the one missed call was answered by nobody, not "AI"
  });
});

describe("metrics never fabricate missing values", () => {
  useCleanEnv();

  it("with no cost data the cost summary has no amounts — unknown, not zero", async () => {
    await send(vaaniEvent());
    const m = await computeMetrics();
    expect(m.cost.byCurrency).toEqual({});
    expect(m.costPerCurrency).toEqual([]);
    expect(m.cost.linesUnknown).toBe(1);
    const line = (await db().find("cost_events"))[0];
    expect(line).toMatchObject({ basis: "unknown", amount: null, currency: null });
    expect(m.revenue).toBeNull();
  });

  it("measured provider cost is kept distinct from estimated, per currency, with per-lead and per-booking ratios", async () => {
    await send(vaaniEvent({ cost: { amount: 12.5, currency: "INR" } }));
    process.env.VAANI_COST_PER_MIN = "4";
    await send(vaaniEvent({ call_id: "c2", event_id: "e2", from: "+919800000009", cost: undefined, duration_seconds: 120 }));
    delete process.env.VAANI_COST_PER_MIN;
    const m = await computeMetrics();
    const inr = m.costPerCurrency.find((c) => c.currency === "INR")!;
    expect(inr.measured).toBe(12.5);
    expect(inr.estimated).toBe(8);
    expect(inr.perQualifiedLead).toBeCloseTo(20.5 / 2);
    expect(inr.perBookedConsultation).toBeNull(); // no confirmed bookings → unknown, not 0 or infinity
    expect(m.bookings.bookingRate).toBe(0);
  });

  it("response-time stats separate met / missed / unknown", async () => {
    await send(vaaniEvent({ answered_at: "2026-10-12T22:10:03+05:30" }));
    await send(vaaniEvent({ call_id: "slow", event_id: "slow", from: "+919800000010", answered_at: "2026-10-12T22:20:00+05:30", started_at: "2026-10-12T22:10:00+05:30" }));
    await send(vaaniEvent({ call_id: "noinfo", event_id: "noinfo", from: "+919800000011" }));
    const m = await computeMetrics();
    expect(m.response).toMatchObject({ met: 1, notMet: 1, unknown: 1, targetSeconds: 300 });
  });

  it("rates are null (not 0%) when nothing qualifies them", async () => {
    const m = await computeMetrics();
    expect(m.qualification.qualificationRate).toBeNull();
    expect(m.bookings.bookingRate).toBeNull();
    expect(m.response.medianSeconds).toBeNull();
  });
});

describe("pricing-policy audit on transcripts", () => {
  useCleanEnv();
  it("flags a call where the studio side quoted a price and alerts", async () => {
    await send(vaaniEvent({ transcript: [
      { speaker: "caller", text: "How much for a 2BHK?" },
      { speaker: "agent", text: "It'll cost around 15 lakh." },
      { speaker: "caller", text: "ok" },
    ] }));
    const [c] = await db().find("calls");
    expect(c.pricing_violation).toBe(true);
    expect((await db().find("jobs")).some((j) => j.key.startsWith("tg:pricing:"))).toBe(true);
    expect((await db().find("audit_logs")).some((a) => a.action === "pricing.violation_detected")).toBe(true);
  });
  it("a caller quoting their own budget is not a violation", async () => {
    await send(vaaniEvent({ transcript: [{ speaker: "caller", text: "My budget is 20 lakh." }, { speaker: "agent", text: "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like." }, { speaker: "caller", text: "ok book it" }] }));
    expect((await db().find("calls"))[0].pricing_violation).toBe(false);
  });
});
