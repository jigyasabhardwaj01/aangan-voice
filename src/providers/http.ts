export type ProviderErrorKind = "not_configured" | "http" | "timeout" | "network" | "invalid_response";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
  /** After a timeout/network error on a write, the provider may or may not have acted. */
  get outcomeUnknown() {
    return this.kind === "timeout" || this.kind === "network";
  }
}

export async function httpJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) throw new ProviderError("http", `HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(0, 400), res.status);
    return { status: res.status, body };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e instanceof Error && e.name === "AbortError") throw new ProviderError("timeout", "request timed out");
    throw new ProviderError("network", e instanceof Error ? e.message : "network error");
  } finally {
    clearTimeout(timer);
  }
}
