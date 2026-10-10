import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Db, FindOpts, Row, TableName } from "./adapter";

type Q = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

function applyWhere<T extends Q>(q: T, where: Record<string, unknown>): T {
  let query = q;
  for (const [k, v] of Object.entries(where)) {
    query = (Array.isArray(v) ? query.in(k, v) : v === null ? query.is(k, null) : query.eq(k, v as never)) as T;
  }
  return query;
}

export class SupabaseDb implements Db {
  readonly kind = "supabase" as const;
  private client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async insert(table: TableName, row: Row) {
    const { data, error } = await this.client.from(table).insert(row).select().single();
    if (error) {
      if (error.code === "23505") return { row: null, conflict: true };
      throw new Error(`supabase insert ${table}: ${error.message}`);
    }
    return { row: data as Row, conflict: false };
  }

  async get(table: TableName, id: string) {
    const { data, error } = await this.client.from(table).select().eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase get ${table}: ${error.message}`);
    return (data as Row) ?? null;
  }

  async find(table: TableName, where: Record<string, unknown> = {}, opts: FindOpts = {}) {
    let q = applyWhere(this.client.from(table).select(), where);
    if (opts.order) q = q.order(opts.order[0], { ascending: opts.order[1] === "asc" });
    q = q.limit(opts.limit ?? 5000);
    const { data, error } = await q;
    if (error) throw new Error(`supabase find ${table}: ${error.message}`);
    return (data as Row[]) ?? [];
  }

  async update(table: TableName, id: string, patch: Row) {
    const { data, error } = await this.client.from(table).update(patch).eq("id", id).select().maybeSingle();
    if (error) throw new Error(`supabase update ${table}: ${error.message}`);
    return (data as Row) ?? null;
  }

  async cas(table: TableName, id: string, where: Record<string, unknown>, patch: Row) {
    const q = applyWhere(this.client.from(table).update(patch).eq("id", id) as unknown as Q, where);
    const { data, error } = await (q as unknown as { select(): Promise<{ data: Row[] | null; error: { message: string } | null }> }).select();
    if (error) throw new Error(`supabase cas ${table}: ${error.message}`);
    return data && data.length > 0 ? data[0] : null;
  }
}
