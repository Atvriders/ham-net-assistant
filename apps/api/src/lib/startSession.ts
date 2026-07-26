import { Prisma, type PrismaClient } from '@prisma/client';
import { postToDiscord } from '../discord/client.js';

/**
 * The relation payload the start flow returns — identical to what
 * POST /api/sessions/:id/start has always responded with, so the route's
 * external contract is unchanged.
 */
const startedSessionInclude = {
  topic: true,
  checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'desc' } },
  net: {
    include: {
      repeater: true,
      links: { include: { repeater: true } },
    },
  },
  controlOp: { select: { callsign: true, name: true } },
} satisfies Prisma.NetSessionInclude;

export type StartedSession = Prisma.NetSessionGetPayload<{
  include: typeof startedSessionInclude;
}>;

export interface StartSessionResult {
  /**
   * True when THIS call performed the PREP → LIVE transition. False when the
   * guard-update matched nothing (already live, ended, deleted, or missing) —
   * in that case no Discord announcement is fired by this call.
   */
  transitioned: boolean;
  /** The session with full relations after the attempt; null if it doesn't exist. */
  session: StartedSession | null;
}

/**
 * Core of "press START": transition a PREP session to LIVE.
 *
 * Shared by the manual route (POST /api/sessions/:id/start, actorUserId =
 * the pressing user) and the auto-start scheduler (actorUserId = null).
 *
 * Race safety: the transition is a guard-update — `updateMany` with
 * `liveAt: null` in the WHERE — so when a manual start and a scheduler tick
 * race, exactly one caller observes `count === 1` and only that caller fires
 * the Discord 🟢 announcement. The loser sees `transitioned: false`.
 *
 * Control-op fallback: only a HUMAN start (actorUserId non-null) adopts a
 * control-less session — the starter becomes control so a live net is never
 * left control-less, but an existing control op is never reassigned (the
 * `controlOpId: null` WHERE guard makes that race-safe too). Scheduler starts
 * pass null and leave controlOpId exactly as-is.
 */
export async function startSession(
  prisma: PrismaClient,
  sessionId: string,
  actorUserId: string | null,
): Promise<StartSessionResult> {
  const res = await prisma.netSession.updateMany({
    where: { id: sessionId, liveAt: null, endedAt: null, deletedAt: null },
    data: { liveAt: new Date() },
  });
  const transitioned = res.count === 1;

  if (transitioned && actorUserId !== null) {
    // Null-fallback: assign the starter ONLY when nobody holds control.
    await prisma.netSession.updateMany({
      where: { id: sessionId, controlOpId: null },
      data: { controlOpId: actorUserId },
    });
  }

  const session = await prisma.netSession.findUnique({
    where: { id: sessionId },
    include: startedSessionInclude,
  });

  if (transitioned && session) {
    // Fire-and-forget Discord "now live" notification — announced from here
    // (not the route) so scheduler-driven starts ping exactly like manual
    // ones, and the guard above guarantees it fires at most once per session.
    void (async () => {
      try {
        const repeater = session.net?.repeater;
        const freq = repeater?.frequency != null ? `${repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = repeater?.name ? ` (${repeater.name})` : '';
        const topicLine = session.topicTitle ? ` · Topic: ${session.topicTitle}` : '';
        const content =
          `🟢 **${session.net.name}** is now live on ${freq}${repeaterName}${topicLine}`;
        await postToDiscord(prisma, content);
      } catch { /* ignore */ }
    })();
  }

  return { transitioned, session };
}
