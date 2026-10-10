/** In DEMO_MODE with the in-memory store, replay the demo calls once at server start so every page sees them. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DEMO_MODE !== "true") return;
  const { getDb } = await import("@/db");
  if (getDb().kind !== "memory") return;
  const { ensureDemoSeed } = await import("@/demo/seed");
  await ensureDemoSeed();
}
