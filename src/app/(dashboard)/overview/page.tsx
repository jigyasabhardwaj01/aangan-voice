import Link from "next/link";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { computeMetrics } from "@/domain/metrics";
import { Badge, OutcomeBadge, Stat, fmtDateTime, fmtMoney, fmtResponse } from "@/app/ui";
import { completeTaskAction } from "../actions";

export default async function Overview({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const m = await computeMetrics();
  const calls = (await getDb().find("calls", {}, { order: ["started_at", "desc"], limit: 8 }));
  const leads = Object.fromEntries((await getDb().find("leads")).map((l) => [l.id, l]));
  const tasks = (await getDb().find("followup_tasks", { status: "open" }, { order: ["created_at", "asc"] })).filter((t) => t.kind !== "review").slice(0, 8);
  const r = m.response;
  const answeredKnown = r.met + r.notMet;
  const costTotals = m.costPerCurrency;

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">Every enquiry call, whether the front desk or the voice agent took it.</p>
      {sp.denied && <div className="banner err">That page is for the studio owner.</div>}

      <div className="grid stats">
        <Stat label="Total calls" value={m.totals.calls} note={`${m.totals.aiHandled} AI · ${m.totals.humanHandled} front desk`} />
        <Stat label="After-hours calls" value={m.totals.afterHours} note="outside staffed hours" />
        <Stat label={`Answered within ${Math.round(r.targetSeconds / 60)} min`} value={answeredKnown ? `${r.met} of ${answeredKnown}` : "unknown"}
          note={`${r.notMet} missed the target · ${r.unknown} with no timing data${r.medianSeconds !== null ? ` · median ${fmtResponse(r.medianSeconds)}` : ""}`} />
        <Stat label="Missed calls" value={m.totals.missed} note={`${m.totals.disconnected} disconnected · ${m.totals.failed} failed`} />
        <Stat label="Qualified leads" value={m.qualification.qualifiedLeads} note={`qualification rate ${m.qualification.qualificationRate === null ? "n/a" : Math.round(m.qualification.qualificationRate * 100) + "% of calls"}`} />
        <Stat label="Confirmed bookings" value={m.bookings.byStatus.confirmed ?? 0} note={`${(m.bookings.byStatus.pending ?? 0) + (m.bookings.byStatus.requested ?? 0)} pending · ${m.bookings.byStatus.failed ?? 0} failed`} />
        <Stat label="Review queue" value={<Link href="/review">{m.reviewQueue}</Link>} note={`${m.overdueTasks} follow-ups overdue`} />
        {user.role === "owner" && (
          <Stat label="Operating costs"
            value={costTotals.length ? costTotals.map((c) => fmtMoney(c.total, c.currency)).join(" + ") : "unknown"}
            note={costTotals.length ? `measured ${costTotals.map((c) => fmtMoney(c.measured, c.currency)).join("/")} · estimated ${costTotals.map((c) => fmtMoney(c.estimated, c.currency)).join("/")} · ${m.cost.linesUnknown} lines unknown` : `no cost data yet (${m.cost.linesUnknown} lines unknown)`} />
        )}
      </div>
      {m.totals.pricingViolations > 0 && <div className="banner err" style={{ marginTop: 14 }}><b>{m.totals.pricingViolations} call(s)</b> may have quoted a price on the studio side. Review the transcripts.</div>}

      <div className="cols" style={{ marginTop: 18 }}>
        <section className="card">
          <div className="row sp"><h2>Recent calls</h2><Link href="/calls" className="small">All calls →</Link></div>
          <div className="tw"><table>
            <thead><tr><th>When</th><th>Caller</th><th>Handled by</th><th>Outcome</th></tr></thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>{fmtDateTime(c.started_at)}{c.after_hours && <> <Badge tone="blue">after-hours</Badge></>}</td>
                  <td><Link href={`/leads/${c.lead_id}`}>{leads[c.lead_id]?.name ?? c.from_number ?? "Unknown caller"}</Link></td>
                  <td>{c.handling_mode === "none" ? "nobody (missed)" : c.handling_mode === "ai" ? "Voice agent" : "Front desk"}</td>
                  <td><OutcomeBadge outcome={c.effective_outcome ?? c.system_outcome} /></td>
                </tr>
              ))}
              {calls.length === 0 && <tr><td colSpan={4} className="muted">No calls yet.</td></tr>}
            </tbody>
          </table></div>
        </section>
        <section className="card">
          <h2>Open follow-ups</h2>
          {tasks.map((t) => (
            <div key={t.id} className="row sp" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              <div><b>{t.kind.replace("_", " ")}</b>{t.due_at && <span className={Date.parse(t.due_at) < Date.now() ? "badge b-red" : "muted small"}> due {fmtDateTime(t.due_at)}</span>}<br />
                <span className="small muted">{t.notes}</span>{t.lead_id && <> · <Link className="small" href={`/leads/${t.lead_id}`}>open lead</Link></>}</div>
              <form action={completeTaskAction}><input type="hidden" name="taskId" value={t.id} /><button className="btn sec small">Done</button></form>
            </div>
          ))}
          {tasks.length === 0 && <p className="muted">Nothing outstanding.</p>}
        </section>
      </div>
    </>
  );
}
