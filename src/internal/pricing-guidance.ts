import "server-only";

/**
 * INTERNAL PRICING GUIDANCE — from the studio's internal pricing guide. Server-only and rendered ONLY in the
 * authenticated designer dashboard. It must never be imported by anything under src/voice, src/app/api/voice,
 * the Vaani prompt/rubric, booking messages, or any caller-facing code (enforced by tests/pricing-isolation.test.ts).
 */

export const PRICING_DISCLAIMER =
  "Internal guidance only — NOT a quote. Indicative; varies by site, materials and complexity. Never quote any figure to a client; the designer confirms pricing at the consultation.";

type Band = { label: string; perSqft: [number, number | null] };

const RESIDENTIAL: Band[] = [
  { label: "Standard specification", perSqft: [1800, 2400] },
  { label: "Premium specification", perSqft: [2400, 3500] },
  { label: "Luxury specification", perSqft: [3500, null] },
];
const COMMERCIAL: Band[] = [
  { label: "Basic fitout", perSqft: [1200, 1800] },
  { label: "Mid-range office", perSqft: [1800, 2800] },
  { label: "Premium office", perSqft: [2800, 4000] },
];
export const AFFECTS_PRICING = [
  "Site condition: existing flooring/ceilings that can be retained reduce cost significantly",
  "Custom furniture ratio: more custom = higher cost",
  "Material brands: tile, fitting and wood-grade spread across tiers is significant",
  "Timeline compression: fast-track execution carries a premium",
];

export interface GuidanceRow { label: string; perSqft: string; total: string | null }
export interface Guidance { heading: string; rows: GuidanceRow[]; singleRoom: string | null; note: string }

const fmt = (n: number) => (n >= 10_000_000 ? `₹${(n / 10_000_000).toFixed(2)} cr` : n >= 100_000 ? `₹${(n / 100_000).toFixed(1)} lakh` : `₹${n.toLocaleString("en-IN")}`);

export function guidanceFor(opts: { propertyUse: string; carpetAreaSqft: number | null; singleRoom: boolean }): Guidance | null {
  if (opts.propertyUse !== "residential" && opts.propertyUse !== "commercial") return null;
  const bands = opts.propertyUse === "commercial" ? COMMERCIAL : RESIDENTIAL;
  const area = opts.carpetAreaSqft;
  return {
    heading: opts.propertyUse === "commercial" ? "Commercial (office / clinic / studio)" : "Residential",
    rows: bands.map((b) => {
      const [lo, hi] = b.perSqft;
      return {
        label: b.label,
        perSqft: hi ? `₹${lo.toLocaleString("en-IN")} – ₹${hi.toLocaleString("en-IN")} per sq ft` : `₹${lo.toLocaleString("en-IN")}+ per sq ft`,
        total: area ? (hi ? `${fmt(lo * area)} – ${fmt(hi * area)}` : `${fmt(lo * area)}+`) : null,
      };
    }),
    singleRoom: opts.propertyUse === "residential" && opts.singleRoom ? "Single room redesign (all-in): ₹3.5 lakh – ₹8 lakh depending on room size and specification" : null,
    note: area ? `Totals are arithmetic on the stated carpet area of ${area} sq ft (carpet area of the designed space, not built-up). They are NOT an estimate for this project.` : "Carpet area not stated, so no totals are computed. Sq ft refers to carpet area of the designed space.",
  };
}
