import { env, missingConfig } from "@/lib/env";
import { recordIntegration } from "@/domain/audit";
import { httpJson, ProviderError } from "./http";

export interface GeminiResult {
  text: string;
  promptTokens: number | null;
  outputTokens: number | null;
  model: string;
}

export const geminiModel = () => env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";

/** JSON-mode generation. Output is untrusted: callers must validate against a strict schema. */
export async function generateJson(system: string, user: string): Promise<GeminiResult> {
  const missing = missingConfig("gemini");
  if (missing.length) throw new ProviderError("not_configured", `Gemini not configured: missing ${missing.join(", ")}`);
  const model = geminiModel();
  try {
    const { body } = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.get("GEMINI_API_KEY")!, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
      timeoutMs: 30_000,
    });
    const b = body as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = b.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) throw new ProviderError("invalid_response", "empty Gemini response");
    await recordIntegration("gemini", true, "generate", model);
    return {
      text,
      promptTokens: b.usageMetadata?.promptTokenCount ?? null,
      outputTokens: b.usageMetadata?.candidatesTokenCount ?? null,
      model,
    };
  } catch (e) {
    await recordIntegration("gemini", false, "generate", e instanceof Error ? e.message : String(e));
    throw e;
  }
}
