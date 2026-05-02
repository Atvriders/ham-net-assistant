import type { PrismaClient } from '@prisma/client';
import { postToDiscord } from './client.js';
import { getSetting } from '../lib/settings.js';

function defaultTimes(): string[] {
  return ['16:00', '19:30'];
}

async function getReminderTimes(prisma: PrismaClient): Promise<string[]> {
  try {
    const raw = await getSetting(prisma, 'discord.reminderTimesOfDay');
    if (!raw) return defaultTimes();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultTimes();
    const valid = parsed
      .map((s: unknown) => String(s))
      .filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
    return valid.length > 0 ? valid : defaultTimes();
  } catch {
    return defaultTimes();
  }
}

function format12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h24 = Number(hStr);
  const m = Number(mStr);
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/**
 * Return the wall-clock components (year, month, day, hour, minute, weekday)
 * that a given UTC instant has in the named IANA timezone.
 */
export function wallClockIn(tz: string, when: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(when).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // Intl returns "24" at midnight in some locales
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday!] ?? 0,
  };
}

/**
 * Compute the UTC Date that corresponds to a given wall-clock {y,mo,d,h,mi}
 * **as observed in the named timezone**. Adjusts an initial UTC guess until
 * its wall-clock interpretation in the target tz matches the requested
 * components. Robust across DST transitions.
 */
export function instantFromWallClock(
  tz: string, y: number, mo: number, d: number, h: number, mi: number,
): Date {
  // Start with a UTC guess for that wall-clock
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
  for (let i = 0; i < 3; i++) {
    const wall = wallClockIn(tz, guess);
    const guessedUtcMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    const desiredUtcMs = Date.UTC(y, mo - 1, d, h, mi);
    const drift = desiredUtcMs - guessedUtcMs;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}

/**
 * Given a Net's day-of-week and HH:mm wall-clock and IANA timezone, return
 * the next UTC instant that wall-clock is hit, after `fromTime`.
 */
export function nextOccurrence(
  dayOfWeek: number,
  startLocal: string,
  timezone: string,
  fromTime = Date.now(),
): Date {
  const [h, m] = startLocal.split(':').map(Number);
  const fromInTz = wallClockIn(timezone, new Date(fromTime));
  const diff = (dayOfWeek - fromInTz.weekday + 7) % 7;
  // Advance fromInTz's calendar day by `diff` days. Use Date.UTC for safe
  // calendar arithmetic on year/month/day (overflow handling), but DON'T
  // round-trip through wallClockIn — UTC midnight of "today in tz" may be
  // on a different calendar day in the target tz.
  const advanced = new Date(Date.UTC(fromInTz.year, fromInTz.month - 1, fromInTz.day + diff, 12, 0, 0));
  const targetY = advanced.getUTCFullYear();
  const targetMo = advanced.getUTCMonth() + 1;
  const targetD = advanced.getUTCDate();
  let utc = instantFromWallClock(timezone, targetY, targetMo, targetD, h ?? 0, m ?? 0);
  if (utc.getTime() <= fromTime) {
    // Bump 7 days on the calendar and re-anchor to wall clock (handles DST shifts).
    const bumped = new Date(Date.UTC(targetY, targetMo - 1, targetD + 7, 12, 0, 0));
    utc = instantFromWallClock(
      timezone,
      bumped.getUTCFullYear(),
      bumped.getUTCMonth() + 1,
      bumped.getUTCDate(),
      h ?? 0, m ?? 0,
    );
  }
  return utc;
}

export function startReminderScheduler(prisma: PrismaClient): () => void {
  const handle = setInterval(() => { void tick(prisma); }, 60 * 1000);
  // tick once immediately at startup
  void tick(prisma);
  return () => clearInterval(handle);
}

async function tick(prisma: PrismaClient): Promise<void> {
  try {
    const times = await getReminderTimes(prisma);
    if (times.length === 0) return;
    const nets = await prisma.net.findMany({
      where: { active: true },
      include: { repeater: true },
    });
    const now = Date.now();
    for (const net of nets) {
      const tz = net.timezone || 'UTC';
      if (!net.timezone) {
        // eslint-disable-next-line no-console
        console.warn(`[discord] net ${net.id} has no timezone; defaulting to UTC`);
      }
      const occurs = nextOccurrence(net.dayOfWeek, net.startLocal, tz, now);
      // Compute reminder times on the same calendar day as `occurs` in the net's tz
      const occursWall = wallClockIn(tz, occurs);
      for (const t of times) {
        const [hh, mm] = t.split(':').map(Number);
        const reminderAt = instantFromWallClock(
          tz,
          occursWall.year, occursWall.month, occursWall.day,
          hh!, mm!,
        );
        // Skip if reminder is at or after the net's actual start
        if (reminderAt.getTime() >= occurs.getTime()) continue;
        // Fire window: ±60s of reminderAt
        if (reminderAt.getTime() < now - 60_000 || reminderAt.getTime() > now + 60_000) continue;
        const occurrenceKey = new Date(occurs);
        occurrenceKey.setSeconds(0, 0);
        const dedupe = await prisma.netReminder.findUnique({
          where: { netId_occursAt_kind: { netId: net.id, occursAt: occurrenceKey, kind: t } },
        }).catch(() => null);
        if (dedupe) continue;
        const human = format12h(t);
        const freq = net.repeater?.frequency != null ? ` on ${net.repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = net.repeater?.name ? ` (${net.repeater.name})` : '';
        const minutesUntil = Math.round((occurs.getTime() - reminderAt.getTime()) / 60000);
        const lead = minutesUntil <= 60 ? 'Heads up' : 'Reminder';
        const content = `**${lead}:** *${net.name}* starts at ${format12h(net.startLocal)}${freq}${repeaterName}. (${human} reminder)`;
        const result = await postToDiscord(prisma, content);
        if (result.ok) {
          await prisma.netReminder.create({
            data: { netId: net.id, occursAt: occurrenceKey, kind: t },
          }).catch(() => {/* ignore unique conflicts */});
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] reminder tick failed', e);
  }
}
