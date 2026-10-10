import { requireUser } from "@/auth/session";
import { computeMetrics } from "@/domain/metrics";
import { Badge, Stat, fmtMoney, fmtResponse, pct } from "@/app/ui";

export default async function Analytics() {
  const user = await requireUser();
  const m = await computeMetrics();
  const max = Math.max(1, ...m.perDay.map((d) => d.total));
  const r = m.response;
  const known = r.met + r.notMet;

  return (
    <>
      <h1>Analytics</h1>
      <p className="sub">Only what was actually measured. Missing data is shown as “unknown”, never as zero.</p>

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Call volume (last 30 days)</h2>
        <div className="bars" aria-label="Calls per day">{m.perDay.map((d) => <div key={d.day} title={`${d.day}: ${d.total} calls, ${d.afterHours} after-hours`} style={{ height: `${(d.total / max) * 100}%` }}><i style={{ height: `${(d.afterHours / d.total) * 100}%` }} /></div>)}</div>
        <p className="muted small">Bar = all calls; blue portion = after-hours. {m.perDay.length === 0 && "No calls yet."}</p>
      </section>

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Within-target response" value={known ? pct(r.met / known) : "unknown"} note={`${r.met} met · ${r.notMet} missed · ${r.unknown} unknown (target ${Math.round(r.targetSeconds / 60)} min)`} />
        <Stat label="Median response time" value={fmtResponse(r.medianSeconds)} note="only calls with a recorded timestamp" />
        <Stat label="Qualification rate" value={pct(m.qualification.qualificationRate)} note="qualified ÷ finished calls" />
        <Stat label="Booking rate" value={pct(m.bookings.bookingRate)} note={`${m.bookings.confirmedLeads} booked of ${m.qualification.qualifiedLeads} qualified leads`} />
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Outcomes</h2>
        <div className="row">{Object.entries(m.qualification.byOutcome).map(([k, v]) => <Badge key={k} tone={k.startsWith("GREEN") ? "green" : k.startsWith("AMBER") ? "amber" : k.startsWith("RED") || k.startsWith("URGENT") ? "red" : "grey"}>{k.replace(/_/g, " ").toLowerCase()}: {v}</Badge>)}</div>
      </section>

      {user.role === "owner" ? (
        <section className="card">
          <h2>Provider costs</h2>
          {m.costPerCurrency.length === 0 ? <p><b>Unknown.</b> No provider cost data has been reported or estimated yet ({m.cost.linesUnknown} cost lines have no amount).</p> : (
            <div className="tw"><table><thead><tr><th>Currency</th><th>Measured</th><th>Estimated</th><th>Total</th><th>Per qualified lead</th><th>Per booked consultation</th></tr></thead><tbody>
              {m.costPerCurrency.map((c) => <tr key={c.currency}><td>{c.currency}</td><td>{fmtMoney(c.measured, c.currency)}</td><td>{fmtMoney(c.estimated, c.currency)}</td><td>{fmtMoney(c.total, c.currency)}</td>
                <td>{c.perQualifiedLead === null ? "n/a (no qualified leads)" : fmtMoney(c.perQualifiedLead, c.currency)}</td><td>{c.perBookedConsultation === null ? "n/a (no confirmed bookings)" : fmtMoney(c.perBookedConsultation, c.currency)}</td></tr>)}
            </tbody></table></div>
          )}
          <ul className="small muted">
            <li><b>Measured</b> = reported by the provider ({m.cost.linesMeasured} lines). <b>Estimated</b> = our configured rate × usage ({m.cost.linesEstimated} lines). <b>Unknown</b> = no figure ({m.cost.linesUnknown} lines).</li>
            <li>Cost data covers {m.cost.callsWithCost} of {m.cost.callsTotal} calls, so ratios understate true cost wherever lines are unknown. Currencies are never mixed.</li>
            <li>Not tracked: Cal.com, HubSpot, Telegram, Supabase and Vercel plan fees (fixed subscriptions, not per call).</li>
            <li>Revenue and conversion-to-project are <b>unknown</b>: no CRM won/lost outcomes are ingested, so none are shown.</li>
          </ul>
        </section>
      ) : <div className="card muted">Cost analytics are visible to the studio owner.</div>}
    </>
  );
}
