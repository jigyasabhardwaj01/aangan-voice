import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestVaani } from "@/domain/webhooks/ingest";
import { evaluate } from "@/domain/qualification/rules";
import { FieldsSchema } from "@/domain/qualification/schema";
import { containsPrice } from "@/domain/pricing-guard";
import { lookupTool, qualifyTool } from "@/voice/tools";
import { runSweep } from "@/domain/sweep";
import { runDueJobs } from "@/domain/jobs";
import { ensureHandlers } from "@/domain/notifications";
import { createTask } from "@/domain/tasks";
import { GET as cron } from "@/app/api/cron/jobs/route";
import { db, stubFetch, useCleanEnv, vaaniEvent } from "./helpers";

const send = (b: unknown) => ingestVaani(JSON.stringify(b), new Headers());
const TG = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_DESIGNER_CHAT_ID: "-100designers", TELEGRAM_ESCALATION_CHAT_ID: "-100owner" };

describe("sample call scenarios (tests/calls/*.json) stay in step with the rules", () => {
  useCleanEnv();
  const dir = path.resolve(import.meta.dirname, "calls");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("there are scenario files", () => expect(files.length).toBeGreaterThanOrEqual(7));
  for (const f of files) {
    const s = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    it(`${f}: ${s.name}`, async () => {
      expect(evaluate(FieldsSchema.parse(s.fields)).outcome).toBe(s.expect.outcome);
      const r = await qualifyTool({ call_id: "scn-" + f, fields: s.fields });
      expect(r.decision).toBe(s.expect.decision);
      expect(containsPrice(JSON.stringify(r))).toBe(false);
    });
  }
});

describe("lookup_caller", () => {
  useCleanEnv();
  it("a new caller is unknown, and the agent still gets today's date", async () => {
    const r = await lookupTool({ phone: "+919811111111" });
    expect(r.known).toBe(false);
    expect(r.today).toMatch(/\d{4}/);
  });
  it("a caller with no usable number is treated as new", async () => expect((await lookupTool({ phone: null })).known).toBe(false));

  it("a repeat caller is recognised; only project facts come back, never contact details, budget or concerns", async () => {
    await send(vaaniEvent({ extracted: { ...vaaniEvent().extracted, caller_email: "secret@example.com", budget_volunteered_max_inr: 2500000, budget_text: "25 lakh", preferences_and_concerns: "worried about delays", site_readiness: "empty flat" } }));
    const r = await lookupTool({ phone: "98765 00001" }); // same number, different formatting
    expect(r).toMatchObject({ known: true, first_name: "Test" });
    if (!("already_collected" in r)) throw new Error("expected already_collected");
    expect(r.already_collected).toMatchObject({ city: "Pune", locality: "Baner", site_readiness: "empty flat" });
    const text = JSON.stringify(r);
    for (const leak of ["secret@example.com", "9876500001", "2500000", "25 lakh", "worried about delays"]) expect(text).not.toContain(leak);
    expect(containsPrice(text)).toBe(false);
    expect(r.instruction).toMatch(/do not re-ask/i);
  });
  it("drops remembered text that looks like a price", async () => {
    await send(vaaniEvent({ extracted: { ...vaaniEvent().extracted, site_readiness: "quoted around 15 lakh earlier" } }));
    const r = await lookupTool({ phone: "+919876500001" });
    if (!("already_collected" in r)) throw new Error("expected already_collected");
    expect(r.already_collected).not.toHaveProperty("site_readiness");
  });
  it("an earlier complaint is not treated as a new enquiry and gives no details away", async () => {
    await send(vaaniEvent({ extracted: { call_kind: "existing_client_complaint", caller_name: "Sheetal", existing_client_designer: "Aryan" } }));
    const r = await lookupTool({ phone: "+919876500001" });
    expect(r).toMatchObject({ known: true, existing_client_open_issue: true });
    expect(JSON.stringify(r)).not.toMatch(/Aryan|Sheetal/);
  });
  it("forgets callers after 60 days", async () => {
    await send(vaaniEvent());
    const [lead] = await db().find("leads");
    await db().update("leads", lead.id, { updated_at: new Date(Date.now() - 61 * 86_400_000).toISOString() });
    expect((await lookupTool({ phone: "+919876500001" })).known).toBe(false);
  });
});

describe("overdue sweep", () => {
  useCleanEnv(TG);
  const overdueTask = async (key = "t1", over: Record<string, unknown> = {}) => {
    await send(vaaniEvent());
    const [lead] = await db().find("leads");
    await createTask({ dedupeKey: key, kind: "callback", leadId: lead.id, callId: lead.last_call_id, dueInMinutes: -30, notes: "Call back", ...over });
    return lead;
  };

  it("queues one nudge per target for an overdue open task, and never duplicates it within 12 hours", async () => {
    await overdueTask();
    const r1 = await runSweep();
    expect(r1).toMatchObject({ overdueTasks: 1, nudgesQueued: 2 });
    expect(await runSweep()).toMatchObject({ overdueTasks: 1, nudgesQueued: 0 });
    expect((await db().find("jobs")).filter((j) => j.kind === "telegram_overdue")).toHaveLength(2);
    // 13 hours later a new window nudges again; the call's own booking follow-up (due in 60 min) is overdue by then too
    const later = await runSweep(new Date(Date.now() + 13 * 3_600_000));
    expect(later.nudgesQueued).toBe(later.overdueTasks * 2);
    expect(later.overdueTasks).toBe(2);
  });
  it("ignores tasks that are not due yet, are done, or have no due time", async () => {
    await send(vaaniEvent());
    const [lead] = await db().find("leads");
    await createTask({ dedupeKey: "future", kind: "callback", leadId: lead.id, callId: null, dueInMinutes: 90 });
    await createTask({ dedupeKey: "nodue", kind: "review", leadId: lead.id, callId: null });
    const done = await createTask({ dedupeKey: "done", kind: "callback", leadId: lead.id, callId: null, dueInMinutes: -60 });
    expect(done).toBe(true);
    const t = (await db().find("followup_tasks", { dedupe_key: "done" }))[0];
    await db().update("followup_tasks", t.id, { status: "done" });
    expect((await runSweep()).overdueTasks).toBe(0);
  });
  it("sends the nudge to the designer chat and (if different) the owner chat", async () => {
    const lead = await overdueTask("t2", { assignee: "Aarav" });
    const calls = stubFetch(() => ({ body: { result: { message_id: 1 } } }));
    process.env.APP_BASE_URL = "https://aangan.example";
    await runSweep();
    ensureHandlers();
    await runDueJobs();
    const msgs = calls.map((c) => JSON.parse(String(c.init!.body)));
    expect(msgs.map((m) => m.chat_id).sort()).toEqual(["-100designers", "-100owner"]);
    expect(msgs[0].text).toContain("Overdue callback");
    expect(msgs[0].text).toContain("Aarav");
    expect(msgs[0].text).toContain(`https://aangan.example/leads/${lead.id}`);
    delete process.env.APP_BASE_URL;
  });
  it("does not send twice to one chat when designer and owner are the same", async () => {
    process.env.TELEGRAM_ESCALATION_CHAT_ID = "-100designers";
    await overdueTask();
    const calls = stubFetch(() => ({ body: { result: { message_id: 1 } } }));
    await runSweep(); ensureHandlers(); await runDueJobs();
    expect(calls).toHaveLength(1);
  });
  it("does not nudge about a task completed after it was queued", async () => {
    await overdueTask();
    await runSweep();
    for (const t of await db().find("followup_tasks", { dedupe_key: "t1" })) await db().update("followup_tasks", t.id, { status: "done" });
    const calls = stubFetch(() => ({ body: { result: { message_id: 1 } } }));
    ensureHandlers(); await runDueJobs();
    expect(calls).toHaveLength(0);
  });
  it("review-needed leads now get a 24-hour due time, so they can go overdue", async () => {
    await send(vaaniEvent({ extracted: { ...vaaniEvent().extracted, deadline_weeks: null, timeline_text: null } }));
    const t = (await db().find("followup_tasks")).find((x) => x.kind === "review")!;
    const hours = (Date.parse(t.due_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
  });

  it("the cron endpoint needs the secret, then runs sweep and retries", async () => {
    process.env.CRON_SECRET = "cron-secret-123";
    stubFetch(() => ({ body: { result: { message_id: 1 } } }));
    expect((await cron(new Request("http://x/api/cron/jobs"))).status).toBe(401);
    expect((await cron(new Request("http://x/api/cron/jobs", { headers: { authorization: "Bearer wrong-secret-123" } }))).status).toBe(401);
    await overdueTask();
    const ok = await cron(new Request("http://x/api/cron/jobs", { headers: { authorization: "Bearer cron-secret-123" } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.sweep.overdueTasks).toBe(1);
    expect(body.jobs.sent).toBeGreaterThan(0);
    delete process.env.CRON_SECRET;
  });
});

describe("one-designer mode", () => {
  useCleanEnv();
  it("assigns tasks and the handoff's responsible person to the pinned designer", async () => {
    process.env.ASSIGN_ALL_TO_DESIGNER = "Aarav Mehta";
    await send(vaaniEvent()); // GREEN, no booking → booking follow-up
    await send(vaaniEvent({ call_id: "amb", event_id: "amb", from: "+919822200000", extracted: { ...vaaniEvent().extracted, deadline_weeks: null, timeline_text: null } }));
    const tasks = await db().find("followup_tasks");
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of tasks) expect(t.assignee).toBe("Aarav Mehta");
    const calls = await db().find("calls");
    for (const c of calls) expect(c.summary.responsible_person).toBe("Aarav Mehta");
    delete process.env.ASSIGN_ALL_TO_DESIGNER;
  });
  it("without it, work stays with the shared 'designer on duty'", async () => {
    await send(vaaniEvent());
    expect((await db().find("calls"))[0].summary.responsible_person).toBe("Designer on duty");
    expect((await db().find("followup_tasks"))[0].assignee).toBeNull();
  });
  it("complaints still go to the studio head, not the pinned designer", async () => {
    process.env.ASSIGN_ALL_TO_DESIGNER = "Aarav Mehta";
    await send(vaaniEvent({ extracted: { call_kind: "existing_client_complaint" } }));
    expect((await db().find("calls"))[0].summary.responsible_person).toMatch(/Nikhil/);
    delete process.env.ASSIGN_ALL_TO_DESIGNER;
  });
});

describe("phone collected on the call fixes masked caller numbers", () => {
  useCleanEnv();
  const masked = (id: string, phone: string | null) =>
    vaaniEvent({ call_id: id, event_id: id, from: "+91******1234", extracted: { ...vaaniEvent().extracted, caller_phone: phone } });

  it("attaches the collected number to the lead", async () => {
    await send(masked("c1", "98765 43210"));
    const [lead] = await db().find("leads");
    expect(lead.phone_e164).toBe("+919876543210");
  });
  it("a second masked call with the same collected number joins the same lead (history kept)", async () => {
    await send(masked("c1", "9876543210"));
    await send(masked("c2", "+91 98765 43210"));
    const withPhone = (await db().find("leads")).filter((l) => l.phone_e164 === "+919876543210");
    expect(withPhone).toHaveLength(1);
    const calls = await db().find("calls");
    expect(new Set(calls.map((c) => c.lead_id)).size).toBe(1);
    expect(calls.find((c) => c.provider_call_id === "c2")!.summary.previous_contact_history).toContain("1 earlier call");
  });
  it("joins a lead that already has the number from an unmasked call", async () => {
    await send(vaaniEvent({ call_id: "plain", event_id: "plain", from: "+919876543210" }));
    await send(masked("c3", "9876543210"));
    const calls = await db().find("calls");
    expect(new Set(calls.map((c) => c.lead_id)).size).toBe(1);
  });
  it("no collected number: the lead simply stays without a phone (never a fabricated one)", async () => {
    await send(masked("c4", null));
    expect((await db().find("leads"))[0].phone_e164).toBeNull();
  });
  it("the CRM job then has a phone to match contacts on", async () => {
    Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "pat", HUBSPOT_PIPELINE_ID: "default", HUBSPOT_DEAL_STAGE_ID: "s1" });
    const calls = stubFetch((url) => (url.endsWith("/contacts/search") ? { body: { results: [] } } : url.endsWith("/contacts") ? { body: { id: "C1" } } : { body: { id: "D1" } }));
    await send(masked("c5", "9876543210"));
    const create = calls.find((c) => c.url.endsWith("/contacts") && c.init?.method === "POST")!;
    expect(JSON.parse(String(create.init!.body)).properties.phone).toBe("+919876543210");
    for (const k of ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEAL_STAGE_ID"]) delete process.env[k];
  });
});
