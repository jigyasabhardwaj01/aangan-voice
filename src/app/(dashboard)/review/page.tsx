import Link from "next/link";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { Badge, OutcomeBadge, fmtDateTime } from "@/app/ui";
import { completeTaskAction, reviewAction } from "../actions";

export default async function Review({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const db = getDb();
  const leads = (await db.find("leads", { review_status: "pending", effective_outcome: "AMBER_REVIEW" })).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const calls = Object.fromEntries((await db.find("calls", { id: leads.map((l) => l.last_call_id) })).map((c) => [c.id, c]));
  const kept = await db.find("leads", { review_status: "kept" });
  const tasks = (await db.find("followup_tasks", { status: "open" }, { order: ["due_at", "asc"] })).filter((t) => t.kind !== "review");

  return (
    <>
      <h1>Review queue</h1>
      <p className="sub">Uncertain leads are never auto-rejected. A reason is required for every decision and is recorded in the audit trail.</p>
      {sp.error && <div className="banner err">{sp.error}</div>}
      {sp.saved && <div className="banner ok">Decision recorded.</div>}
      {leads.length === 0 && <div className="card muted">Nothing waiting for review.</div>}
      {leads.map((l) => {
        const c = calls[l.last_call_id];
        const unclear = (c?.evaluation?.criteria ?? []).filter((x: { status: string }) => x.status !== "pass");
        return (
          <section key={l.id} className="card" style={{ marginBottom: 12 }}>
            <div className="row sp">
              <div><h2 style={{ margin: 0 }}><Link href={`/leads/${l.id}`}>{l.name ?? l.phone_e164 ?? "Unknown caller"}</Link></h2>
                <span className="muted small">{fmtDateTime(c?.started_at)} · {c?.summary?.location ?? "location unknown"} · {c?.summary?.project_type ?? ""}</span></div>
              <OutcomeBadge outcome={l.effective_outcome} />
            </div>
            <ul className="small">
              {unclear.map((x: { id: number; name: string; reason: string }) => <li key={x.id}><b>{x.id}. {x.name}:</b> {x.reason}</li>)}
              {(l.flags ?? []).length > 0 && <li className="muted">{(l.flags as string[]).join(" · ")}</li>}
            </ul>
            <form action={reviewAction}>
              <input type="hidden" name="leadId" value={l.id} /><input type="hidden" name="back" value="/review" />
              <textarea name="reason" required minLength={5} placeholder="Reason for this decision (required)…" />
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" name="action" value="approve">Approve — qualified</button>
                <button className="btn sec" name="action" value="keep">Keep under review</button>
                <button className="btn danger" name="action" value="decline">Decline</button>
              </div>
            </form>
          </section>
        );
      })}

      {kept.length > 0 && <section className="card" style={{ marginBottom: 12 }}><h2>Kept under review</h2>{kept.map((l) => <div key={l.id}><Link href={`/leads/${l.id}`}>{l.name ?? l.phone_e164}</Link> <Badge tone="amber">kept</Badge></div>)}</section>}

      <section className="card">
        <h2>Follow-up tasks</h2>
        <div className="tw"><table><thead><tr><th>Task</th><th>Due</th><th>Notes</th><th /></tr></thead><tbody>
          {tasks.map((t) => (
            <tr key={t.id}><td>{t.kind.replace("_", " ")}{t.lead_id && <> · <Link href={`/leads/${t.lead_id}`}>lead</Link></>}</td>
              <td>{t.due_at ? <span className={Date.parse(t.due_at) < Date.now() ? "badge b-red" : ""}>{fmtDateTime(t.due_at)}</span> : "—"}</td><td className="small">{t.notes}</td>
              <td><form action={completeTaskAction}><input type="hidden" name="taskId" value={t.id} /><button className="btn sec small">Mark done</button></form></td></tr>
          ))}
          {tasks.length === 0 && <tr><td colSpan={4} className="muted">No open tasks.</td></tr>}
        </tbody></table></div>
        <p className="muted small">Completing a “callback” task records the callback time as the response time for that missed call.</p>
      </section>
    </>
  );
}
