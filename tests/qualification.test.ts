import { describe, expect, it } from "vitest";
import { DEMO_CALLS } from "@/demo/fixtures";
import { evaluate, nextQuestion, closingLine, QUESTIONS } from "@/domain/qualification/rules";
import { FieldsSchema, type Fields } from "@/domain/qualification/schema";
import { classifyArea } from "@/domain/qualification/areas";
import { mergeFields } from "@/domain/qualification/service";

const f = (o: Partial<Fields> = {}): Fields => FieldsSchema.parse({
  call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", city: "Pune", locality: "Baner",
  deadline_weeks: 20, decision_maker: "caller_is_decider", ...o,
});
const crit = (e: ReturnType<typeof evaluate>, id: number) => e.criteria.find((c) => c.id === id)!;

describe("qualification rubric against the 20 real September phone calls", () => {
  for (const c of DEMO_CALLS) {
    it(`${c.id} → ${c.expected}`, () => {
      const fields = FieldsSchema.parse(c.fields);
      const incomplete = c.endReason !== "completed";
      expect(evaluate(fields, { callIncomplete: incomplete }).outcome).toBe(c.expected);
    });
  }
});

describe("criterion rules (qualified.md / services.md)", () => {
  it("a fully specified residential enquiry is GREEN", () => expect(evaluate(f()).outcome).toBe("GREEN_QUALIFIED"));

  it("asking about pricing never disqualifies", () => {
    const e = evaluate(f({ asked_pricing: true }));
    expect(e.outcome).toBe("GREEN_QUALIFIED");
    expect(e.flags).toContain("ASKED_ABOUT_PRICING");
  });

  it("advice-only is RED on criterion 1", () => {
    const e = evaluate(f({ engagement: "advice_only" }));
    expect(e.outcome).toBe("RED_NOT_QUALIFIED");
    expect(crit(e, 1).status).toBe("fail");
  });
  it("doing the execution themselves is RED", () => expect(evaluate(f({ engagement: "diy_execution" })).outcome).toBe("RED_NOT_QUALIFIED"));

  it.each(["Nashik", "Mumbai", "Talegaon Dabhade", "Lonavala"])("out of area (%s) is RED", (place) => {
    const e = evaluate(f({ city: place, locality: null }));
    expect(e.outcome).toBe("RED_NOT_QUALIFIED");
    expect(crit(e, 2).status).toBe("fail");
  });
  it("Pimple Saudagar, Hinjewadi and Chinchwad (PCMC) are in area", () => {
    for (const l of ["Pimple Saudagar", "Hinjewadi", "Chinchwad"]) expect(classifyArea(null, l).status).toBe("in");
  });
  it("unrecognised locality is unknown, never out", () => expect(classifyArea(null, "Xyzville").status).toBe("unknown"));
  it("a Pune locality missing from the list is still Pune (adjoining areas)", () => expect(classifyArea("Pune", "Kharadi").status).toBe("in"));

  it("restaurants, hotels, retail and gyms are out of scope", () => {
    for (const k of ["restaurant", "hotel", "retail", "gym"] as const)
      expect(evaluate(f({ property_use: "commercial", commercial_kind: k })).outcome).toBe("RED_NOT_QUALIFIED");
  });

  it("timeline: under 6 weeks fails, 6–8 is review, 8+ passes", () => {
    expect(evaluate(f({ deadline_weeks: 3 })).outcome).toBe("RED_NOT_QUALIFIED");
    expect(evaluate(f({ deadline_weeks: 7 })).outcome).toBe("AMBER_REVIEW");
    expect(evaluate(f({ deadline_weeks: 9 })).outcome).toBe("GREEN_QUALIFIED");
  });

  it("missing budget never triggers a budget question or rejection", () => {
    const e = evaluate(f({ budget_volunteered_max_inr: null }));
    expect(e.outcome).toBe("GREEN_QUALIFIED");
    expect(crit(e, 4).status).toBe("not_assessed");
    // no budget question exists anywhere in the question bank
    expect(Object.values(QUESTIONS).join(" ")).not.toMatch(/budget|afford|spend|how much/i);
  });
  it("a clearly mismatched VOLUNTEERED budget is RED; a sensible one is not", () => {
    expect(evaluate(f({ budget_volunteered_max_inr: 150_000 })).outcome).toBe("RED_NOT_QUALIFIED");
    expect(evaluate(f({ budget_volunteered_max_inr: 2_000_000 })).outcome).toBe("GREEN_QUALIFIED");
  });

  it("unclear decision-maker is treated as qualified (do not push) and noted", () => {
    const e = evaluate(f({ decision_maker: "unknown" }));
    expect(e.outcome).toBe("GREEN_QUALIFIED");
    expect(e.flags).toContain("DECISION_MAKER_UNCONFIRMED");
  });
  it("'just researching for relatives' is not sufficient on its own → review, never auto-reject", () =>
    expect(evaluate(f({ decision_maker: "researching_only" })).outcome).toBe("AMBER_REVIEW"));

  it("rented flat and single-room full execution do not disqualify", () => {
    expect(evaluate(f({ ownership: "tenant", structural_changes_requested: false })).outcome).toBe("GREEN_QUALIFIED");
    expect(evaluate(f({ scope_summary: "Master bedroom, complete redesign with execution" })).outcome).toBe("GREEN_QUALIFIED");
  });
  it("structural changes are routed to review, not rejected", () =>
    expect(evaluate(f({ structural_changes_requested: true })).outcome).toBe("AMBER_REVIEW"));

  it("calling outside office hours is irrelevant to qualification", () => expect(evaluate(f(), {}).outcome).toBe("GREEN_QUALIFIED"));

  it("existing-client complaint is URGENT_ESCALATION, not a sales enquiry, even if other criteria would fail", () => {
    const e = evaluate(f({ call_kind: "existing_client_complaint", city: "Nashik", engagement: "unknown" }));
    expect(e.outcome).toBe("URGENT_ESCALATION");
    expect(e.flags).toContain("EXISTING_CLIENT");
  });

  it("small commercial space is never auto-declined: the 500 sq ft figure is not in services.md", () => {
    const e = evaluate(f({ property_use: "commercial", commercial_kind: "other", carpet_area_sqft: 180 }));
    expect(e.outcome).toBe("AMBER_REVIEW");
    expect(crit(e, 1).reason).toContain("not in services.md");
  });
  it("commercial area slightly over ~3,000 sq ft still gets human review rather than rejection", () => {
    expect(evaluate(f({ property_use: "commercial", commercial_kind: "office", carpet_area_sqft: 3100 })).outcome).toBe("GREEN_QUALIFIED");
    expect(evaluate(f({ property_use: "commercial", commercial_kind: "office", carpet_area_sqft: 4000 })).outcome).toBe("AMBER_REVIEW");
  });

  it("a failure the extractor was unsure of is downgraded to review", () => {
    const e = evaluate(f({ city: "Nashik", locality: null, low_confidence: [2] }));
    expect(e.outcome).toBe("AMBER_REVIEW");
  });

  it("uncertain leads are AMBER; a dropped call with missing info is INCOMPLETE", () => {
    expect(evaluate(f({ deadline_weeks: null })).outcome).toBe("AMBER_REVIEW");
    expect(evaluate(f({ deadline_weeks: null }), { callIncomplete: true }).outcome).toBe("INCOMPLETE");
    expect(evaluate(FieldsSchema.parse({}), { callIncomplete: true }).outcome).toBe("INCOMPLETE");
  });

  it("asks one question per unclear criterion 1–3 and never again for one already asked", () => {
    const e = evaluate(f({ deadline_weeks: null, locality: null, city: null }));
    const q1 = nextQuestion(e, []);
    expect(q1?.criterion).toBe(2);
    const q2 = nextQuestion(e, [2]);
    expect(q2?.criterion).toBe(3);
    expect(q2?.question).toBe("When would you need the project complete?");
    expect(nextQuestion(e, [2, 3])).toBeNull();
  });

  it("graceful closing lines are price-free", () => {
    for (const id of ["advice_only"] as const) expect(closingLine(evaluate(f({ engagement: id })))).not.toMatch(/₹|lakh|per sq/i);
  });

  it("merging layers never lets 'unknown' erase real information and ORs booleans", () => {
    const m = mergeFields({ city: "Pune", frustrated: true }, { city: null, frustrated: false, decision_maker: "unknown" });
    expect(m.city).toBe("Pune");
    expect(m.frustrated).toBe(true);
  });
});
