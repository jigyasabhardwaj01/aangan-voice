import { requireUser } from "@/auth/session";
import { integrationHealth } from "@/domain/health";
import { Badge, fmtDateTime } from "@/app/ui";

const TONE = { ok: "green", degraded: "red", not_configured: "amber", no_data: "grey" } as const;

export default async function Integrations() {
  await requireUser("owner");
  const h = await integrationHealth();
  return (
    <>
      <h1>Integration health</h1>
      <p className="sub">Live status inferred from real provider calls. “No data” means configured but never exercised, not healthy.</p>
      {h.storage === "memory" && <div className="banner warn">Storage is an in-memory store, not Supabase. Data will not survive a restart.</div>}
      {h.webhook.unsignedAllowed && <div className="banner warn">ALLOW_UNSIGNED_WEBHOOKS is on. Anyone can post fake calls. Turn it off in production.</div>}
      <div className="card tw">
        <table><thead><tr><th>Integration</th><th>Status</th><th>Last success</th><th>Last failure</th><th>Failures (24h)</th><th>Missing configuration</th></tr></thead><tbody>
          {h.integrations.map((i) => (
            <tr key={i.id}><td>{i.label}</td><td><Badge tone={TONE[i.status]}>{i.status.replace("_", " ")}</Badge></td><td>{fmtDateTime(i.lastSuccess)}</td>
              <td>{fmtDateTime(i.lastFailure)}{i.lastFailureDetail && <div className="small muted">{i.lastFailureDetail}</div>}</td><td>{i.failures24h}</td>
              <td className="mono">{i.missing.length ? i.missing.join(", ") : <span className="muted">none</span>}</td></tr>
          ))}
        </tbody></table>
      </div>
      <div className="cols" style={{ marginTop: 14 }}>
        <section className="card"><h2>Webhooks (Vaani)</h2>
          <p>{h.webhook.processed} processed · <b>{h.webhook.failed}</b> failed · <b>{h.webhook.rejected}</b> rejected</p>
          {h.webhook.recentProblems.map((e) => <div key={e.id} className="small"><Badge tone="red">{e.status}</Badge> {fmtDateTime(e.received_at)} · {e.event_type ?? "unrecognised"}<br /><span className="muted">{e.error}</span></div>)}
          {h.webhook.recentProblems.length === 0 && <p className="muted small">No failed webhooks.</p>}
        </section>
        <section className="card"><h2>Outbound jobs (Telegram / HubSpot)</h2>
          <p>{h.jobs.sent} sent · {h.jobs.pending} pending · <b>{h.jobs.blocked}</b> blocked on config · <b>{h.jobs.dead}</b> gave up</p>
          {h.jobs.problems.map((j) => <div key={j.id} className="small"><Badge tone={j.status === "dead" ? "red" : "amber"}>{j.status}</Badge> {j.kind} · attempts {j.attempts}<br /><span className="muted">{j.last_error}</span></div>)}
          {h.jobs.problems.length === 0 && <p className="muted small">Nothing stuck.</p>}
        </section>
      </div>
    </>
  );
}
