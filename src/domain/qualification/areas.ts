/** Service area, copied from sources/services.md. Anything not matched stays "unknown", never "out". */

const PUNE = [
  "kothrud", "baner", "aundh", "wakad", "koregaon park", "kalyani nagar", "viman nagar", "hadapsar",
  "magarpatta", "nibm", "kondhwa", "undri", "shivane", "warje", "erandwane", "deccan",
];
const PCMC = ["pimpri", "chinchwad", "pimple saudagar", "pimple nilakh", "ravet", "hinjewadi"];
/** services.md: "We do not currently serve Talegaon, Lonavala, Nashik, Mumbai, or other cities outside this area." */
const EXCLUDED = ["talegaon", "lonavala", "nashik", "mumbai"];
/** Other clearly different cities; anything else unrecognised is "unknown" (route to review). */
const OTHER_CITIES = ["nagpur", "delhi", "bangalore", "bengaluru", "hyderabad", "chennai", "kolkata", "ahmedabad", "satara", "kolhapur", "thane", "navi mumbai", "goa", "surat", "indore"];

export type AreaStatus = "in" | "out" | "unknown";

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const has = (hay: string, list: string[]) => list.find((x) => new RegExp(`(^|\\s)${x}(\\s|$)`).test(hay));

export function classifyArea(city: string | null, locality: string | null): { status: AreaStatus; matched: string | null } {
  const c = norm(city);
  const l = norm(locality);
  const both = `${l} ${c}`.trim();
  const excluded = has(both, EXCLUDED);
  if (excluded) return { status: "out", matched: excluded };
  const inLocality = has(both, [...PUNE, ...PCMC]);
  if (inLocality) return { status: "in", matched: inLocality };
  if (has(c, ["pune", "pcmc", "pimpri chinchwad"])) return { status: "in", matched: "pune" };
  const other = has(c, OTHER_CITIES);
  if (other) return { status: "out", matched: other };
  return { status: "unknown", matched: null };
}
