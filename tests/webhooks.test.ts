import { describe, expect, it } from "vitest";
import { ingestVaani } from "@/domain/webhooks/ingest";
import { normalizeVaani } from "@/domain/webhooks/vaani-adapter";
import { db, signed, useCleanEnv, vaaniEvent } from "./helpers";
import { decideRoute } from "@/domain/routing";
import { classifyEnd } from "@/domain/calls";

const SECRET = "test-secret-123456";

describe("signature handling", () => {
  useCleanEnv({ VAANI_WEBHOOK_SECRET: SECRET, ALLOW_UNSIGNED_WEBHOOKS: "false" });
  it("rejects a bad signature and records a rejected event", async () => {
    const raw = JSON.stringify(vaaniEvent());
    const r = await ingestVaani(raw, new Headers({ "x-vaani-signature": "deadbeef" }));
    expect(r.status).toBe(401);
    expect(await db().find("calls")).toHaveLength(0);
    expect((await db().find("webhook_events"))[0].status).toBe("rejected");
  });
  it("accepts a correct signature", async () => {
    const s = signed(vaaniEvent(), SECRET);
    expect((await ingestVaani(s.raw, s.headers)).status).toBe(200);
    expect(await db().find("calls")).toHaveLength(1);
  });
});

describe("refuses unsigned webhooks when no secret is configured", () => {
  useCleanEnv({ ALLOW_UNSIGNED_WEBHOOKS: "false" });
  it("503", async () => expect((await ingestVaani(JSON.stringify(vaaniEvent()), new Headers())).status).toBe(503));
});

describe("idempotent webhook processing", () => {
  useCleanEnv();
  const send = (b: unknown) => ingestVaani(JSON.stringify(b), new Headers());

  it("a retried identical delivery creates no duplicate records or actions", async () => {
    const e = vaaniEvent();
    expect((await send(e)).status).toBe(200);
    const r2 = await send(e);
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    for (const t of ["calls", "leads", "qualifications", "webhook_events", "jobs", "followup_tasks", "cost_events"] as const) {
      const rows = await db().find(t);
      const again = await send(e);
      expect(again.body.duplicate).toBe(true);
      expect((await db().find(t)).length, t).toBe(rows.length);
    }
    expect(await db().find("calls")).toHaveLength(1);
    expect((await db().find("jobs")).filter((j) => j.kind === "telegram_handoff")).toHaveLength(1);
    expect((await db().find("jobs")).filter((j) => j.kind === "hubspot_sync")).toHaveLength(1);
  });

  it("with no provider event id, an identical body is deduplicated by hash", async () => {
    const e = { ...vaaniEvent(), event_id: undefined };
    await send(e);
    expect((await send(e)).body.duplicate).toBe(true);
    expect(await db().find("calls")).toHaveLength(1);
  });

  it("a different event id for the same call (late 'final' after 'ended') re-finalises without duplicating anything", async () => {
    await send(vaaniEvent());
    await send(vaaniEvent({ event_id: "evt-2", event_type: "call.final" }));
    expect(await db().find("calls")).toHaveLength(1);
    expect(await db().find("qualifications")).toHaveLength(1); // same inputs → one row
    expect((await db().find("jobs")).filter((j) => j.kind === "telegram_handoff")).toHaveLength(1);
  });

  it("call-start arriving after call-end never regresses the call", async () => {
    await send(vaaniEvent());
    await send({ event_id: "late-start", event_type: "call.started", call_id: "call-1", from: "+919876500001", started_at: "2026-10-12T22:10:00+05:30" });
    const [c] = await db().find("calls");
    expect(c.status).toBe("completed");
    expect(c.system_outcome).toBe("GREEN_QUALIFIED");
  });

  it("a failed processing attempt is retried safely and then marked processed exactly once", async () => {
    const e = vaaniEvent({ event_id: "evt-fail" });
    const real = db().update.bind(db());
    let boom = true;
    (db() as unknown as { update: typeof real }).update = async (t, id, p) => {
      if (boom && t === "calls" && p.system_outcome) { boom = false; throw new Error("db blip"); }
      return real(t, id, p);
    };
    expect((await send(e)).status).toBe(500);
    expect((await db().find("webhook_events"))[0].status).toBe("failed");
    expect((await send(e)).status).toBe(200);
    const ev = await db().find("webhook_events");
    expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe("processed");
    expect(ev[0].attempts).toBe(2);
    expect(await db().find("calls")).toHaveLength(1);
  });

  it("unrecognised payloads are rejected visibly, not silently dropped", async () => {
    const r = await send({ event_type: "something.else", call_id: "x" });
    expect(r.status).toBe(422);
    expect((await db().find("webhook_events"))[0].status).toBe("rejected");
  });
});

describe("call state handling", () => {
  useCleanEnv();
  const send = (b: unknown) => ingestVaani(JSON.stringify(b), new Headers());

  it("missed, disconnected and failed calls are classified and routed to follow-up, not lost", async () => {
    await send({ event_id: "m", event_type: "call.missed", call_id: "m1", from: "+919800000001", started_at: "2026-10-12T23:00:00+05:30" });
    await send({ event_id: "d", event_type: "call.ended", call_id: "d1", from: "+919800000002", started_at: "2026-10-12T23:10:00+05:30", end_reason: "caller disconnected", duration_seconds: 30,
      transcript: [{ speaker: "agent", text: "Hello" }, { speaker: "caller", text: "Hi I wanted to inquire about" }] });
    await send({ event_id: "f", event_type: "call.failed", call_id: "f1", from: "+919800000003", started_at: "2026-10-12T23:20:00+05:30" });
    const calls: Record<string, Record<string, any>> = Object.fromEntries((await db().find("calls")).map((c) => [c.provider_call_id, c]));
    expect(calls.m1.status).toBe("missed");
    expect(calls.d1.status).toBe("disconnected");
    expect(calls.f1.status).toBe("failed");
    for (const c of Object.values(calls)) expect(c.effective_outcome).toBe("INCOMPLETE");
    const tasks = await db().find("followup_tasks");
    expect(tasks.filter((t) => t.kind === "callback")).toHaveLength(3);
    expect((await db().find("jobs")).filter((j) => j.kind === "telegram_alert")).toHaveLength(3);
  });

  it("records handling mode, after-hours and the actual response time", async () => {
    await send(vaaniEvent({ answered_at: "2026-10-12T22:10:04+05:30", handled_by: "ai" }));
    const [c] = await db().find("calls");
    expect(c.handling_mode).toBe("ai");
    expect(c.handling_mode_source).toBe("reported");
    expect(c.after_hours).toBe(true);
    expect(c.expected_route).toBe("vaani");
    expect(c.response_seconds).toBe(4);
    expect(c.duration_seconds).toBe(300);
    expect(c.transcript).toHaveLength(4);
  });

  it("response time is unknown (null) when the provider gives no answer time — never invented", async () => {
    await send(vaaniEvent());
    expect((await db().find("calls"))[0].response_seconds).toBeNull();
  });

  it("a dropped call and the caller's call-back attach to one lead, with history", async () => {
    await send(vaaniEvent({ event_id: "a", call_id: "c-a", end_reason: "disconnected", duration_seconds: 20, transcript: [{ speaker: "agent", text: "Hi" }], extracted: null }));
    await send(vaaniEvent({ event_id: "b", call_id: "c-b" }));
    expect(await db().find("leads")).toHaveLength(1);
    const b = (await db().find("calls", { provider_call_id: "c-b" }))[0];
    expect(b.summary.previous_contact_history).toContain("1 earlier call");
  });

  it("classifyEnd covers reasons", () => {
    const base = { eventId: "", kind: "call_final", providerCallId: "", from: null, to: null, direction: null, startedAt: null, answeredAt: null, endedAt: null, durationSeconds: 60, endReason: null, handledBy: null, transcript: null, extracted: null, cost: null } as const;
    expect(classifyEnd({ ...base, endReason: "no-answer" }, 0)).toBe("missed");
    expect(classifyEnd({ ...base, endReason: "Network error" }, 3)).toBe("failed");
    expect(classifyEnd({ ...base, endReason: "dropped" }, 3)).toBe("disconnected");
    expect(classifyEnd({ ...base, endReason: "customer-ended-call" }, 8)).toBe("completed");
  });

  it("normalizer accepts string transcripts and rejects missing call ids", () => {
    const ok = normalizeVaani({ type: "call_ended", callId: "z", transcript: "Agent: hi\nCaller: hello there\nmore words" }, "{}");
    expect(ok.ok && ok.event.transcript).toEqual([{ speaker: "agent", text: "hi" }, { speaker: "caller", text: "hello there more words" }]);
    expect(normalizeVaani({ event_type: "call.ended" }, "{}").ok).toBe(false);
  });
});

describe("routing: after-hours → Vaani, staffed hours → front desk", () => {
  it("10am–7pm Mon–Sat IST is the front desk", () => {
    expect(decideRoute(new Date("2026-09-02T10:23:00+05:30"))).toBe("front_desk"); // Wed
    expect(decideRoute(new Date("2026-09-05T15:28:00+05:30"))).toBe("front_desk"); // Sat
    expect(decideRoute(new Date("2026-09-02T18:59:00+05:30"))).toBe("front_desk");
  });
  it("evenings, early mornings, nights and Sundays go to Vaani", () => {
    expect(decideRoute(new Date("2026-09-09T22:47:00+05:30"))).toBe("vaani");
    expect(decideRoute(new Date("2026-09-02T09:59:00+05:30"))).toBe("vaani");
    expect(decideRoute(new Date("2026-09-02T19:00:00+05:30"))).toBe("vaani");
    expect(decideRoute(new Date("2026-09-06T12:00:00+05:30"))).toBe("vaani"); // Sunday
  });
});
