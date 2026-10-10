/**
 * Plays Vaani's part of a call against a running deployment, so the whole flow can be tested before Vaani is connected:
 *   lookup_caller → qualify → (availability → book) → signed end-of-call webhook.
 *
 *   npm run simulate -- tests/calls/t01-book.json [baseUrl]
 *
 * Secrets (VOICE_TOOL_SECRET, VAANI_WEBHOOK_SECRET) come from the environment or .env.local. Without
 * VAANI_WEBHOOK_SECRET the webhook step is skipped. Scenario files are in tests/calls/ and hold what Vaani's
 * model would have extracted; `expect` is checked and the script exits non-zero on a mismatch.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const [file, baseArg] = process.argv.slice(2);
if (!file) { console.error("usage: npm run simulate -- <scenario.json> [baseUrl]"); process.exit(1); }

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const base = (baseArg ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const toolSecret = process.env.VOICE_TOOL_SECRET;
const hookSecret = process.env.VAANI_WEBHOOK_SECRET;
if (!toolSecret) { console.error("VOICE_TOOL_SECRET not set"); process.exit(1); }

const s = JSON.parse(readFileSync(file, "utf8")) as {
  name?: string; phone: string; fields: Record<string, unknown>; pick_slot?: number | null; email?: string; duration_sec?: number;
  transcript?: string; expect?: { decision?: string; outcome?: string; booked?: boolean };
};
const callId = `sim-${Date.now()}`;
let failed = false;
const check = (label: string, ok: boolean, detail = "") => { console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`); if (!ok) failed = true; };

async function tool(path: string, body: unknown) {
  const res = await fetch(`${base}/api/voice/tools/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${toolSecret}` }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

console.log(`Simulated call: ${s.name ?? file}  (${s.phone})  →  ${base}\n`);

const who = await tool("lookup-caller", { call_id: callId, phone: s.phone });
console.log(`1. lookup_caller: ${who.known ? `known caller${who.first_name ? ` (${who.first_name})` : ""}` : "new caller"}; today = ${who.today}`);

const q = await tool("qualify", { call_id: callId, fields: s.fields });
console.log(`2. qualify: decision ${q.decision}${q.say ? `\n   agent says: "${q.say}"` : ""}${q.ask ? `\n   agent asks: "${q.ask.question}"` : ""}`);
if (s.expect?.decision) check(`decision is ${s.expect.decision}`, q.decision === s.expect.decision, q.decision);

let booked: boolean | null = null;
if (q.decision === "proceed_to_booking") {
  const a = await tool("availability", { call_id: callId });
  if (a.available) {
    console.log(`3. availability: ${a.slots.map((x: { label: string }) => x.label).join(" | ")}`);
    if (s.pick_slot != null) {
      const slot = a.slots[s.pick_slot] ?? a.slots[0];
      const b = await tool("book", { call_id: callId, slot_id: slot.slot_id, confirmed: true, email: s.email ?? "sim@example.com", name: String(s.fields.caller_name ?? "Simulated Caller") });
      booked = b.status === "confirmed";
      console.log(`4. book: ${b.status}\n   agent says: "${b.say}"`);
    } else console.log("4. book: caller hung up without choosing a slot");
  } else console.log(`3. availability: unavailable (${a.reason})\n   agent says: "${a.say}"`);
}
if (s.expect?.booked !== undefined) check(`booked is ${s.expect.booked}`, booked === s.expect.booked, String(booked));

if (hookSecret) {
  const body = JSON.stringify({
    id: `evt_${callId}`, type: "call.completed", created: Math.floor(Date.now() / 1000),
    data: {
      call_id: callId, from: s.phone, started_at: new Date(Date.now() - (s.duration_sec ?? 180) * 1000).toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: s.duration_sec ?? 180, end_reason: "completed", transcript: s.transcript ?? "", extracted: s.fields,
    },
  });
  const sig = "sha256=" + createHmac("sha256", hookSecret).update(body).digest("hex");
  const w = await fetch(`${base}/api/webhooks/vaani`, { method: "POST", headers: { "Content-Type": "application/json", "X-VaaniVoice-Signature": sig }, body });
  console.log(`5. end-of-call webhook: HTTP ${w.status} ${await w.text()}`);
  check("webhook accepted", w.ok);
} else console.log("5. end-of-call webhook skipped (VAANI_WEBHOOK_SECRET not set)");

console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
