/** Local wall-clock helpers. Simulation only - DST transitions are ignored. */

export function localParts(
  timeZone: string,
  at: Date,
): { hour: number; minute: number; weekday: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    const weekday = get("weekday");
    if (Number.isNaN(hour) || Number.isNaN(minute) || !weekday) return null;
    return { hour, minute, weekday };
  } catch {
    return null;
  }
}

export function localHourFraction(timeZone: string, at: Date): number | null {
  const p = localParts(timeZone, at);
  return p ? p.hour + p.minute / 60 : null;
}

export function isWeekendIn(timeZone: string, at: Date): boolean {
  const p = localParts(timeZone, at);
  return p ? p.weekday === "Sat" || p.weekday === "Sun" : false;
}

/** Minutes from `at` until the next occurrence of `targetHour` local time. */
export function minutesUntilLocalHour(
  timeZone: string,
  at: Date,
  targetHour: number,
): number {
  const now = localHourFraction(timeZone, at);
  if (now === null) return 0;
  const delta = targetHour - now;
  return Math.round((delta > 0 ? delta : delta + 24) * 60);
}
