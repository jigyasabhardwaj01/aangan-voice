import { getDb } from "@/db";
import type { Row } from "@/db/adapter";
import { env } from "@/lib/env";

const effective = (c: Row) => (c.effective_outcome ?? c.system_outcome) as string | null;
const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: env.timezone() }).format(new Date(iso));

export interface CostSummary {
  /** Totals per currency, measured and estimated kept separate. Currencies are never mixed. */
  byCurrency: Record<string, { measured: number; estimated: number }>;
  linesMeasured: number;
  linesEstimated: number;
  linesUnknown: number;
  callsWithCost: number;
  callsTotal: number;
}

export async function loadAll() {
  const db = getDb();
  const [calls, leads, bookings, costs, tasks] = await Promise.all([
    db.find("calls", {}, { order: ["started_at", "desc"] }),
    db.find("leads", {}),
    db.find("bookings", {}, { order: ["created_at", "desc"] }),
    db.find("cost_events", {}),
    db.find("followup_tasks", {}),
  ]);
  return { calls, leads, bookings, costs, tasks };
}

export async function computeMetrics(now = new Date()) {
  const { calls, leads, bookings, costs, tasks } = await loadAll();
  const target = env.responseTargetSeconds();

  let met = 0, notMet = 0, unknown = 0;
  const known: number[] = [];
  for (const c of calls) {
    if (c.response_seconds !== null && c.response_seconds !== undefined) {
      known.push(c.response_seconds);
      c.response_seconds <= target ? met++ : notMet++;
    } else if (["missed", "disconnected", "failed"].includes(c.status) && now.getTime() - Date.parse(c.started_at) > target * 1000) {
      notMet++; // never answered/called back within the target: a known miss, not an unknown
    } else unknown++;
  }
  known.sort((a, b) => a - b);

  const qualifiedCalls = calls.filter((c) => effective(c) === "GREEN_QUALIFIED");
  const leadsQualified = leads.filter((l) => l.effective_outcome === "GREEN_QUALIFIED");
  const reviewQueue = leads.filter((l) => l.effective_outcome === "AMBER_REVIEW" && l.review_status === "pending");
  const confirmed = bookings.filter((b) => b.status === "confirmed");

  const byOutcome: Record<string, number> = {};
  for (const c of calls) byOutcome[effective(c) ?? "UNCLASSIFIED"] = (byOutcome[effective(c) ?? "UNCLASSIFIED"] ?? 0) + 1;
  const byBooking: Record<string, number> = {};
  for (const b of bookings) byBooking[b.status] = (byBooking[b.status] ?? 0) + 1;

  const perDay = new Map<string, { total: number; afterHours: number }>();
  for (const c of calls) {
    if (!c.started_at) continue;
    const k = dayKey(c.started_at);
    const d = perDay.get(k) ?? { total: 0, afterHours: 0 };
    d.total++;
    if (c.after_hours) d.afterHours++;
    perDay.set(k, d);
  }

  const cost: CostSummary = { byCurrency: {}, linesMeasured: 0, linesEstimated: 0, linesUnknown: 0, callsWithCost: 0, callsTotal: calls.length };
  const callsWithCost = new Set<string>();
  for (const l of costs) {
    if (l.basis === "unknown" || l.amount === null) { cost.linesUnknown++; continue; }
    const cur = l.currency ?? "UNKNOWN";
    cost.byCurrency[cur] ??= { measured: 0, estimated: 0 };
    cost.byCurrency[cur][l.basis as "measured" | "estimated"] += Number(l.amount);
    l.basis === "measured" ? cost.linesMeasured++ : cost.linesEstimated++;
    callsWithCost.add(l.call_id);
  }
  cost.callsWithCost = callsWithCost.size;

  const qualifiedCount = leadsQualified.length;
  const bookedLeads = new Set(confirmed.map((b) => b.lead_id)).size;
  const perCurrency = Object.entries(cost.byCurrency).map(([currency, v]) => {
    const total = v.measured + v.estimated;
    return {
      currency, measured: v.measured, estimated: v.estimated, total,
      perQualifiedLead: qualifiedCount > 0 ? total / qualifiedCount : null,
      perBookedConsultation: bookedLeads > 0 ? total / bookedLeads : null,
    };
  });

  const ended = calls.filter((c) => c.status !== "in_progress");
  return {
    totals: {
      calls: calls.length,
      afterHours: calls.filter((c) => c.after_hours).length,
      missed: calls.filter((c) => c.status === "missed").length,
      disconnected: calls.filter((c) => c.status === "disconnected").length,
      failed: calls.filter((c) => c.status === "failed").length,
      aiHandled: calls.filter((c) => c.handling_mode === "ai").length,
      humanHandled: calls.filter((c) => c.handling_mode === "human").length,
      pricingViolations: calls.filter((c) => c.pricing_violation).length,
    },
    response: {
      targetSeconds: target, met, notMet, unknown,
      medianSeconds: known.length ? known[Math.floor(known.length / 2)] : null,
    },
    qualification: {
      qualifiedLeads: qualifiedCount,
      byOutcome,
      // rate over classified calls only; null when nothing is classified (never shown as 0%)
      qualificationRate: ended.length ? qualifiedCalls.length / ended.length : null,
    },
    bookings: {
      byStatus: byBooking,
      confirmedLeads: bookedLeads,
      // booked share of qualified leads; null when there are no qualified leads
      bookingRate: qualifiedCount ? bookedLeads / qualifiedCount : null,
    },
    reviewQueue: reviewQueue.length,
    openTasks: tasks.filter((t) => t.status === "open").length,
    overdueTasks: tasks.filter((t) => t.status === "open" && t.due_at && Date.parse(t.due_at) < now.getTime()).length,
    perDay: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([day, v]) => ({ day, ...v })),
    cost, costPerCurrency: perCurrency,
    // No CRM won/lost data is ingested, so revenue and conversion-to-project are unknown by design.
    revenue: null as null,
  };
}
