import { isHumanHours } from "@/lib/time";

export type Route = "front_desk" | "vaani";

/**
 * Decides who should answer. Telephony forwarding (or Vaani's schedule) should call
 * GET /api/voice/route, or mirror this rule: staffed hours → front desk, otherwise Vaani.
 */
export function decideRoute(at: Date): Route {
  return isHumanHours(at) ? "front_desk" : "vaani";
}
