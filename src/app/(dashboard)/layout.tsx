import Link from "next/link";
import { logout } from "@/app/login/actions";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { env } from "@/lib/env";
import { ensureDemoSeed } from "@/demo/seed";
import { computeMetrics } from "@/domain/metrics";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (env.demoMode() && getDb().kind === "memory") await ensureDemoSeed();
  const m = await computeMetrics();
  const links: [string, string, string?][] = [
    ["/overview", "Overview"], ["/calls", "Calls & leads"], ["/review", "Review queue", m.reviewQueue ? String(m.reviewQueue) : undefined],
    ["/bookings", "Bookings"], ["/analytics", "Analytics"], ...(user.role === "owner" ? ([["/integrations", "Integration health"]] as [string, string][]) : []),
  ];
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Aangan Studio<small>Voice enquiries</small></div>
        {links.map(([href, label, badge]) => (
          <Link key={href} href={href} className="nav"><span>{label}</span>{badge && <span className="badge b-amber">{badge}</span>}</Link>
        ))}
        <div className="who">
          {user.email}<br />{user.role}
          <form action={logout}><button className="btn sec small" style={{ marginTop: 6 }}>Sign out</button></form>
        </div>
      </aside>
      <main>
        {getDb().kind === "memory" && (
          <div className="banner warn">
            <b>{env.demoMode() ? "DEMO MODE" : "Supabase is not configured"}:</b>{" "}
            {env.demoMode() ? "showing the 20 anonymised September phone calls replayed through the real pipeline. Nothing here is live data. " : "data is held in temporary server memory and will be lost on restart. "}
            Storage is an ephemeral in-memory store.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
