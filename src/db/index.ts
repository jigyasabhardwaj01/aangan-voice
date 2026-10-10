import type { Db } from "./adapter";
import { MemoryDb } from "./memory";
import { SupabaseDb } from "./supabase";
import { env } from "@/lib/env";

const g = globalThis as unknown as { __aanganDb?: Db | null };

/** Supabase when configured; otherwise an ephemeral in-memory store (surfaced loudly on the dashboard). */
export function getDb(): Db {
  if (g.__aanganDb) return g.__aanganDb;
  const url = env.get("SUPABASE_URL");
  const key = env.get("SUPABASE_SERVICE_ROLE_KEY");
  g.__aanganDb = url && key ? new SupabaseDb(url, key) : new MemoryDb();
  return g.__aanganDb;
}

/** Test hook. */
export function setDb(db: Db | null) {
  g.__aanganDb = db;
}

export function freshMemoryDb(): Db {
  return new MemoryDb();
}
