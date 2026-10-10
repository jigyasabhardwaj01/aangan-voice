import { handleTool } from "@/voice/route-helpers";
import { LookupBody, lookupTool } from "@/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (req: Request) => handleTool(req, LookupBody, lookupTool);
