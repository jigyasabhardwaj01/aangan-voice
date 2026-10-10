import { ingestVaani } from "@/domain/webhooks/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const raw = await req.text(); // raw body is needed for signature verification
  const r = await ingestVaani(raw, req.headers);
  return Response.json(r.body, { status: r.status });
}
