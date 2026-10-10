import { z } from "zod";
import { verifyToolSecret } from "@/domain/webhooks/signature";

/** Shared wrapper: authenticates the Vaani tool call, validates the body, and never leaks internals in errors. */
export async function handleTool<S extends z.ZodTypeAny, R>(req: Request, schema: S, fn: (body: z.infer<S>) => Promise<R>): Promise<Response> {
  if (!verifyToolSecret(req.headers)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "invalid request", detail: parsed.error.issues[0]?.message }, { status: 400 });
  try {
    return Response.json(await fn(parsed.data));
  } catch (e) {
    console.error("voice tool error", e);
    // Safe fallback sentence so the agent can keep the caller informed without inventing anything.
    return Response.json({ error: "temporary_failure", say: "I'm having a little trouble on my side. I've noted your details and a designer will call you back shortly." }, { status: 500 });
  }
}
