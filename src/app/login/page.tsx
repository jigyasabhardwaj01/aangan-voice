import { missingConfig } from "@/lib/env";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const missing = missingConfig("dashboard");
  return (
    <div className="login">
      <h1>Aangan Studio</h1>
      <p className="sub">Voice enquiries — designer sign-in</p>
      {missing.length > 0 && <div className="banner err">Sign-in is not configured. Missing: {missing.join(", ")}</div>}
      {error && <div className="banner err">{error === "locked" ? "Too many attempts. Try again in 15 minutes." : "Incorrect email or password."}</div>}
      <form action={login} className="card">
        <label>Email<br /><input name="email" type="email" required autoComplete="username" style={{ width: "100%" }} /></label>
        <label>Password<br /><input name="password" type="password" required autoComplete="current-password" style={{ width: "100%" }} /></label>
        <button className="btn" type="submit">Sign in</button>
      </form>
    </div>
  );
}
