import type { PrismaClient } from '@prisma/client';
import { instantFromWallClock, wallClockIn } from '../discord/reminders.js';
import { startSession } from './startSession.js';

/**
 * Grace window after a weekly net's scheduled start during which an open PREP
 * session is still auto-started. Beyond it a stale PREP session (opened but
 * never started, found hours later) must NOT surprise-start the net. Matches
 * AUTO_OPEN_LEAD_MS so the auto-open + auto-start pair is symmetric around
 * the scheduled start.
 */
export const AUTO_START_GRACE_MS = 15 * 60_000;

/**
 * Oldest a PREP session may be, relative to today's scheduled start, and
 * still be auto-started. Closes the "one week later" hole: an abandoned PREP
 * session (opened but never started, never ended, never deleted) would
 * otherwise match today's weekday + grace window again on the NEXT weekly
 * occurrence and surprise-start alongside the freshly opened session (double
 * 🟢 announcement, two concurrent LIVE sessions). Any session legitimately
 * belonging to today's occurrence is opened either by the auto-open scheduler
 * (15 min before start) or by an operator on the same calendar day — always
 * well within 24 hours of the start.
 */
export const AUTO_START_MAX_PREP_AGE_MS = 24 * 60 * 60_000;

/**
 * One pass of the auto-start scheduler. For each open PREP session
 * (liveAt null, endedAt null, deletedAt null) whose net is weekly, compute
 * today's scheduled start instant in the NET'S OWN timezone and, when
 *   today (in that tz) is net.dayOfWeek  AND
 *   startInstant <= now <= startInstant + 15 min (grace, inclusive),
 * transition the session to LIVE exactly as if START were pressed — via the
 * shared startSession core, which fires the Discord 🟢 announcement. The
 * actor is null: scheduler starts never touch controlOpId.
 *
 * Idempotent by construction: once liveAt is set the session no longer
 * matches the query, and startSession's guard-update (liveAt: null WHERE)
 * makes a manual-start/scheduler race single-fire. Pure w.r.t. the injected
 * clock so tests can drive it with a fixed `now`.
 *
 * Returns the number of sessions started this pass (for tests/observability).
 */
export async function autoStartTick(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const nowMs = now.getTime();
  // Impromptu nets have no meaningful schedule — their PREP sessions only go
  // live when an operator presses START.
  const sessions = await prisma.netSession.findMany({
    where: {
      liveAt: null,
      endedAt: null,
      deletedAt: null,
      net: { kind: 'weekly' },
    },
    select: {
      id: true,
      startedAt: true,
      net: { select: { dayOfWeek: true, startLocal: true, timezone: true } },
    },
  });

  let started = 0;
  for (const s of sessions) {
    const tz = s.net.timezone || 'UTC';
    const wall = wallClockIn(tz, now);
    // Today, in the net's own timezone, must be the net's scheduled day.
    if (wall.weekday !== s.net.dayOfWeek) continue;
    // Today's scheduled start as a UTC instant (DST-safe — reuses the
    // reminders.ts wall-clock helpers rather than reinventing tz math).
    const [h, m] = s.net.startLocal.split(':').map(Number);
    const startMs = instantFromWallClock(
      tz, wall.year, wall.month, wall.day, h ?? 0, m ?? 0,
    ).getTime();
    if (nowMs < startMs) continue;                       // not yet started
    if (nowMs - startMs > AUTO_START_GRACE_MS) continue; // stale — too late
    // Abandoned session from a PAST occurrence (e.g. opened last week and
    // never started): today's weekday + grace window match again exactly one
    // week later, so age-gate on when the session was opened relative to
    // today's start. Sessions opened after the start (within grace) pass
    // trivially (negative difference).
    if (startMs - s.startedAt.getTime() > AUTO_START_MAX_PREP_AGE_MS) continue;
    const { transitioned } = await startSession(prisma, s.id, null);
    if (transitioned) started += 1;
  }
  return started;
}

/**
 * Start the auto-start scheduler on a ~30s interval using the real clock.
 * Runs one tick immediately at startup. Returns a stop function.
 * Unconditional — postToDiscord no-ops cleanly when Discord isn't connected.
 */
export function startAutoStartScheduler(prisma: PrismaClient): () => void {
  const handle = setInterval(() => {
    void autoStartTick(prisma, new Date()).catch((e) => {
      console.warn('[auto-start] tick failed', e);
    });
  }, 30 * 1000);
  void autoStartTick(prisma, new Date()).catch((e) => {
    console.warn('[auto-start] tick failed', e);
  });
  return () => clearInterval(handle);
}
