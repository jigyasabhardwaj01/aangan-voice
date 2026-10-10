import { handleTool } from "@/voice/route-helpers";
import { BookBody, bookTool } from "@/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (req: Request) => handleTool(req, BookBody, bookTool);
