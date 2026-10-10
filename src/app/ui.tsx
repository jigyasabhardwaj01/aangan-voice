import type { ReactNode } from "react";
import { env } from "@/lib/env";

const OUTCOME: Record<string, [string, string]> = {
  GREEN_QUALIFIED: ["Qualified", "b-green"], AMBER_REVIEW: ["Needs review", "b-amber"], RED_NOT_QUALIFIED: ["Not qualified", "b-red"],
  URGENT_ESCALATION: ["Urgent", "b-red"], INCOMPLETE: ["Incomplete", "b-grey"],
};
export function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span className="badge b-grey">Unclassified</span>;
  const [label, cls] = OUTCOME[outcome] ?? [outcome, "b-grey"];
  return <span className={`badge ${cls}`} title={outcome}>{label}</span>;
}

const BOOKING: Record<string, string> = { confirmed: "b-green", pending: "b-amber", requested: "b-blue", failed: "b-red", cancelled: "b-grey", rescheduled: "b-blue" };
export const BookingBadge = ({ status }: { status: string | null | undefined }) =>
  status ? <span className={`badge ${BOOKING[status] ?? "b-grey"}`}>{status}</span> : <span className="badge b-grey">none</span>;

export const Badge = ({ children, tone = "grey" }: { children: ReactNode; tone?: "green" | "amber" | "red" | "blue" | "grey" }) => <span className={`badge b-${tone}`}>{children}</span>;

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {note ? <div className="n">{note}</div> : null}
    </div>
  );
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: env.timezone(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}
export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "unknown";
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
export function fmtResponse(s: number | null | undefined): string {
  if (s === null || s === undefined) return "unknown";
  return s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`;
}
export const fmtMoney = (n: number, cur: string) => `${cur === "INR" ? "₹" : cur === "USD" ? "$" : cur + " "}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
