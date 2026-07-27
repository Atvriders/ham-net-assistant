import type { PrismaClient } from '@prisma/client';

/**
 * How long a session may stay LIVE before the reaper ends it for us.
 *
 * `endedAt` is otherwise only ever written by a human pressing END (or by the
 * log importer). A club that opens a net and forgets to close it — or one
 * whose net was auto-started with nobody at the mic — leaves a session LIVE
 * forever: it stays on the Dashboard's "active" list, `/api/nets/active`
 * keeps returning it, the Discord bridge keeps mirroring chatter into it, and
 * stats carry a session with no end time.
 *
 * Four hours is the smallest value that cannot cut a real net short: club
 * nets here run 30–90 minutes, and even a marathon Field Day-style session
 * plus a long post-net rag-chew is comfortably under four. Anything still
 * "on the air" past that is an abandoned row, not a net.
 */
export const MAX_LIVE_SESSION_MS = 4 * 60 * 60_000;

/**
 * One pass of the stale-session reaper. Ends every session that has been LIVE
 * and *silent* for more than {@link MAX_LIVE_SESSION_MS} and was never ended.
 *
 * Scope is deliberately narrow:
 *  - LIVE only (`liveAt` non-null). A PREP session (opened, never started) is
 *    left alone — it never went on the air, so "ending" it would invent a net
 *    that never happened, and the auto-start scheduler already age-gates it.
 *  - Soft-deleted rows (`deletedAt`) are never touched: they're already out
 *    of every view, and writing to them would resurrect them in exports.
 *  - ABANDONED only: a session that has taken a check-in inside the window is
 *    still being run and is skipped. Without that guard the reaper closed nets
 *    that were demonstrably on the air (Field Day, an ARES activation, a long
 *    swap net), and `POST /sessions/:id/checkins` answers 409 "Session already
 *    ended" — so the operator silently lost every entry from that moment on.
 *
 * Check-ins are the activity signal; chat messages deliberately are NOT. The
 * Discord bridge mirrors channel traffic into the newest never-ended session,
 * so treating messages as activity would let an idle-but-chatty channel keep
 * one session live forever — exactly the leak this reaper exists to close.
 *
 * `endedAt` is anchored to the last thing that actually happened
 * (`max(liveAt, last check-in) + MAX_LIVE_SESSION_MS`), never to `now`:
 *  - anchoring to `now` would record a three-day net if the server was down
 *    over a long weekend and the reaper only got to the row on Monday;
 *  - anchoring to `liveAt` alone could stamp an end time BEFORE a check-in the
 *    log already contains, which is a self-contradictory record and skews
 *    every duration in stats and the CSV/PDF exports.
 * Both inputs are stored timestamps, so the value is deterministic, and it can
 * never land in the future (both anchors are at or before the cutoff).
 *
 * Idempotent: the write is a guard-update on `endedAt: null`, so a second
 * pass (or a human pressing END concurrently) changes nothing. Pure w.r.t.
 * the injected clock so tests can drive it with a fixed `now`.
 *
 * Returns the number of sessions ended this pass (for tests/observability).
 */
export async function reapStaleSessionsTick(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - MAX_LIVE_SESSION_MS);
  const stale = await prisma.netSession.findMany({
    where: {
      liveAt: { not: null, lte: cutoff },
      endedAt: null,
      deletedAt: null,
      // Nothing logged inside the window. Soft-deleted check-ins count as
      // activity too — an operator deleting a mistyped line is an operator at
      // the keyboard — and the safe direction here is to reap less, not more.
      checkIns: { none: { checkedInAt: { gt: cutoff } } },
    },
    select: {
      id: true,
      liveAt: true,
      net: { select: { name: true } },
      checkIns: {
        orderBy: { checkedInAt: 'desc' },
        take: 1,
        select: { checkedInAt: true },
      },
    },
  });

  let ended = 0;
  for (const s of stale) {
    // Per-session failure boundary: one row that can't be written (FK/lock)
    // must not stop the rest of the sweep.
    try {
      const lastCheckIn = s.checkIns[0]?.checkedInAt.getTime() ?? 0;
      const anchor = Math.max(s.liveAt!.getTime(), lastCheckIn);
      const endedAt = new Date(anchor + MAX_LIVE_SESSION_MS);
      const res = await prisma.netSession.updateMany({
        where: { id: s.id, endedAt: null, deletedAt: null },
        data: { endedAt },
      });
      if (res.count !== 1) continue; // someone pressed END first — fine
      ended += 1;
      // Logged individually: an auto-end is a correction of operator error,
      // and the club's officers will ask "why does the log say 4h?".
      console.log(
        `[reaper] auto-ended session ${s.id} ("${s.net.name}") — live since ` +
        `${s.liveAt!.toISOString()}, never ended; endedAt set to ${endedAt.toISOString()}`,
      );
    } catch (e) {
      console.warn(`[reaper] failed to auto-end session ${s.id}`, e);
    }
  }
  return ended;
}

/**
 * Start the stale-session reaper on a ~5 min interval using the real clock.
 * Runs one pass immediately at startup (so a restart cleans up whatever the
 * previous process left behind). Returns a stop function.
 *
 * Five minutes rather than the 30–60s the other schedulers use: nothing here
 * is time-critical to the minute — a session that has already overrun by four
 * hours does not care about another five.
 *
 * NOTE: exactly ONE replica may run this scheduler (see the auto-open /
 * auto-start schedulers). The guard-update keeps a concurrent second replica
 * from double-ending, but the app is not designed for multi-replica
 * scheduling.
 */
export function startStaleSessionReaper(prisma: PrismaClient): () => void {
  // Re-entrancy guard: a slow sweep must not overlap the next interval.
  let inFlight = false;
  const run = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await reapStaleSessionsTick(prisma, new Date());
    } catch (e) {
      console.warn('[reaper] tick failed', e);
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => { void run(); }, 5 * 60 * 1000);
  void run();
  return () => clearInterval(handle);
}
