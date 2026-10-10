import { env } from "./env";

/** Local wall-clock parts in the studio timezone. */
export function localParts(date: Date, tz = env.timezone()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[parts.weekday as string], hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** True when the front desk is staffed (human route). */
export function isHumanHours(date: Date): boolean {
  const { day, hour } = localParts(date);
  return env.humanDays().includes(day) && hour >= env.humanHoursStart() && hour < env.humanHoursEnd();
}

export const isAfterHours = (date: Date) => !isHumanHours(date);

export function formatLocal(iso: string, tz = env.timezone()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}
