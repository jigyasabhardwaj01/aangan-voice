import Link from "next/link";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { BookingBadge, fmtDateTime } from "@/app/ui";
import { bookingStatusAction } from "../actions";

const STATUSES = ["confirmed", "pending", "requested", "failed", "cancelled", "rescheduled"];

export default async function Bookings({ searchParams }: { searchParams: Promise<{ status?: string; error?: string; saved?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const db = getDb();
  const all = await db.find("bookings", {}, { order: ["created_at", "desc"] });
  const leads = Object.fromEntries((await db.find("leads")).map((l) => [l.id, l]));
  const rows = sp.status ? all.filter((b) => b.status === sp.status) : all;
  const count = (s: string) => all.filter((b) => b.status === s).length;

  return (
    <>
      <h1>Bookings</h1>
      <p className="sub">A booking is “confirmed” only after Cal.com confirmed the event. Everything else is pending or failed, with a follow-up task.</p>
      {sp.error && <div className="banner err">{sp.error}</div>}
      {sp.saved && <div className="banner ok">Saved.</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <Link href="/bookings" className={`badge ${!sp.status ? "b-blue" : "b-grey"}`}>All {all.length}</Link>
        {STATUSES.map((s) => <Link key={s} href={`/bookings?status=${s}`} className={`badge ${sp.status === s ? "b-blue" : "b-grey"}`}>{s} {count(s)}</Link>)}
      </div>
      <div className="card tw"><table>
        <thead><tr><th>Lead</th><th>Status</th><th>Consultation</th><th>Designer</th><th>Event ID</th><th>Notes</th><th /></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td><Link href={`/leads/${b.lead_id}`}>{leads[b.lead_id]?.name ?? leads[b.lead_id]?.phone_e164 ?? "Unknown"}</Link></td>
              <td><BookingBadge status={b.status} /></td>
              <td>{b.start_at ? fmtDateTime(b.start_at) : "—"}{b.end_at ? ` – ${new Intl.DateTimeFormat("en-IN", { timeZone: b.timezone ?? "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(b.end_at))}` : ""}<br /><span className="muted small">{b.timezone}</span></td>
              <td>{b.designer ?? <span className="muted">not recorded</span>}</td>
              <td className="mono">{b.provider_booking_uid ?? "—"}</td>
              <td className="small">{b.failure_reason ?? ""}</td>
              <td>{b.status === "confirmed" && (
                <form action={bookingStatusAction} className="row">
                  <input type="hidden" name="bookingId" value={b.id} />
                  <input name="reason" placeholder="Reason" required minLength={5} style={{ width: 120 }} />
                  <button className="btn sec small" name="status" value="cancelled">Mark cancelled</button>
                  <button className="btn sec small" name="status" value="rescheduled">Mark rescheduled</button>
                </form>)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">No bookings.</td></tr>}
        </tbody></table></div>
      <p className="muted small">Cancelling or rescheduling here records the change for the team; make the change itself in Cal.com so the designer’s calendar matches.</p>
    </>
  );
}
