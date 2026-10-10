import type { Db, FindOpts, Row, TableName } from "./adapter";

/** Unique constraints mirrored from the SQL migration. NULL values never conflict (SQL semantics). */
const UNIQUES: Partial<Record<TableName, string[][]>> = {
  leads: [["phone_e164"]],
  calls: [["provider_call_id"]],
  qualifications: [["call_id", "input_hash"]],
  bookings: [["active_key"]],
  followup_tasks: [["dedupe_key"]],
  jobs: [["key"]],
  webhook_events: [["provider", "event_id"]],
  cost_events: [["call_id", "provider", "kind"]],
};

const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));

export class MemoryDb implements Db {
  readonly kind = "memory" as const;
  private tables = new Map<TableName, Row[]>();

  private t(name: TableName): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  async insert(table: TableName, row: Row) {
    const rows = this.t(table);
    for (const cols of UNIQUES[table] ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (rows.some((r) => cols.every((c) => r[c] === row[c]))) return { row: null, conflict: true };
    }
    const copy = structuredClone(row);
    rows.push(copy);
    return { row: structuredClone(copy), conflict: false };
  }

  async get(table: TableName, id: string) {
    const r = this.t(table).find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }

  async find(table: TableName, where: Record<string, unknown> = {}, opts: FindOpts = {}) {
    let out = this.t(table).filter((r) => matches(r, where)).map((r) => structuredClone(r));
    if (opts.order) {
      const [col, dir] = opts.order;
      out.sort((a, b) => (a[col] === b[col] ? 0 : (a[col] ?? "") > (b[col] ?? "") ? 1 : -1) * (dir === "asc" ? 1 : -1));
    }
    if (opts.limit) out = out.slice(0, opts.limit);
    return out;
  }

  async update(table: TableName, id: string, patch: Row) {
    const r = this.t(table).find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, structuredClone(patch));
    return structuredClone(r);
  }

  async cas(table: TableName, id: string, where: Record<string, unknown>, patch: Row) {
    const r = this.t(table).find((x) => x.id === id);
    if (!r || !matches(r, where)) return null;
    Object.assign(r, structuredClone(patch));
    return structuredClone(r);
  }
}
