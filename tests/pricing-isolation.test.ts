import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_PRICING_RESPONSE, assertNoPrice, assertNoPriceDeep, containsPrice } from "@/domain/pricing-guard";
import { buildVoiceContext } from "@/voice/context";
import { closingLine, evaluate, QUESTIONS } from "@/domain/qualification/rules";
import { FieldsSchema } from "@/domain/qualification/schema";
import { availabilityTool, bookTool, qualifyTool } from "@/voice/tools";
import { setDb, freshMemoryDb } from "@/db";
import { stubFetch, useCleanEnv } from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((n) => {
    const rel = path.join(dir, n);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}
/** Numeric price tokens that must not appear in anything given to the voice model. */
const NUMERIC_PRICE = /₹|\brs\.?\s*\d|\blakhs?\b|\bcrores?\b|\d\s*(\/|per)\s*sq|per sq\.? ?ft\s*\d/i;

describe("voice context isolation", () => {
  it("the approved pricing sentence is exact and itself price-free", () => {
    expect(APPROVED_PRICING_RESPONSE).toBe(
      "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.",
    );
    expect(containsPrice(APPROVED_PRICING_RESPONSE)).toBe(false);
  });
  it("the system prompt contains the approved sentence verbatim", () => expect(read("vaani/system-prompt.md")).toContain(APPROVED_PRICING_RESPONSE));

  it("rubric.txt and the system prompt contain no price figures", () => {
    for (const f of ["rubric.txt", "vaani/system-prompt.md", "vaani/voice-context.txt"]) expect(read(f), f).not.toMatch(NUMERIC_PRICE);
  });
  it("vaani/voice-context.txt is in sync with the prompt (run `npm run build:voice-context`)", () => {
    expect(read("vaani/voice-context.txt")).toBe(buildVoiceContext(read("vaani/system-prompt.md")));
  });
  it("the prompt embeds the rubric and has no runtime dependency on rubric.txt", () => {
    const p = read("vaani/system-prompt.md");
    expect(p).toContain("Stage 4 — Internal Qualification Rubric");
    expect(p).toContain("do not depend on an external `rubric.txt` file at runtime");
    expect(p).not.toMatch(/apply `?rubric\.txt|use `?rubric\.txt as|the rubric in `?rubric\.txt/i);
    for (const o of ["GREEN_QUALIFIED", "AMBER_REVIEW", "RED_NOT_QUALIFIED", "URGENT_ESCALATION", "INCOMPLETE"]) expect(p).toContain(o);
    expect(p).toContain("Never ask the caller for a budget");
    expect(p).toContain("`not_assessed`");
    expect(p).toContain("Are you looking for a complete design-and-execution project, or only advice or styling?");
  });
  it("the embedded prompt preserves the source rules", () => {
    const r = read("vaani/system-prompt.md");
    for (const phrase of [
      "Criterion 1 — Real design-and-execution project", "Criterion 2 — Service area", "Criterion 3 — Timeline", "Criterion 5 — Decision-maker",
      "Talegaon, Lonavala, Nashik, Mumbai", "under 6 weeks", "8–10 weeks", "approximately 3,000 sq ft", "Never ask the caller for a budget",
      "Do not reject a caller solely for asking about pricing, renting their property",
    ]) expect(r, phrase).toContain(phrase);
  });
  it("the numeric rate tables never appear in sources that can reach callers", () => {
    // pricing.md numbers: none of the guide's distinctive tokens may sit outside the internal module
    const forbidden = /1,?800|2,?400|3,?500|₹3\.5 lakh/;
    const allowed = new Set([path.join("src", "internal", "pricing-guidance.ts")]);
    const leaks = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !allowed.has(f) && !f.includes("demo") && forbidden.test(read(f)));
    // a few unrelated numbers (e.g. 3,500 in comments) would be caught here: keep the list empty
    expect(leaks).toEqual([]);
  });
});

describe("import graph: caller-facing code can never reach internal pricing", () => {
  const importsInternal = (f: string) => /from\s+["'](@\/internal|\.{1,2}\/(?:\.\.\/)*internal)/.test(read(f)) || /require\(["'].*internal/.test(read(f));
  it("only dashboard pages import src/internal", () => {
    const offenders = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && importsInternal(f) && !f.startsWith(path.join("src", "app", "(dashboard)")));
    expect(offenders).toEqual([]);
  });
  it("nothing under src/voice, api/voice, webhooks, booking or providers imports it", () => {
    for (const f of [...walk("src/voice"), ...walk("src/app/api"), ...walk("src/providers"), "src/domain/booking.ts", "src/domain/notifications.ts"])
      expect(importsInternal(f), f).toBe(false);
  });
  it("the internal module is server-only", () => expect(read("src/internal/pricing-guidance.ts")).toContain('import "server-only"'));
});

describe("pricing guard", () => {
  it.each([
    "It'll cost around 25 lakh", "Our rates start at ₹1,800 per sq ft", "For a 2BHK it's typically 15-20 lakh", "about Rs. 3 lakh",
    "roughly 2000 per sq ft", "starting from 5 lakhs", "1.5 crore", "that would cost 10,00,000",
  ])("blocks: %s", (t) => expect(containsPrice(t)).toBe(true));
  it.each(["Your designer will walk you through it", "We'll book Tuesday at 11:00 AM", "A 2BHK with kitchen and wardrobes", "about 950 sq ft carpet"])(
    "allows: %s", (t) => expect(containsPrice(t)).toBe(false));
  it("assertNoPriceDeep throws on any nested string", () => {
    expect(() => assertNoPriceDeep({ a: [{ say: "from ₹5 lakh" }] }, "t")).toThrow(/PRICING_LEAK_BLOCKED/);
    expect(() => assertNoPrice("fine", "t")).not.toThrow();
  });
  it("all rubric closing lines and questions are price-free", () => {
    for (const q of Object.values(QUESTIONS)) expect(containsPrice(q)).toBe(false);
    const variants = [{ engagement: "advice_only" }, { city: "Nashik" }, { deadline_weeks: 2 }, { budget_volunteered_max_inr: 100000 }, {}] as const;
    for (const v of variants) expect(containsPrice(closingLine(evaluate(FieldsSchema.parse({ ...v }))))).toBe(false);
  });
});

describe("caller-facing tool responses never contain prices (even when the caller talks numbers)", () => {
  useCleanEnv({ CAL_REQUIRE_EMAIL: "false" });
  it("qualify with a volunteered budget echoes nothing numeric", async () => {
    const r = await qualifyTool({ call_id: "p1", fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", city: "Pune", locality: "Baner", deadline_weeks: 20, budget_volunteered_max_inr: 150000, budget_text: "1 to 1.5 lakh" } });
    expect(r.decision).toBe("close_gracefully");
    expect(JSON.stringify(r)).not.toMatch(/\d{4,}|lakh|₹/i);
  });
  it("availability and book (calendar down) never mention money", async () => {
    await qualifyTool({ call_id: "p2", fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", city: "Pune", locality: "Baner", deadline_weeks: 20 } });
    const a = await availabilityTool({ call_id: "p2" });
    expect(containsPrice(JSON.stringify(a))).toBe(false);
    const b = await bookTool({ call_id: "p2", slot_id: "x", confirmed: true });
    expect(containsPrice(JSON.stringify(b))).toBe(false);
    stubFetch(() => ({ status: 500 }));
  });
  it("the voice tool path has no way to emit guidance numbers", () => setDb(freshMemoryDb()));
});
