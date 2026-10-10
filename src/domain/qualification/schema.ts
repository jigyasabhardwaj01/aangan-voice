import { z } from "zod";

export const OUTCOMES = ["GREEN_QUALIFIED", "AMBER_REVIEW", "RED_NOT_QUALIFIED", "URGENT_ESCALATION", "INCOMPLETE"] as const;
export type Outcome = (typeof OUTCOMES)[number];

const str = z.string().trim().max(500).nullable().default(null);

/**
 * Facts collected on the call. Everything is nullable: null means "not stated", never a guess.
 * Produced by the voice agent's tool call, Vaani's post-call extraction, or Gemini extraction,
 * and always re-validated here. Treat all values as untrusted caller input.
 */
export const FieldsSchema = z.object({
  call_kind: z
    .enum(["new_enquiry", "existing_client_complaint", "existing_client_other", "unknown"])
    .default("unknown"),
  caller_name: str,
  caller_phone: str,
  caller_email: str,

  engagement: z.enum(["design_and_execution", "advice_only", "diy_execution", "unknown"]).default("unknown"),
  property_use: z.enum(["residential", "commercial", "unknown"]).default("unknown"),
  commercial_kind: z
    .enum(["office", "clinic", "studio", "restaurant", "hotel", "retail", "gym", "other"])
    .nullable()
    .default(null),
  scope_summary: str,
  structural_changes_requested: z.boolean().nullable().default(null),
  ownership: z.enum(["owner", "tenant", "unknown"]).default("unknown"),
  property_details: str,

  city: str,
  locality: str,

  carpet_area_sqft: z.number().positive().max(1_000_000).nullable().default(null),
  site_readiness: str,
  /** Whole weeks from today until the caller needs the work complete / site ready; null if not stated. */
  deadline_weeks: z.number().min(0).max(520).nullable().default(null),
  timeline_flexible: z.boolean().nullable().default(null),
  timeline_text: str,

  /** Only when the caller volunteers it. The agent must never ask. */
  budget_volunteered_max_inr: z.number().positive().nullable().default(null),
  budget_text: str,

  decision_maker: z
    .enum(["caller_is_decider", "authorised_representative", "researching_only", "unknown"])
    .default("unknown"),

  frustrated: z.boolean().default(false),
  previous_contact_note: str,
  existing_client_designer: str,
  preferences_and_concerns: str,
  asked_pricing: z.boolean().default(false),
  /** Criterion ids the model is not confident about; a failing criterion with low confidence is downgraded to unclear. */
  low_confidence: z.array(z.number().int().min(1).max(5)).default([]),
  /** Short verbatim quotes per criterion id (as string key). */
  evidence: z.record(z.string(), z.string().max(400)).default({}),
});
export type Fields = z.infer<typeof FieldsSchema>;

export type CriterionStatus = "pass" | "fail" | "unclear" | "not_assessed";
export interface CriterionResult {
  id: 1 | 2 | 3 | 4 | 5;
  name: string;
  status: CriterionStatus;
  reason: string;
  evidence: string | null;
  /** Rule source reference, for traceability. */
  source: string;
}

export interface Evaluation {
  outcome: Outcome;
  criteria: CriterionResult[];
  reasons: string[];
  flags: string[];
  /** Criterion ids that are unclear and could be resolved with one direct question. */
  askable: (1 | 2 | 3)[];
  rubric_version: string;
}
