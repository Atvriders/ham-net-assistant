import type { PrismaClient } from '@prisma/client';
import { nextOccurrence } from '../discord/reminders.js';
import { findSameDaySessionInTz } from './sessionDedupe.js';

/** How many minutes before a weekly net's scheduled start we auto-open it. */
export const AUTO_OPEN_LEAD_MS = 15 * 60_000;

/**
 * One pass of the auto-open scheduler. For each active weekly net, if `now`
 * falls inside the window [occurrence - 15 min, occurrence] and no non-deleted
 * session already exists for that net on the occurrence's calendar day (in the
 * net's own timezone), create a PREP session:
 *   startedAt = now, liveAt = null, controlOpId = null, no topic,
 *   autoOpened = true.
 *
 * No Discord post fires here — the 🟢 announcement only fires when an operator
 * presses START (POST /sessions/:id/start). The function is pure w.r.t. the
 * injected clock so a test can drive it with a fixed `now`. It is idempotent:
 * a second call at the same `now` finds the just-created same-day session and
 * skips.
 *
 * Returns the number of sessions opened this pass (for tests/observability).
 */
export async function autoOpenTick(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const nowMs = now.getTime();
  // Impromptu nets have no meaningful schedule, so they're never auto-opened —
  // only active weekly nets get a PREP session opened ahead of their start.
  const nets = await prisma.net.findMany({
    where: { active: true, kind: 'weekly' },
    select: { id: true, dayOfWeek: true, startLocal: true, timezone: true },
  });

  let opened = 0;
  for (const net of nets) {
    const tz = net.timezone || 'UTC';
    // The next scheduled occurrence at or after `now`, in the net's timezone.
    // nextOccurrence is timezone- and DST-aware; we don't reinvent that math.
    const occurs = nextOccurrence(net.dayOfWeek, net.startLocal, tz, nowMs);
    const occursMs = occurs.getTime();

    // Fire window: [occurrence - 15 min, occurrence]. `nextOccurrence` returns
    // a strictly-future instant, so occursMs > nowMs always holds; we only need
    // to check the lower bound. (A session opened in a prior tick will move the
    // dedupe check, not this window — see below.)
    if (occursMs - nowMs > AUTO_OPEN_LEAD_MS) continue;

    // Dedupe against the OCCURRENCE's calendar day (in the net's tz), not
    // `now`'s. Near a midnight boundary the 15-min window can straddle two
    // calendar days; anchoring to the occurrence keeps one session per
    // occurrence. Any non-deleted same-day session (PREP, LIVE, or already
    // ended) means "skip" — the scheduler must never create a second.
    const existing = await findSameDaySessionInTz(prisma, net.id, tz, occurs);
    if (existing) continue;

    await prisma.netSession.create({
      data: {
        netId: net.id,
        startedAt: now,
        liveAt: null,
        controlOpId: null,
        autoOpened: true,
      },
    });
    opened += 1;
  }
  return opened;
}

/**
 * Start the auto-open scheduler on a ~60s interval using the real clock. Runs
 * one tick immediately at startup. Returns a stop function. Unconditional —
 * it doesn't depend on Discord (no posts are made on auto-open).
 */
export function startAutoOpenScheduler(prisma: PrismaClient): () => void {
  const handle = setInterval(() => {
    void autoOpenTick(prisma, new Date()).catch((e) => {
      console.warn('[auto-open] tick failed', e);
    });
  }, 60 * 1000);
  void autoOpenTick(prisma, new Date()).catch((e) => {
    console.warn('[auto-open] tick failed', e);
  });
  return () => clearInterval(handle);
}
