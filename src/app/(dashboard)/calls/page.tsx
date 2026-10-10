import Link from "next/link";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { Badge, BookingBadge, OutcomeBadge, fmtDateTime, fmtDuration, fmtResponse } from "@/app/ui";

const OUTCOMES = ["GREEN_QUALIFIED", "AMBER_REVIEW", "RED_NOT_QUALIFIED", "URGENT_ESCALATION", "INCOMPLETE"];

export default async function Calls({ searchParams }: { searchParams: Promise<{ q?: string; outcome?: string; booking?: string; handled?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const db = getDb();
  const [calls, leads, bookings] = await Promise.all([db.find("calls", {}, { order: ["started_at", "desc"] }), db.find("leads"), db.find("bookings", {}, { order: ["created_at", "desc"] })]);
  const leadById = Object.fromEntries(leads.map((l) => [l.id, l]));
  const bookingByLead: Record<string, string> = {};
  for (const b of [...bookings].reverse()) bookingByLead[b.lead_id] = b.status;

  const q = (sp.q ?? "").trim().toLowerCase();
  const rows = calls.filter((c) => {
    const l = leadById[c.lead_id];
    const outcome = c.effective_outcome ?? c.system_outcome ?? "UNCLASSIFIED";
    if (sp.outcome && outcome !== sp.outcome) return false;
    if (sp.handled && c.handling_mode !== sp.handled) return false;
    if (sp.booking && (bookingByLead[c.lead_id] ?? "none") !== sp.booking) return false;
    if (!q) return true;
    const hay = [l?.name, l?.phone_e164, c.from_number, c.summary?.requested_scope, c.summary?.location, JSON.stringify(c.transcript ?? "")].join(" ").toLowerCase();
    return hay.includes(q);
  });

  return (
    <>
      <h1>Calls &amp; leads</h1>
      <p className="sub">Search names, numbers, locations and transcript text.</p>
      <form className="row card" style={{ marginBottom: 14 }}>
        <input name="q" placeholder="Search…" defaultValue={sp.q} style={{ flex: "1 1 220px" }} />
        <select name="outcome" defaultValue={sp.outcome ?? ""}><option value="">All outcomes</option>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select>
        <select name="booking" defaultValue={sp.booking ?? ""}><option value="">Any booking</option>{["confirmed", "pending", "requested", "failed", "cancelled", "rescheduled", "none"].map((o) => <option key={o}>{o}</option>)}</select>
        <select name="handled" defaultValue={sp.handled ?? ""}><option value="">Any handler</option><option value="ai">Voice agent</option><option value="human">Front desk</option><option value="none">Nobody</option></select>
        <button className="btn">Filter</button>
      </form>
      <div className="card tw">
        <table>
          <thead><tr><th>Started</th><th>Caller</th><th>Handled by</th><th>Status</th><th>Duration</th><th>Response</th><th>Outcome</th><th>Booking</th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const l = leadById[c.lead_id];
              return (
                <tr key={c.id}>
                  <td>{fmtDateTime(c.started_at)}{c.after_hours && <> <Badge tone="blue">after-hours</Badge></>}{c.source === "demo" && <> <Badge>demo</Badge></>}</td>
                  <td><Link href={`/leads/${c.lead_id}`}>{l?.name ?? "Unknown caller"}</Link><br /><span className="muted small">{l?.phone_e164 ?? c.from_number ?? "number withheld"}</span></td>
                  <td>{c.handling_mode === "none" ? "nobody" : c.handling_mode === "ai" ? "Voice agent" : "Front desk"}{c.handling_mode_source === "inferred" && c.handling_mode !== "none" ? <span className="muted small"> (inferred)</span> : null}</td>
                  <td>{c.status.replace("_", " ")}</td>
                  <td>{fmtDuration(c.duration_seconds)}</td>
                  <td>{fmtResponse(c.response_seconds)}</td>
                  <td><OutcomeBadge outcome={c.effective_outcome ?? c.system_outcome} />{c.effective_outcome !== c.system_outcome && c.system_outcome ? <span className="muted small"> overridden</span> : null}</td>
                  <td><BookingBadge status={bookingByLead[c.lead_id]} /></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">No calls match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">{rows.length} of {calls.length} calls. “unknown” means the provider did not report the value; it is never shown as zero.</p>
    </>
  );
}
