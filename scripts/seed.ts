import { seedDemo } from "../src/demo/seed";
import { getDb } from "../src/db";

if (getDb().kind !== "supabase") {
  console.error("Refusing to seed: Supabase is not configured (this would only fill a throwaway in-memory store).");
  process.exit(1);
}
console.log(`Seeding demo calls (source "demo") into Supabase…`);
console.log(`Replayed ${await seedDemo()} September-2026 phone calls.`);
