import { decideRoute } from "@/domain/routing";
import { verifyToolSecret } from "@/domain/webhooks/signature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Telephony asks "who should answer right now?" — front desk during staffed hours, Vaani otherwise. */
export async function GET(req: Request) {
  if (!verifyToolSecret(req.headers)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const route = decideRoute(new Date());
  return Response.json({ route, after_hours: route === "vaani" });
}
