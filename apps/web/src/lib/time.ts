const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayName(d: number): string {
  return DAYS[d] ?? '?';
}

/**
 * Return a Date representing "now" as a wall clock in the given IANA timezone.
 * The returned Date's getFullYear/getMonth/etc reflect local time in `timeZone`,
 * NOT in the user's browser tz. Good enough for day-of-week math.
 */
function wallClockInTimeZone(now: Date, timeZone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const year = get('year');
    const month = get('month');
    const day = get('day');
    let hour = get('hour');
    // Intl may emit 24 for midnight in hour12:false
    if (hour === 24) hour = 0;
    const minute = get('minute');
    const second = get('second');
    return new Date(year, month - 1, day, hour, minute, second);
  } catch {
    return new Date(now);
  }
}

export function nextOccurrence(
  dayOfWeek: number,
  startLocal: string,
  timeZone?: string,
): Date {
  const [h, m] = startLocal.split(':').map(Number);
  const now = new Date();
  const base = timeZone ? wallClockInTimeZone(now, timeZone) : new Date(now);
  const target = new Date(base);
  const diff = (dayOfWeek - base.getDay() + 7) % 7;
  target.setDate(base.getDate() + diff);
  target.setHours(h ?? 0, m ?? 0, 0, 0);
  if (target.getTime() <= base.getTime()) target.setDate(target.getDate() + 7);
  return target;
}
