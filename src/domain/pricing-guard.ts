/**
 * Pricing isolation helpers. Caller-facing text must never contain a price, rate, range,
 * estimate or calculated total. These patterns are deliberately broad (false positives are
 * acceptable; a missed price is not).
 */

export const APPROVED_PRICING_RESPONSE =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

const PATTERNS: RegExp[] = [
  /₹\s*\d/,
  /\brs\.?\s*\d/i,
  /\binr\s*\d/i,
  /\d[\d,.]*\s*(lakhs?|lacs?|crores?|cr\b|k\b|thousand)/i,
  /\b(lakhs?|lacs?|crores?)\b/i,
  /\d\s*(\/|per)\s*(sq\.?\s?ft|sqft|square\s*f)/i,
  /\bper\s*(sq\.?\s?ft|sqft|square\s*foot|square\s*feet)\b/i,
  /\b(rupees?)\b/i,
  /\b(rates?|prices?|costs?|charges?)\s+(start|starts|begin|begins|from|around|about|is|are|would be|will be)\b/i,
  /\b(it'?ll|it will|that would|that will)\s+cost\b/i,
  /\bstarting (at|from)\s*\d/i,
];

export function containsPrice(text: string): boolean {
  return PATTERNS.some((p) => p.test(text));
}

/** Throws if text bound for a caller (voice output, booking message, caller-facing API) leaks a price. */
export function assertNoPrice(text: string, where: string): void {
  if (containsPrice(text)) throw new Error(`PRICING_LEAK_BLOCKED in ${where}`);
}

/** Recursively assert that every string in a caller-facing JSON response is price-free. */
export function assertNoPriceDeep(value: unknown, where: string): void {
  if (typeof value === "string") return assertNoPrice(value, where);
  if (Array.isArray(value)) return value.forEach((v) => assertNoPriceDeep(v, where));
  if (value && typeof value === "object") Object.values(value).forEach((v) => assertNoPriceDeep(v, where));
}

export const PRICING_QUESTION = /\b(price|pricing|cost|costs|rate|rates|how much|charge|charges|quote|estimate|ballpark|budget range|per sq)/i;
