import { classifyArea } from "./areas";
import type { CriterionResult, Evaluation, Fields } from "./schema";

/**
 * Deterministic encoding of sources/qualified.md (Nikhil Deshpande's rubric) + sources/services.md.
 * The LLM only collects facts; this module makes the decision. Any threshold not in the sources
 * is NOT invented: it yields "unclear" and routes to human review.
 */

export const RUBRIC_VERSION = "2026-10-10.1";

/** services.md: "cannot begin execution on a project that needs to be ready in under 6 weeks from today". */
const MIN_LEAD_WEEKS = 6;
/** qualified.md: site available for execution within 8–10 weeks of consultation. Between 6 and 8 weeks is genuinely borderline. */
const COMFORTABLE_LEAD_WEEKS = 8;
/** services.md: commercial "up to approximately 3,000 sq ft". Approximate → only clearly above is flagged, for review. */
const COMMERCIAL_MAX_SQFT = 3000;
const COMMERCIAL_CLEARLY_OVER = 3300;
/** NOT in services.md: front desk told a 180 sq ft caller (T18) commercial is "typically 500 sq ft or more". Review, never auto-decline. */
const COMMERCIAL_OBSERVED_MIN_SQFT = 500;
/**
 * Lowest all-in figure for any project we take on (single-room redesign), from internal pricing guidance.
 * Used only server-side as a boolean test of a *volunteered* budget; the number never reaches a caller.
 */
const budgetFloor = () => Number(process.env.BUDGET_FLOOR_INR ?? 350_000);

const OUT_OF_SCOPE_KINDS = ["restaurant", "hotel", "retail", "gym"] as const;

export interface EvalContext {
  /** Call ended before a normal conclusion (disconnected, failed, missed, too short). */
  callIncomplete?: boolean;
}

const ev = (f: Fields, id: number) => f.evidence[String(id)] ?? null;

function c1(f: Fields): CriterionResult {
  const base = { id: 1 as const, name: "Real project (design + execution)", source: "qualified.md §1; services.md" };
  const evidence = ev(f, 1);
  if (f.engagement === "advice_only")
    return { ...base, status: "fail", evidence, reason: "Caller wants advice/ideas only; minimum engagement is a room redesign with full execution." };
  if (f.engagement === "diy_execution")
    return { ...base, status: "fail", evidence, reason: "Caller intends to handle execution themselves." };
  if (f.property_use === "commercial" && f.commercial_kind && (OUT_OF_SCOPE_KINDS as readonly string[]).includes(f.commercial_kind))
    return { ...base, status: "fail", evidence, reason: `${f.commercial_kind} projects are out of scope (services.md).` };
  if (f.engagement === "unknown")
    return { ...base, status: "unclear", evidence, reason: "Not yet clear whether the caller wants design with full execution." };
  if (f.property_use === "unknown")
    return { ...base, status: "unclear", evidence, reason: "Property type (residential/commercial) not stated." };
  if (f.structural_changes_requested === true)
    return { ...base, status: "unclear", evidence, reason: "Structural changes mentioned; Aangan does not do structural work. Designer to confirm scope." };
  if (f.property_use === "commercial" && f.carpet_area_sqft !== null) {
    if (f.carpet_area_sqft >= COMMERCIAL_CLEARLY_OVER)
      return { ...base, status: "unclear", evidence, reason: `Commercial area clearly above the ~${COMMERCIAL_MAX_SQFT} sq ft guideline; designer to confirm.` };
    if (f.carpet_area_sqft < COMMERCIAL_OBSERVED_MIN_SQFT)
      return {
        ...base,
        status: "unclear",
        evidence,
        reason: `Small commercial space (${f.carpet_area_sqft} sq ft). The front desk has cited a ~${COMMERCIAL_OBSERVED_MIN_SQFT} sq ft minimum, but that is not in services.md — human decision required.`,
      };
  }
  return { ...base, status: "pass", evidence, reason: "Wants design with execution within scope." };
}

function c2(f: Fields): CriterionResult {
  const base = { id: 2 as const, name: "In service area (Pune / PCMC)", source: "qualified.md §2; services.md" };
  const evidence = ev(f, 2);
  const a = classifyArea(f.city, f.locality);
  if (a.status === "out") return { ...base, status: "fail", evidence, reason: `Location (${a.matched}) is outside Pune/PCMC.` };
  if (a.status === "in") return { ...base, status: "pass", evidence, reason: `Location in service area (${a.matched}).` };
  return { ...base, status: "unclear", evidence, reason: "Location not stated or not recognised." };
}

function c3(f: Fields): CriterionResult {
  const base = { id: 3 as const, name: "Realistic timeline", source: "qualified.md §3; services.md (minimum lead time)" };
  const evidence = ev(f, 3);
  const w = f.deadline_weeks;
  if (w !== null) {
    if (w < MIN_LEAD_WEEKS)
      return { ...base, status: "fail", evidence, reason: `Needs completion in ~${w} weeks; execution cannot begin on projects needed in under ${MIN_LEAD_WEEKS} weeks.` };
    if (w < COMFORTABLE_LEAD_WEEKS)
      return { ...base, status: "unclear", evidence, reason: `Needs completion in ~${w} weeks: above the ${MIN_LEAD_WEEKS}-week hard minimum but short of the 8–10 week norm. Designer to judge.` };
    return { ...base, status: "pass", evidence, reason: "Timeline allows design and execution." };
  }
  if (f.timeline_flexible === true) return { ...base, status: "pass", evidence, reason: "Caller has no fixed deadline." };
  return { ...base, status: "unclear", evidence, reason: "Timeline not stated." };
}

function c4(f: Fields): CriterionResult {
  const base = { id: 4 as const, name: "Budget band (only if volunteered)", source: "qualified.md §4" };
  const evidence = ev(f, 4);
  const b = f.budget_volunteered_max_inr;
  if (b === null) return { ...base, status: "not_assessed", evidence, reason: "No budget volunteered; not assessed and not a disqualifier (never probed)." };
  if (b < budgetFloor())
    return { ...base, status: "fail", evidence, reason: "Volunteered budget is clearly below what any project of this scope would cost (judged server-side against internal guidance)." };
  return { ...base, status: "pass", evidence, reason: "Volunteered budget not clearly misaligned." };
}

function c5(f: Fields): CriterionResult {
  const base = { id: 5 as const, name: "Decision-maker (or authorised)", source: "qualified.md §5" };
  const evidence = ev(f, 5);
  if (f.decision_maker === "caller_is_decider") return { ...base, status: "pass", evidence, reason: "Caller is the decision-maker." };
  if (f.decision_maker === "authorised_representative") return { ...base, status: "pass", evidence, reason: "Caller confirmed they are authorised." };
  if (f.decision_maker === "researching_only")
    return { ...base, status: "unclear", evidence, reason: "Caller is only researching for someone else; qualified.md says this is not sufficient on its own. Never auto-declined — review." };
  return { ...base, status: "pass", evidence, reason: "Decision-maker status unknown; per rubric, do not push — treated as qualified with the uncertainty noted in the handoff." };
}

export function evaluate(f: Fields, ctx: EvalContext = {}): Evaluation {
  const flags: string[] = [];
  if (f.frustrated) flags.push("FRUSTRATED_CALLER_HANDLE_WITH_CARE");
  if (f.asked_pricing) flags.push("ASKED_ABOUT_PRICING");
  if (f.ownership === "tenant") flags.push("RENTED_PROPERTY");
  if (f.decision_maker === "unknown") flags.push("DECISION_MAKER_UNCONFIRMED");
  if (f.budget_volunteered_max_inr === null) flags.push("BUDGET_NOT_VOLUNTEERED");

  let criteria = [c1(f), c2(f), c3(f), c4(f), c5(f)];
  // A failure the model itself was unsure about is never acted on: downgrade to unclear for human review.
  criteria = criteria.map((c) =>
    c.status === "fail" && f.low_confidence.includes(c.id)
      ? { ...c, status: "unclear" as const, reason: `${c.reason} (low-confidence extraction — downgraded to review)` }
      : c,
  );

  const base = { criteria, flags, rubric_version: RUBRIC_VERSION };
  const askable = criteria.filter((c) => c.status === "unclear" && c.id <= 3).map((c) => c.id as 1 | 2 | 3);

  if (f.call_kind === "existing_client_complaint")
    return { ...base, outcome: "URGENT_ESCALATION", askable: [], reasons: ["Existing-client complaint — not a sales enquiry. Escalate to the designated human owner."], flags: [...flags, "EXISTING_CLIENT"] };
  if (f.call_kind === "existing_client_other")
    return { ...base, outcome: "AMBER_REVIEW", askable: [], reasons: ["Existing client contact (non-complaint). Not treated as a new enquiry; route to project owner."], flags: [...flags, "EXISTING_CLIENT"] };

  const fails = criteria.filter((c) => c.status === "fail");
  if (fails.length > 0)
    return { ...base, outcome: "RED_NOT_QUALIFIED", askable, reasons: fails.map((c) => `Criterion ${c.id}: ${c.reason}`) };

  const unclear = criteria.filter((c) => c.status === "unclear");
  if (ctx.callIncomplete && unclear.length > 0)
    return { ...base, outcome: "INCOMPLETE", askable, reasons: ["Call ended before enough information was collected.", ...unclear.map((c) => `Criterion ${c.id}: ${c.reason}`)] };
  if (unclear.length > 0)
    return { ...base, outcome: "AMBER_REVIEW", askable, reasons: unclear.map((c) => `Criterion ${c.id}: ${c.reason}`) };

  return { ...base, outcome: "GREEN_QUALIFIED", askable: [], reasons: ["All five criteria passed (criteria 4 and 5 uncertainty, if any, noted in flags)."] };
}

/** One direct question per unclear criterion (qualified.md). Wording for 3 is quoted from the source. Never about budget. */
export const QUESTIONS: Record<1 | 2 | 3, string> = {
  1: "Just so I point you the right way — are you looking for a full design with execution, or mainly advice and ideas?",
  2: "Which area of Pune or Pimpri-Chinchwad is the property in?",
  3: "When would you need the project complete?",
};

export function nextQuestion(ev: Evaluation, alreadyAsked: number[]): { criterion: 1 | 2 | 3; question: string } | null {
  const id = ev.askable.find((i) => !alreadyAsked.includes(i));
  return id ? { criterion: id, question: QUESTIONS[id] } : null;
}

/** Graceful-close lines shown/spoken to the caller. Contain no prices (enforced by tests). */
export function closingLine(ev: Evaluation): string {
  const failed = ev.criteria.find((c) => c.status === "fail");
  switch (failed?.id) {
    case 1:
      return "We're a full-service studio — our projects include design and execution together, so we're not the right fit for advice-only visits. If you decide to go ahead with a full project, please do call us back.";
    case 2:
      return "We only work in Pune and PCMC at the moment — we don't have the vendor network to take on projects outside Pune. I'm sorry we can't help.";
    case 3:
      return "A project like this needs a few weeks of design before execution can begin, and I wouldn't want to promise a timeline we can't keep. If your dates change, please do call us again.";
    case 4:
      return "I want to be upfront — what you've mentioned may be well below what a project of that scope involves with us, and I wouldn't want you to find that out only at a consultation. Thank you for being open with me.";
    default:
      return "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.";
  }
}
