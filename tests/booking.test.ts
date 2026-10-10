import { describe, expect, it } from "vitest";
import { availabilityTool, bookTool, qualifyTool } from "@/voice/tools";
import { db, stubFetch, useCleanEnv } from "./helpers";

const CAL = { CAL_API_KEY: "cal_test", CAL_EVENT_TYPE_ID: "123", CAL_REQUIRE_EMAIL: "true", CAL_MIN_NOTICE_HOURS: "0" };
const GREEN = { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", city: "Pune", locality: "Baner", deadline_weeks: 20, decision_maker: "caller_is_decider", caller_name: "Meera" };
const SLOTS = {
  "2026-10-14": [{ start: "2026-10-14T10:00:00.000+05:30", end: "2026-10-14T11:00:00.000+05:30" }, { start: "2026-10-14T15:00:00.000+05:30", end: "2026-10-14T16:00:00.000+05:30" }],
  "2026-10-15": [{ start: "2026-10-15T11:00:00.000+05:30", end: "2026-10-15T12:00:00.000+05:30" }],
  "2026-10-16": [{ start: "2026-10-16T12:00:00.000+05:30", end: "2026-10-16T13:00:00.000+05:30" }],
};
const accepted = (start: string, end: string) => ({ status: 201, body: { status: "success", data: { uid: "bk_1", status: "accepted", start, end, hosts: [{ name: "Aryan Joshi" }] } } });

async function greenCall(id = "c1") {
  await qualifyTool({ call_id: id, fields: GREEN });
  return id;
}
const posts = (calls: { url: string; init?: RequestInit }[]) => calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/bookings"));

describe("calendar availability", () => {
  useCleanEnv(CAL);

  it("offers only slots the calendar provider returned", async () => {
    const calls = stubFetch((url) => (url.includes("/slots") ? { body: { status: "success", data: SLOTS } } : { status: 404 }));
    const id = await greenCall();
    const r = await availabilityTool({ call_id: id });
    expect(r.available).toBe(true);
    if (!r.available) return;
    const offered = await db().find("offered_slots");
    const providerStarts = Object.values(SLOTS).flat().map((s) => new Date(s.start).toISOString());
    expect(offered.length).toBeGreaterThan(0);
    for (const o of offered) expect(providerStarts).toContain(o.start_at);
    expect(r.slots.length).toBeLessThanOrEqual(3);
    expect(r.slots.map((s) => s.label).every(Boolean)).toBe(true);
    const slotCall = calls.find((c) => c.url.includes("/slots"))!;
    expect(slotCall.url).toContain("eventTypeId=123");
    expect((slotCall.init?.headers as Record<string, string>).Authorization).toBe("Bearer cal_test");
  });

  it("never touches the calendar for a lead that is not qualified", async () => {
    const calls = stubFetch(() => ({ body: { data: SLOTS } }));
    await qualifyTool({ call_id: "amb", fields: { ...GREEN, deadline_weeks: null } }); // AMBER
    const r = await availabilityTool({ call_id: "amb" });
    expect(r).toMatchObject({ available: false, reason: "not_eligible" });
    expect(calls).toHaveLength(0);
  });

  it("calendar not configured: no fake slots, lead preserved, follow-up task created", async () => {
    delete process.env.CAL_API_KEY;
    const id = await greenCall();
    const r = await availabilityTool({ call_id: id });
    expect(r).toMatchObject({ available: false, reason: "calendar_unavailable" });
    expect(await db().find("offered_slots")).toHaveLength(0);
    expect((await db().find("followup_tasks")).map((t) => t.kind)).toContain("booking_followup");
    expect(await db().find("leads")).toHaveLength(1);
  });

  it("calendar API failure is handled without losing the lead", async () => {
    stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    const id = await greenCall();
    const r = await availabilityTool({ call_id: id });
    expect(r).toMatchObject({ available: false, reason: "calendar_unavailable" });
    expect((await db().find("integration_events")).some((e) => e.provider === "calcom" && !e.ok)).toBe(true);
    expect((await db().find("followup_tasks")).some((t) => t.kind === "booking_followup")).toBe(true);
  });

  it("an empty calendar yields a follow-up, not invented times", async () => {
    stubFetch(() => ({ body: { data: {} } }));
    const id = await greenCall();
    expect(await availabilityTool({ call_id: id })).toMatchObject({ available: false, reason: "no_slots" });
  });
});

describe("booking", () => {
  useCleanEnv(CAL);
  async function offer(id = "c1") {
    await greenCall(id);
    const r = await availabilityTool({ call_id: id });
    if (!r.available) throw new Error("expected slots");
    return r.slots;
  }
  const happy = () => stubFetch((url) => (url.includes("/slots") ? { body: { data: SLOTS } } : accepted("2026-10-14T04:30:00.000Z", "2026-10-14T05:30:00.000Z")));

  it("confirms ONLY after the provider confirms, and stores event id, designer, times and timezone", async () => {
    const calls = happy();
    const [s] = await offer();
    const r = await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "meera@example.com" });
    expect(r.status).toBe("confirmed");
    const [b] = await db().find("bookings");
    expect(b).toMatchObject({ status: "confirmed", provider_booking_uid: "bk_1", designer: "Aryan Joshi", timezone: "Asia/Kolkata", start_at: "2026-10-14T04:30:00.000Z", end_at: "2026-10-14T05:30:00.000Z" });
    const body = JSON.parse(String(posts(calls)[0].init!.body));
    expect(body).toMatchObject({ eventTypeId: 123, attendee: { name: "Meera", email: "meera@example.com", timeZone: "Asia/Kolkata" } });
    expect((posts(calls)[0].init!.headers as Record<string, string>)["cal-api-version"]).toBe("2026-02-25");
  });

  it("requires the caller's explicit confirmation before creating anything", async () => {
    const calls = happy();
    const [s] = await offer();
    const r = await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: false, email: "m@x.com" });
    expect(r.status).toBe("needs_confirmation");
    expect(posts(calls)).toHaveLength(0);
    expect(await db().find("bookings")).toHaveLength(0);
  });

  it("rejects a slot that was never offered on this call", async () => {
    const calls = happy();
    await offer();
    const r = await bookTool({ call_id: "c1", slot_id: "made-up", confirmed: true, email: "m@x.com" });
    expect(r.status).toBe("slot_unavailable");
    expect(posts(calls)).toHaveLength(0);
  });

  it("a slot offered on another call cannot be booked", async () => {
    happy();
    const [s] = await offer("c1");
    await greenCall("c2");
    expect((await bookTool({ call_id: "c2", slot_id: s.slot_id, confirmed: true, email: "m@x.com" })).status).toBe("slot_unavailable");
  });

  it("asks for an email for the invite instead of booking without one", async () => {
    const calls = happy();
    const [s] = await offer();
    expect((await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true })).status).toBe("needs_email");
    expect(posts(calls)).toHaveLength(0);
  });

  it("prevents duplicate bookings (double submit and a second slot)", async () => {
    const calls = happy();
    const slots = await offer();
    const a = await bookTool({ call_id: "c1", slot_id: slots[0].slot_id, confirmed: true, email: "m@x.com" });
    const b = await bookTool({ call_id: "c1", slot_id: slots[0].slot_id, confirmed: true, email: "m@x.com" });
    const c = await bookTool({ call_id: "c1", slot_id: slots[1].slot_id, confirmed: true, email: "m@x.com" });
    expect([a.status, b.status, c.status]).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(posts(calls)).toHaveLength(1);
    expect(await db().find("bookings")).toHaveLength(1);
  });

  it("a provider status other than 'accepted' is never reported as confirmed", async () => {
    stubFetch((url) => (url.includes("/slots") ? { body: { data: SLOTS } } : { status: 201, body: { data: { uid: "bk_p", status: "pending", start: "2026-10-14T04:30:00.000Z", end: "2026-10-14T05:30:00.000Z", hosts: [] } } }));
    const [s] = await offer();
    const r = await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" });
    expect(r.status).toBe("pending");
    expect(r.say).not.toMatch(/you're booked|confirmed/i);
    expect((await db().find("bookings"))[0].status).toBe("pending");
    expect((await db().find("followup_tasks")).some((t) => t.kind === "verify_booking")).toBe(true);
  });

  it("provider outage during booking → failed, visible, follow-up task, retryable", async () => {
    let fail = true;
    const calls = stubFetch((url) => (url.includes("/slots") ? { body: { data: SLOTS } } : fail ? { status: 500, body: { error: "down" } } : accepted("2026-10-14T04:30:00.000Z", "2026-10-14T05:30:00.000Z")));
    const [s] = await offer();
    const r = await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" });
    expect(r.status).toBe("pending");
    expect(r.say).not.toMatch(/you're booked/i);
    expect((await db().find("bookings"))[0]).toMatchObject({ status: "failed", active_key: null });
    expect((await db().find("followup_tasks")).some((t) => t.kind === "booking_followup")).toBe(true);
    expect((await db().find("leads"))).toHaveLength(1);
    fail = false;
    expect((await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" })).status).toBe("confirmed");
    expect(posts(calls)).toHaveLength(2);
  });

  it("a timeout leaves the outcome unknown: marked pending and NOT retried blindly (could double-book)", async () => {
    let n = 0;
    const calls = stubFetch((url) => (url.includes("/slots") ? { body: { data: SLOTS } } : (n++, "timeout")));
    const [s] = await offer();
    const r = await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" });
    expect(r.status).toBe("pending");
    expect((await db().find("bookings"))[0]).toMatchObject({ status: "pending" });
    await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" });
    expect(posts(calls)).toHaveLength(1);
    expect((await db().find("followup_tasks")).some((t) => t.kind === "verify_booking")).toBe(true);
  });

  it("a slot taken meanwhile (409) asks the agent to re-offer", async () => {
    stubFetch((url) => (url.includes("/slots") ? { body: { data: SLOTS } } : { status: 409, body: { message: "taken" } }));
    const [s] = await offer();
    const r = await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" });
    expect(r.status).toBe("slot_unavailable");
    expect((await db().find("bookings"))[0].status).toBe("failed");
  });

  it("audits booking transitions", async () => {
    happy();
    const [s] = await offer();
    await bookTool({ call_id: "c1", slot_id: s.slot_id, confirmed: true, email: "m@x.com" });
    const actions = (await db().find("audit_logs")).map((a) => a.action);
    expect(actions).toContain("booking.requested");
    expect(actions).toContain("booking.confirmed");
  });
});
