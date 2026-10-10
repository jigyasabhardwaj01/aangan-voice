import "server-only";
import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";

export type Role = "owner" | "designer";
export interface SessionUser { email: string; role: Role }

const COOKIE = "aangan_session";
const TTL_S = 12 * 3600;

interface ConfiguredUser { email: string; role: Role; hash: string }

function configuredUsers(): ConfiguredUser[] {
  try {
    const raw = JSON.parse(env.get("DASHBOARD_USERS") ?? "[]");
    return Array.isArray(raw) ? raw.filter((u) => u?.email && u?.hash && (u.role === "owner" || u.role === "designer")) : [];
  } catch {
    return [];
  }
}

/** Hash format: scrypt:<saltHex>:<keyHex>. Generate with `npm run hash-password`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const derived = scryptSync(password, Buffer.from(salt, "hex"), 64);
  const want = Buffer.from(key, "hex");
  return derived.length === want.length && timingSafeEqual(derived, want);
}

const secret = () => {
  const s = env.get("SESSION_SECRET");
  if (!s || s.length < 16) throw new Error("SESSION_SECRET missing or too short (min 16 chars)");
  return s;
};
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mac = (data: string) => createHmac("sha256", secret()).update(data).digest("base64url");

export function authenticate(email: string, password: string): SessionUser | null {
  const u = configuredUsers().find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  // Verify against a dummy hash when the user is unknown, so timing does not reveal valid emails.
  const ok = verifyPassword(password, u?.hash ?? "scrypt:00:00");
  return u && ok ? { email: u.email, role: u.role } : null;
}

export async function startSession(user: SessionUser) {
  const payload = b64(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + TTL_S }));
  (await cookies()).set(COOKIE, `${payload}.${mac(payload)}`, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TTL_S,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function currentUser(): Promise<SessionUser | null> {
  if (!env.get("SESSION_SECRET")) return null;
  const v = (await cookies()).get(COOKIE)?.value;
  if (!v) return null;
  const [payload, sig] = v.split(".");
  if (!payload || !sig) return null;
  const want = mac(payload);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (p.exp < Date.now() / 1000) return null;
    return { email: p.email, role: p.role };
  } catch {
    return null;
  }
}

/** Gate for server components and actions. Owners may do everything; designers are limited to lead work. */
export async function requireUser(role?: Role): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  if (role && u.role !== role && u.role !== "owner") redirect("/?denied=1");
  return u;
}
