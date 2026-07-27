import type { PrismaClient } from '@prisma/client';
import { instantFromWallClock, wallClockIn } from '../discord/reminders.js';

// NOTE: there is deliberately no server-local-day variant of the helpers below.
// One used to exist (findSameDaySession, using setHours(0,0,0,0)) and the
// manual "Open net" route picked it: an evening US net straddles 00:00 UTC, so
// the two halves of one net night landed on different "days" and the route
// opened a second PREP session that the auto-start scheduler also took live —
// duplicate Discord announcements and a split check-in log. Always anchor a
// session's day to the net's own IANA timezone.

/**
 * Compute the UTC [start, end] bounds of the calendar day that `on` falls in,
 * **as observed in the named IANA timezone**. Reuses the timezone helpers from
 * reminders.ts so we don't reinvent the wall-clock math. A session is "same
 * day" if its startedAt lands anywhere inside this window.
 */
export function dayBoundsInTz(tz: string, on: Date): { dayStart: Date; dayEnd: Date } {
  const wall = wallClockIn(tz, on);
  // 00:00 of that wall-clock day, expressed as a UTC instant.
  const dayStart = instantFromWallClock(tz, wall.year, wall.month, wall.day, 0, 0);
  // 00:00 of the *next* calendar day, then back off 1ms to get inclusive end.
  // Date.UTC handles month/year overflow on day+1.
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1, 12, 0, 0));
  const nextStart = instantFromWallClock(
    tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0,
  );
  const dayEnd = new Date(nextStart.getTime() - 1);
  return { dayStart, dayEnd };
}

/**
 * The calendar-day key ("YYYY-MM-DD") that `on` falls in **as observed in the
 * named IANA timezone**. Use this — never the server's local day — whenever
 * sessions are grouped by "net night": a 20:00 America/Chicago net crosses
 * 00:00 UTC, so a server-local key files one night's two rows under two
 * different dates and the admin duplicate-session merge tool can't even see
 * that they belong together.
 */
export function dayKeyInTz(tz: string, on: Date): string {
  const wall = wallClockIn(tz, on);
  const mm = String(wall.month).padStart(2, '0');
  const dd = String(wall.day).padStart(2, '0');
  return `${wall.year}-${mm}-${dd}`;
}

/**
 * Find any non-deleted session for a given net that started on the same
 * calendar day **in the net's IANA timezone** as the provided Date. Anchoring
 * the day window to the net's own wall clock is what makes a net that runs
 * across UTC midnight dedupe to a single session. Used by the auto-open
 * scheduler and by the manual "Open net" route.
 */
export async function findSameDaySessionInTz(
  prisma: PrismaClient,
  netId: string,
  tz: string,
  on: Date,
): Promise<{ id: string; endedAt: Date | null } | null> {
  const { dayStart, dayEnd } = dayBoundsInTz(tz, on);
  return prisma.netSession.findFirst({
    where: {
      netId,
      deletedAt: null,
      startedAt: { gte: dayStart, lte: dayEnd },
    },
    select: { id: true, endedAt: true },
  });
}
