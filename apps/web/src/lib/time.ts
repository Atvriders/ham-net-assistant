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

/**
 * Signed minutes until a net's `HH:mm` wall-clock start **as observed in the
 * given IANA timezone**, relative to `now` (default: the real clock).
 *
 * Positive = the start is still ahead today; negative = it already passed.
 * The value is fractional (seconds count), and it is normalized into
 * (-720, 720] so a start just after midnight still reads as "N minutes away"
 * from just before midnight (and vice versa) — pure time-of-day math, no
 * calendar day involved. The Intl "hour 24 at midnight" quirk is handled by
 * `wallClockInTimeZone`. Returns null when `startLocal` is malformed.
 */
export function minutesUntilNetStart(
  startLocal: string,
  timeZone: string,
  now: Date = new Date(),
): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(startLocal);
  if (!m) return null;
  const startMins = Number(m[1]) * 60 + Number(m[2]);
  const wall = wallClockInTimeZone(now, timeZone);
  const nowMins =
    wall.getHours() * 60 + wall.getMinutes() + wall.getSeconds() / 60;
  let diff = startMins - nowMins;
  if (diff <= -720) diff += 1440;
  else if (diff > 720) diff -= 1440;
  return diff;
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
