import { createHash } from "node:crypto";
import { getDb } from "@/db";
import { newId, nowIso, type Row } from "@/db/adapter";
import { audit } from "../audit";
import { evaluate } from "./rules";
import { FieldsSchema, type Evaluation, type Fields, type Outcome } from "./schema";

const DEFAULT_FIELDS = FieldsSchema.parse({});

const isEmpty = (v: unknown, def: unknown) =>
  v === null || v === undefined || v === "unknown" || (Array.isArray(v) && v.length === 0) || JSON.stringify(v) === JSON.stringify(def);

/**
 * Merge field layers (earliest = lowest priority). A later layer overrides only with real information:
 * null/"unknown"/default values never erase something an earlier layer knew. Booleans like frustrated OR together.
 */
export function mergeFields(...layers: (Partial<Fields> | null | undefined)[]): Fields {
  const out: Record<string, unknown> = { ...DEFAULT_FIELDS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      const def = (DEFAULT_FIELDS as Record<string, unknown>)[k];
      if (k === "evidence") out.evidence = { ...(out.evidence as object), ...(v as object) };
      else if (k === "low_confidence") out.low_confidence = [...new Set([...(out.low_confidence as number[]), ...(v as number[])])];
      else if (typeof def === "boolean" && k !== "structural_changes_requested") out[k] = Boolean(out[k]) || Boolean(v);
      else if (!isEmpty(v, def)) out[k] = v;
    }
  }
  return FieldsSchema.parse(out);
}

export function effectiveFor(system: Outcome, override: Row | undefined): Outcome {
  return (override?.to_outcome as Outcome | undefined) ?? system;
}

export async function latestOverride(callId: string): Promise<Row | undefined> {
  const list = await getDb().find("overrides", { call_id: callId }, { order: ["created_at", "desc"], limit: 1 });
  return list[0];
}

/** Append-only qualification record. Identical inputs for a call collapse into one row (idempotent). */
export async function saveQualification(a: { call: Row; source: string; fields: Fields; evaluation: Evaluation }) {
  const hash = createHash("sha256").update(JSON.stringify({ f: a.fields, o: a.evaluation.outcome, v: a.evaluation.rubric_version, s: a.source })).digest("hex").slice(0, 32);
  const { conflict } = await getDb().insert("qualifications", {
    id: newId(), call_id: a.call.id, lead_id: a.call.lead_id, source: a.source, input_hash: hash,
    outcome: a.evaluation.outcome, evaluation: a.evaluation, fields: a.fields, rubric_version: a.evaluation.rubric_version, created_at: nowIso(),
  });
  return { created: !conflict };
}

export async function latestLiveFields(callId: string): Promise<Fields | null> {
  const rows = await getDb().find("qualifications", { call_id: callId, source: "live_tool" }, { order: ["created_at", "desc"], limit: 1 });
  return rows[0] ? FieldsSchema.parse(rows[0].fields) : null;
}

/** Writes the decision onto the call and lead, honouring any human override, and records classification changes. */
export async function applyEvaluation(callId: string, fields: Fields, evaluation: Evaluation, actor = "system") {
  const db = getDb();
  const call = await db.get("calls", callId);
  if (!call) throw new Error("call not found");
  const override = await latestOverride(callId);
  const effective = effectiveFor(evaluation.outcome, override);

  if (call.system_outcome !== evaluation.outcome) {
    await audit({
      actor, actorType: "system", action: "classification.set", entityType: "call", entityId: callId,
      before: { outcome: call.system_outcome }, after: { outcome: evaluation.outcome, reasons: evaluation.reasons },
    });
  }
  await db.update("calls", callId, {
    system_outcome: evaluation.outcome, effective_outcome: effective, evaluation, extracted: fields, updated_at: nowIso(),
  });

  const lead = call.lead_id ? await db.get("leads", call.lead_id) : null;
  if (lead) {
    const review = override ? lead.review_status : evaluation.outcome === "AMBER_REVIEW" ? "pending" : lead.review_status === "pending" ? "none" : lead.review_status;
    await db.update("leads", lead.id, {
      name: fields.caller_name ?? lead.name,
      email: fields.caller_email ?? lead.email,
      system_outcome: evaluation.outcome,
      effective_outcome: effective,
      review_status: review,
      flags: evaluation.flags,
      last_call_id: callId,
      updated_at: nowIso(),
    });
  }
  return { effective };
}

export { evaluate };
