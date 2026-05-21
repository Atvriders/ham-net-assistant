import type { PrismaClient } from '@prisma/client';
import { parseReminderMinutes } from '@hna/shared';
import { postToDiscord } from './client.js';

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

/**
 * Format a lead-time-in-minutes for human-readable Discord messages.
 * 60 -> "1 hour", 90 -> "1.5 hours", 30 -> "30 minutes", 240 -> "4 hours".
 */
function formatLeadMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours.toFixed(1)} hours`;
}

function formatStartLocal12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h24 = Number(hStr);
  const m = Number(mStr);
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

export function startReminderScheduler(prisma: PrismaClient): () => void {
  const handle = setInterval(() => { void tick(prisma); }, 60 * 1000);
  // tick once immediately at startup
  void tick(prisma);
  return () => clearInterval(handle);
}

async function tick(prisma: PrismaClient): Promise<void> {
  try {
    // Impromptu nets have no meaningful schedule, so the reminder scheduler
    // must skip them — only weekly nets get reminder pings.
    const nets = await prisma.net.findMany({
      where: { active: true, kind: 'weekly' },
      include: { repeater: true },
    });
    const now = Date.now();
    for (const net of nets) {
      // Per-net reminder lead times, in minutes-before-net-start.
      // `null` / `[]` means "no reminders for this net".
      const leadMinutes = parseReminderMinutes(net.reminderMinutes);
      if (leadMinutes.length === 0) continue;

      const tz = net.timezone || 'UTC';
      if (!net.timezone) {
        // eslint-disable-next-line no-console
        console.warn(`[discord] net ${net.id} has no timezone; defaulting to UTC`);
      }
      const occurs = nextOccurrence(net.dayOfWeek, net.startLocal, tz, now);

      for (const minutes of leadMinutes) {
        const reminderAt = new Date(occurs.getTime() - minutes * 60_000);
        // Skip if reminder is at or after the net's actual start. (positive
        // lead times always satisfy this, but guard defensively.)
        if (reminderAt.getTime() >= occurs.getTime()) continue;
        // Fire window: ±60s of reminderAt
        if (reminderAt.getTime() < now - 60_000 || reminderAt.getTime() > now + 60_000) continue;
        const occurrenceKey = new Date(occurs);
        occurrenceKey.setSeconds(0, 0);
        const kind = `m${minutes}`;
        const dedupe = await prisma.netReminder.findUnique({
          where: { netId_occursAt_kind: { netId: net.id, occursAt: occurrenceKey, kind } },
        }).catch(() => null);
        if (dedupe) continue;
        const freq = net.repeater?.frequency != null ? ` on ${net.repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = net.repeater?.name ? ` (${net.repeater.name})` : '';
        const lead = minutes <= 60 ? 'Heads up' : 'Reminder';
        const human = formatLeadMinutes(minutes);
        const content = `**${lead}:** *${net.name}* starts at ${formatStartLocal12h(net.startLocal)}${freq}${repeaterName}. (${human} reminder)`;
        const result = await postToDiscord(prisma, content);
        if (result.ok) {
          await prisma.netReminder.create({
            data: { netId: net.id, occursAt: occurrenceKey, kind },
          }).catch(() => {/* ignore unique conflicts */});
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] reminder tick failed', e);
  }
}
