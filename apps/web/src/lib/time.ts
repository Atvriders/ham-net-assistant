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

export function to12h(startLocal: string): { hour: number; minute: number; meridiem: 'AM' | 'PM' } {
  const [hStr, mStr] = startLocal.split(':');
  const h24 = Math.max(0, Math.min(23, Number(hStr) || 0));
  const minute = Math.max(0, Math.min(59, Number(mStr) || 0));
  const meridiem: 'AM' | 'PM' = h24 >= 12 ? 'PM' : 'AM';
  const hour = ((h24 + 11) % 12) + 1;
  return { hour, minute, meridiem };
}

export function to24h(t: { hour: number; minute: number; meridiem: 'AM' | 'PM' }): string {
  const h12 = ((t.hour - 1) % 12) + 1;
  let h24 = h12 % 12;
  if (t.meridiem === 'PM') h24 += 12;
  return `${String(h24).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

export function formatStartLocal12h(startLocal: string): string {
  const { hour, minute, meridiem } = to12h(startLocal);
  return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
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
