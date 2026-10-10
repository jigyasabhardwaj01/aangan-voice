"use server";
import { redirect } from "next/navigation";
import { authenticate, endSession, startSession } from "@/auth/session";

const attempts = new Map<string, { n: number; at: number }>();

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const key = email.toLowerCase();
  const a = attempts.get(key);
  if (a && a.n >= 5 && Date.now() - a.at < 15 * 60_000) redirect("/login?error=locked");
  const user = authenticate(email, String(formData.get("password") ?? ""));
  if (!user) {
    attempts.set(key, { n: (a && Date.now() - a.at < 15 * 60_000 ? a.n : 0) + 1, at: Date.now() });
    redirect("/login?error=invalid");
  }
  attempts.delete(key);
  await startSession(user);
  redirect("/overview");
}

export async function logout() {
  await endSession();
  redirect("/login");
}
