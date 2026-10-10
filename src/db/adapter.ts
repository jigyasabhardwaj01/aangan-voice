/** Minimal storage port. Domain logic is written once against this; Supabase in production, memory in tests/demo. */

export type Row = Record<string, any>;

export type TableName =
  | "leads" | "calls" | "qualifications" | "overrides" | "offered_slots" | "bookings" | "followup_tasks"
  | "jobs" | "webhook_events" | "audit_logs" | "cost_events" | "integration_events";

export interface FindOpts {
  order?: [column: string, dir: "asc" | "desc"];
  limit?: number;
}

export interface Db {
  readonly kind: "supabase" | "memory";
  /** Insert; returns {conflict:true} (not an error) if a unique constraint is violated. */
  insert(table: TableName, row: Row): Promise<{ row: Row | null; conflict: boolean }>;
  get(table: TableName, id: string): Promise<Row | null>;
  /** Equality filters; an array value means IN. */
  find(table: TableName, where?: Record<string, unknown>, opts?: FindOpts): Promise<Row[]>;
  update(table: TableName, id: string, patch: Row): Promise<Row | null>;
  /** Atomic compare-and-set: applies patch only if the row matches `where`. Returns the row or null if no match. */
  cas(table: TableName, id: string, where: Record<string, unknown>, patch: Row): Promise<Row | null>;
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
