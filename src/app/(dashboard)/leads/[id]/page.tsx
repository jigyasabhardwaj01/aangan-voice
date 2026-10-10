import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { AFFECTS_PRICING, PRICING_DISCLAIMER, guidanceFor } from "@/internal/pricing-guidance";
import { OUTCOMES } from "@/domain/qualification/schema";
import { Badge, BookingBadge, OutcomeBadge, fmtDateTime, fmtDuration, fmtResponse } from "@/app/ui";
import { completeTaskAction, reviewAction } from "../../actions";

const show = (v: unknown) => (v === null || v === undefined || v === "" || v === "unknown" ? <span className="muted">unknown</span> : String(v));
const TONE: Record<string, "green" | "amber" | "red" | "grey"> = { pass: "green", unclear: "amber", fail: "red", not_assessed: "grey" };

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string; call?: string }> }) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const lead = await db.get("leads", id);
  if (!lead) notFound();

  const calls = await db.find("calls", { lead_id: id }, { order: ["started_at", "desc"] });
  const call = calls.find((c) => c.id === sp.call) ?? calls[0];
  const [bookings, tasks, overrides, audits, quals] = await Promise.all([
    db.find("bookings", { lead_id: id }, { order: ["created_at", "desc"] }),
    db.find("followup_tasks", { lead_id: id }, { order: ["created_at", "desc"] }),
    db.find("overrides", { lead_id: id }, { order: ["created_at", "desc"] }),
    db.find("audit_logs", { entity_id: id }, { order: ["at", "desc"] }),
    call ? db.find("qualifications", { call_id: call.id }, { order: ["created_at", "desc"] }) : Promise.resolve([]),
  ]);
  const f = call?.extracted ?? {};
  const note = call?.summary;
  const crit = (call?.evaluation?.criteria ?? []) as { id: number; name: string; status: string; reason: string; evidence: string | null; source: string }[];
  const guidance = guidanceFor({ propertyUse: f.property_use ?? "unknown", carpetAreaSqft: f.carpet_area_sqft ?? null, singleRoom: /single|one room|bedroom$/i.test(f.scope_summary ?? "") });
  const bookAudit = (await db.find("audit_logs", { entity_type: "booking" }, { order: ["at", "desc"] })).filter((a) => bookings.some((b) => b.id === a.entity_id));

  return (
    <>
      <div className="row sp">
        <div>
          <h1>{lead.name ?? "Unknown caller"}</h1>
          <p className="sub">{lead.phone_e164 ?? "number withheld"}{lead.email ? ` · ${lead.email}` : ""} · {calls.length} call{calls.length === 1 ? "" : "s"}</p>
        </div>
        <div className="row"><OutcomeBadge outcome={lead.effective_outcome} />{lead.review_status !== "none" && <Badge tone={lead.review_status === "pending" ? "amber" : "grey"}>review: {lead.review_status}</Badge>}</div>
      </div>
      {sp.error && <div className="banner err">{sp.error}</div>}
      {sp.saved && <div className="banner ok">Decision recorded.</div>}
      {call?.pricing_violation && <div className="banner err"><b>Pricing policy breach suspected:</b> the studio side of this call may have quoted a price. Check the transcript.</div>}
      {(lead.flags ?? []).includes("FRUSTRATED_CALLER_HANDLE_WITH_CARE") && <div className="banner warn"><b>Handle with care:</b> the caller was frustrated{f.previous_contact_note ? ` — ${f.previous_contact_note}` : ""}.</div>}

      {call && (
        <div className="cols">
          <div className="grid">
            <section className="card">
              <h2>Next action</h2>
              <p style={{ margin: 0 }}><b>{note?.next_action ?? "—"}</b></p>
              <p className="muted small" style={{ margin: "4px 0 0" }}>Responsible: {note?.responsible_person ?? "—"} · summary by {call.summary_source === "gemini" ? "Gemini Flash" : "rule-based fallback (no model summary)"}</p>
            </section>

            <section className="card">
              <h2>Handoff summary</h2>
              <dl className="kv">
                <dt>Project</dt><dd>{show(note?.project_type)} — {show(note?.requested_scope)}</dd>
                <dt>Location</dt><dd>{show(note?.location)}</dd>
                <dt>Property</dt><dd>{show(note?.property_details)}</dd>
                <dt>Carpet area</dt><dd>{note?.carpet_area_sqft ? `${note.carpet_area_sqft} sq ft (stated)` : <span className="muted">not stated</span>}</dd>
                <dt>Site readiness</dt><dd>{show(note?.site_readiness)}</dd>
                <dt>Timeline</dt><dd>{show(note?.timeline)}</dd>
                <dt>Budget</dt><dd>{note?.budget_volunteered ?? <span className="muted">not volunteered</span>}</dd>
                <dt>Decision-maker</dt><dd>{show(note?.decision_maker?.replace(/_/g, " "))}</dd>
                <dt>Requirements</dt><dd>{note?.requirements?.length ? note.requirements.join("; ") : <span className="muted">none recorded</span>}</dd>
                <dt>Concerns / prefs</dt><dd>{note?.constraints_preferences_concerns?.length ? note.constraints_preferences_concerns.join("; ") : <span className="muted">none recorded</span>}</dd>
                <dt>History</dt><dd>{show(note?.previous_contact_history)}</dd>
              </dl>
            </section>

            <section className="card tw">
              <h2>Qualification evidence <span className="muted small">rubric {call.evaluation?.rubric_version}</span></h2>
              <table><thead><tr><th>Criterion</th><th>Result</th><th>Why</th></tr></thead><tbody>
                {crit.map((c) => (
                  <tr key={c.id}><td>{c.id}. {c.name}<br /><span className="muted small">{c.source}</span></td><td><Badge tone={TONE[c.status]}>{c.status.replace("_", " ")}</Badge></td>
                    <td className="small">{c.reason}{c.evidence && <><br /><i>“{c.evidence}”</i></>}</td></tr>
                ))}
                {crit.length === 0 && <tr><td colSpan={3} className="muted">No evaluation recorded.</td></tr>}
              </tbody></table>
              <p className="muted small">System decision: <OutcomeBadge outcome={call.system_outcome} /> · {quals.length} qualification record(s) for this call.</p>
            </section>

            <section className="card">
              <h2>Transcript</h2>
              {call.transcript?.length ? (
                <div className="chat">{call.transcript.map((t: { speaker: string; text: string }, i: number) => (
                  <div key={i} className={`turn ${t.speaker}`}><div className="who">{t.speaker === "caller" ? "Caller" : t.speaker === "agent" ? "Voice agent" : "Front desk"}</div>{t.text}</div>))}</div>
              ) : <p className="muted">No transcript was provided for this call.</p>}
            </section>
          </div>

          <div className="grid" style={{ alignContent: "start" }}>
            <section className="card">
              <h2>Call</h2>
              <dl className="kv">
                <dt>Started</dt><dd>{fmtDateTime(call.started_at)}{call.after_hours ? " (after-hours)" : ""}</dd>
                <dt>Handled by</dt><dd>{call.handling_mode === "ai" ? "Voice agent" : call.handling_mode === "human" ? "Front desk" : "Nobody (missed)"} <span className="muted small">({call.handling_mode_source ?? "n/a"})</span></dd>
                <dt>Expected route</dt><dd>{call.expected_route === "vaani" ? "Voice agent (after-hours)" : "Front desk (staffed hours)"}</dd>
                <dt>Status</dt><dd>{call.status.replace("_", " ")}{call.end_reason && call.end_reason !== call.status ? ` · ${call.end_reason}` : ""}</dd>
                <dt>Duration</dt><dd>{fmtDuration(call.duration_seconds)}</dd>
                <dt>Response time</dt><dd>{fmtResponse(call.response_seconds)} {call.response_basis !== "none" && <span className="muted small">({call.response_basis})</span>}</dd>
              </dl>
              {calls.length > 1 && <p className="small">Other calls: {calls.map((c) => <Link key={c.id} href={`/leads/${id}?call=${c.id}`} style={{ marginRight: 8, fontWeight: c.id === call.id ? 700 : 400 }}>{fmtDateTime(c.started_at)}</Link>)}</p>}
            </section>

            <section className="card">
              <h2>Booking history</h2>
              {bookings.map((b) => (
                <div key={b.id} style={{ marginBottom: 8 }}><BookingBadge status={b.status} /> {b.start_at ? fmtDateTime(b.start_at) : ""} {b.designer ? `· ${b.designer}` : ""}<br />
                  <span className="muted small mono">{b.provider_booking_uid ?? "no provider event"} · {b.timezone ?? ""}</span>{b.failure_reason && <div className="small">{b.failure_reason}</div>}</div>
              ))}
              {bookings.length === 0 && <p className="muted">No booking.</p>}
              {bookAudit.length > 0 && <details><summary className="small">Booking audit</summary>{bookAudit.map((a) => <div key={a.id} className="small muted">{fmtDateTime(a.at)} · {a.action} · {a.actor}</div>)}</details>}
            </section>

            <section className="card">
              <h2>Override / review</h2>
              <p className="small muted">Current: <OutcomeBadge outcome={lead.effective_outcome} />. Every change needs a reason and is audited.</p>
              <form action={reviewAction}>
                <input type="hidden" name="leadId" value={id} />
                <textarea name="reason" required minLength={5} placeholder="Reason (required)…" />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn small" name="action" value="approve">Approve</button>
                  <button className="btn sec small" name="action" value="keep">Keep under review</button>
                  <button className="btn danger small" name="action" value="decline">Decline</button>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <select name="to" defaultValue="AMBER_REVIEW">{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select>
                  <button className="btn sec small" name="action" value="reclassify">Reclassify to…</button>
                </div>
              </form>
              {overrides.map((o) => <div key={o.id} className="small" style={{ marginTop: 8 }}><b>{o.actor}</b> · {fmtDateTime(o.created_at)}<br />{o.from_outcome} → {o.to_outcome} ({o.action})<br /><i>{o.reason}</i></div>)}
            </section>

            <section className="card">
              <h2>Tasks</h2>
              {tasks.map((t) => (
                <div key={t.id} className="row sp small" style={{ marginBottom: 6 }}>
                  <div>{t.kind.replace("_", " ")} · {t.status}{t.due_at ? ` · due ${fmtDateTime(t.due_at)}` : ""}<br /><span className="muted">{t.notes}</span></div>
                  {t.status === "open" && <form action={completeTaskAction}><input type="hidden" name="taskId" value={t.id} /><button className="btn sec small">Done</button></form>}
                </div>
              ))}
              {tasks.length === 0 && <p className="muted">None.</p>}
            </section>

            <section className="card">
              <h2>Audit trail</h2>
              {audits.map((a) => <div key={a.id} className="small" style={{ marginBottom: 4 }}>{fmtDateTime(a.at)} · <b>{a.action}</b> · {a.actor}{a.reason ? <><br /><span className="muted">{a.reason}</span></> : null}</div>)}
              {audits.length === 0 && <p className="muted">No manual actions yet.</p>}
            </section>
          </div>
        </div>
      )}

      {guidance && (
        <section className="internal" style={{ marginTop: 16 }}>
          <h2>🔒 Internal pricing guidance — not a quote</h2>
          <p className="small"><b>{PRICING_DISCLAIMER}</b></p>
          <div className="tw"><table><thead><tr><th>{guidance.heading}</th><th>Indicative rate</th><th>Arithmetic on stated area</th></tr></thead><tbody>
            {guidance.rows.map((r) => <tr key={r.label}><td>{r.label}</td><td>{r.perSqft}</td><td>{r.total ?? <span className="muted">n/a</span>}</td></tr>)}
          </tbody></table></div>
          {guidance.singleRoom && <p className="small">{guidance.singleRoom}</p>}
          <p className="small">{guidance.note}</p>
          <ul className="small">{AFFECTS_PRICING.map((a) => <li key={a}>{a}</li>)}</ul>
        </section>
      )}
    </>
  );
}
