import type { PrismaClient } from '@prisma/client';
import { instantFromWallClock, wallClockIn } from '../discord/reminders.js';

/**
 * Find any non-deleted session for a given net that started on the same
 * calendar day (server local timezone) as the provided Date.
 */
export async function findSameDaySession(
  prisma: PrismaClient,
  netId: string,
  on: Date,
): Promise<{ id: string; endedAt: Date | null } | null> {
  const dayStart = new Date(on);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(on);
  dayEnd.setHours(23, 59, 59, 999);
  return prisma.netSession.findFirst({
    where: {
      netId,
      deletedAt: null,
      startedAt: { gte: dayStart, lte: dayEnd },
    },
    select: { id: true, endedAt: true },
  });
}

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
 * Find any non-deleted session for a given net that started on the same
 * calendar day **in the net's IANA timezone** as the provided Date. Unlike
 * findSameDaySession (which uses the server's local day), this anchors the
 * day window to the net's own wall clock — so a net in a different timezone
 * dedupes relative to its own calendar day. Used by the auto-open scheduler.
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
