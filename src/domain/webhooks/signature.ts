import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export type SigCheck = { ok: true; signed: boolean } | { ok: false; reason: string; status: number };

/**
 * Vaani Labs (vaanilabs.in OpenAPI spec): `X-VaaniVoice-Signature: sha256=<lowercase hex HMAC-SHA256 of the raw body>`,
 * keyed with the `vv_whk_…` secret shown when the webhook is registered. We also accept `x-vaani-signature`, and a custom
 * name via VAANI_SIGNATURE_HEADER.
 */
export function verifyVaaniSignature(rawBody: string, headers: Headers): SigCheck {
  const secret = env.get("VAANI_WEBHOOK_SECRET");
  if (!secret) {
    if (env.allowUnsignedWebhooks()) return { ok: true, signed: false };
    return { ok: false, reason: "VAANI_WEBHOOK_SECRET not configured; refusing unsigned webhooks", status: 503 };
  }
  const names = [env.get("VAANI_SIGNATURE_HEADER"), "x-vaanivoice-signature", "x-vaani-signature"].filter((n): n is string => !!n).map((n) => n.toLowerCase());
  const raw = names.map((n) => headers.get(n)).find((v) => !!v) ?? "";
  const got = raw.replace(/^sha256=/i, "").trim().toLowerCase();
  const want = sign(rawBody, secret);
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid signature", status: 401 };
  return { ok: true, signed: true };
}

/** Constant-time shared-secret check for the voice tool endpoints. */
export function verifyToolSecret(headers: Headers): boolean {
  const secret = env.get("VOICE_TOOL_SECRET");
  if (!secret) return false;
  const got = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || headers.get("x-voice-tool-secret") || "";
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
