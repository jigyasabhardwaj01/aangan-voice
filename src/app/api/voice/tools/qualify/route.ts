import { handleTool } from "@/voice/route-helpers";
import { QualifyBody, qualifyTool } from "@/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (req: Request) => handleTool(req, QualifyBody, qualifyTool);
