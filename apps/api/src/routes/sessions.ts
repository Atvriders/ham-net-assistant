import { Router } from 'express';
import { PrismaClient, CheckIn } from '@prisma/client';
import { z } from 'zod';
import { NetSessionUpdate,
  ReorderCheckInsInput,
} from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { redactScriptsForRole } from '../lib/scriptGate.js';
import { findSameDaySessionInTz } from '../lib/sessionDedupe.js';
import { InvalidTimezoneError } from '../discord/reminders.js';
import { postToDiscord } from '../discord/client.js';
import { withCheckInMode } from '../lib/checkinMode.js';
import { startSession } from '../lib/startSession.js';
import { CHECKIN_LOG_ORDER_ASC, CHECKIN_LOG_ORDER_DESC } from '../lib/checkInOrder.js';

/**
 * Normalize the checkIns array on a session-shaped object so each row carries
 * a concrete `mode` value ('rf' by default, 'echolink' when set) instead of
 * the DB's nullable string. Mutates the passed object in place and returns it.
 */
function liftSessionCheckInModes<T extends { checkIns?: Array<{ mode?: string | null }> }>(
  s: T,
): T {
  if (Array.isArray(s.checkIns)) {
    s.checkIns = s.checkIns.map((ci) => withCheckInMode(ci));
  }
  return s;
}

const RangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  netId: z.string().optional(),
});

const StartSessionInput = z.object({
  topicId: z.string().optional(),
  topicTitle: z.string().max(200).optional(),
});

export function sessionsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  // POST /api/nets/:netId/sessions — OPEN (not start) a session into PREP state.
  //
  // Creates the session with liveAt = null. The session row exists, the operator
  // can prep (set topic, edit script, coordinate over chat) but the net is not
  // yet "on the air": no Discord 🟢 announcement, no check-ins accepted. The
  // separate POST /api/sessions/:id/start route transitions PREP → LIVE.
  nested.post('/', requireRole('NET_CONTROL'), asyncHandler(async (req, res) => {
    const { netId } = req.params as { netId: string };
    const body = req.body && Object.keys(req.body).length > 0
      ? StartSessionInput.parse(req.body)
      : { topicId: undefined as string | undefined, topicTitle: undefined as string | undefined };
    const net = await prisma.net.findUnique({ where: { id: netId } });
    if (!net) throw new HttpError(404, 'NOT_FOUND', 'Net not found');

    // Check for existing same-day session. The dedupe path doesn't care whether
    // the existing row is in PREP or LIVE — either way we return that row so a
    // second click of "Open net" doesn't create a duplicate prep session.
    //
    // The day window is anchored to the NET's own timezone, not the server's.
    // A 20:00 America/Chicago net runs straight through 00:00 UTC, so a
    // server-local/UTC day window cuts one net night in half: the second press
    // of "Open net" (or the auto-open scheduler, which has always been
    // tz-aware) lands on "another day" and creates a second PREP session. The
    // auto-start scheduler then takes both live — two "net is live"
    // announcements in Discord and a check-in log split across two rows.
    //
    // A net saved BEFORE the shared schema started validating timezones can
    // still hold something Intl rejects ("CDT", "Eastern", a pasted trailing
    // space). Anchoring to the net's zone means that row now reaches Intl on
    // this path, where it used to be answered with a server-local window — so
    // without this catch, "Open net" would 500 on net night and the operator
    // would have no idea why. Answer with the fix instead. New nets cannot
    // reach this branch; NetInput/NetUpdate reject bad zones at the door.
    let existing: Awaited<ReturnType<typeof findSameDaySessionInTz>>;
    try {
      existing = await findSameDaySessionInTz(prisma, netId, net.timezone || 'UTC', new Date());
    } catch (e) {
      if (e instanceof InvalidTimezoneError) {
        throw new HttpError(
          400,
          'VALIDATION',
          `This net's timezone (${JSON.stringify(e.timezone)}) is not a valid IANA `
            + 'timezone, so its schedule cannot be resolved. Edit the net and pick a '
            + 'zone like America/Chicago, then open it again.',
        );
      }
      throw e;
    }
    if (existing) {
      if (existing.endedAt === null) {
        // Adopt an unclaimed session: if the same-day row has no control
        // operator (typically because the auto-open scheduler created it with
        // controlOpId = null), the presser becomes net control. A session that
        // already has a control op keeps it — pressing "Open net" never steals
        // control from the current operator (use "change net control" for
        // that). The null-guard in the WHERE makes this race-safe: two
        // simultaneous pressers can't both win.
        await prisma.netSession.updateMany({
          where: { id: existing.id, controlOpId: null },
          data: { controlOpId: req.user!.id },
        });
        // Reuse the active session (prep or live).
        const reused = await prisma.netSession.findUnique({
          where: { id: existing.id },
          include: {
            topic: true,
            checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_DESC },
            net: {
              include: {
                repeater: true,
                links: { include: { repeater: true } },
              },
            },
            controlOp: { select: { callsign: true, name: true } },
          },
        });
        if (reused) liftSessionCheckInModes(reused);
        res.status(200).json({ ...reused, reused: true });
        return;
      }
      // Session already ended; refuse
      throw new HttpError(409, 'CONFLICT', 'A session for this net already exists today');
    }

    let topicId: string | null = null;
    let topicTitle: string | null = null;
    if (body.topicId) {
      const topic = await prisma.topicSuggestion.findUnique({ where: { id: body.topicId } });
      if (!topic) throw new HttpError(404, 'NOT_FOUND', 'Topic not found');
      topicId = topic.id;
      topicTitle = topic.title;
    } else if (body.topicTitle && body.topicTitle.trim().length > 0) {
      topicTitle = body.topicTitle.trim();
    }

    const created = await prisma.$transaction(async (tx) => {
      const session = await tx.netSession.create({
        data: {
          netId,
          startedAt: new Date(),
          // liveAt intentionally left null — the row is in PREP until the
          // operator presses START via POST /api/sessions/:id/start.
          liveAt: null,
          controlOpId: req.user!.id,
          topicId,
          topicTitle,
        },
        include: {
          topic: true,
          checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_DESC },
          net: {
            include: {
              repeater: true,
              links: { include: { repeater: true } },
            },
          },
          controlOp: { select: { callsign: true, name: true } },
        },
      });
      if (topicId) {
        await tx.topicSuggestion.update({
          where: { id: topicId },
          data: { status: 'USED' },
        });
      }
      return session;
    });
    liftSessionCheckInModes(created);
    res.status(201).json(created);
    // No Discord post here — the 🟢 notification is fired by /sessions/:id/start.
  }));

  // POST /api/sessions/:id/start — transition PREP → LIVE.
  //
  // Fires the Discord 🟢 announcement (moved here from the create route).
  // Validates that the session exists, is not soft-deleted, has not already
  // gone live (liveAt must be null), and has not already ended.
  flat.post('/:id/start', requireRole('NET_CONTROL'), asyncHandler(async (req, res) => {
    const session = await prisma.netSession.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    // Check the terminal state first — an ended session can't be restarted even
    // if it once went live. The "already live" guard catches the
    // currently-running case where liveAt is set but endedAt is still null.
    if (session.endedAt) {
      throw new HttpError(409, 'CONFLICT', 'Session has already ended');
    }
    if (session.liveAt) {
      throw new HttpError(409, 'CONFLICT', 'Session is already live');
    }
    // Shared core (also used by the auto-start scheduler): guard-update
    // PREP → LIVE, human null-fallback for controlOpId (the opener keeps
    // control — START never reassigns an existing control operator; only a
    // control-less session adopts the starter), and the Discord 🟢
    // announcement on a successful transition.
    const { transitioned, session: updated } = await startSession(prisma, session.id, req.user!.id);
    if (!transitioned) {
      // Lost the race between the pre-checks above and the guard-update
      // (e.g. the auto-start scheduler fired in between). Same contract as
      // the pre-check: the session is already live.
      throw new HttpError(409, 'CONFLICT', 'Session is already live');
    }
    if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    liftSessionCheckInModes(updated);
    res.status(200).json(updated);
  }));

  // Session reads are members-only. Every payload below carries the club's
  // participation log — member callsigns paired with the real names captured at
  // check-in — so an unauthenticated GET publishes the roster to anyone who
  // knows the URL. These three routes were the only ones on this router without
  // a guard; their mutating siblings have always required a role.
  flat.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { netId, from, to } = RangeQuery.parse(req.query);
    const list = await prisma.netSession.findMany({
      where: {
        deletedAt: null,
        ...(netId ? { netId } : {}),
        ...(from || to
          ? { startedAt: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } }
          : {}),
      },
      orderBy: { startedAt: 'desc' },
    });
    res.json(list);
  }));

  flat.get('/:id/summary', requireAuth, asyncHandler(async (req, res) => {
    const session = await prisma.netSession.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        topic: true,
        net: {
          include: {
            repeater: true,
            links: { include: { repeater: true } },
          },
        },
        checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_ASC },
        controlOp: { select: { callsign: true, name: true } },
      },
    });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    const { net, checkIns, ...rest } = session;
    const { repeater, links, ...netRest } = net;
    const payload = {
      session: rest,
      net: { ...netRest, links },
      repeater,
      checkIns: checkIns.map((ci) => withCheckInMode(ci)),
      stats: { count: checkIns.length },
    };
    redactScriptsForRole(payload, req.user?.role);
    res.json(payload);
  }));

  flat.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const s = await prisma.netSession.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        topic: true,
        checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_DESC },
        net: {
          include: {
            repeater: true,
            links: { include: { repeater: true } },
          },
        },
        controlOp: { select: { callsign: true, name: true } },
      },
    });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    liftSessionCheckInModes(s);
    redactScriptsForRole(s, req.user?.role);
    res.json(s);
  }));

  flat.delete('/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const existing = await prisma.netSession.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    await prisma.netSession.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  }));

  /**
   * Re-place the session's check-in log.
   *
   * Takes the COMPLETE list of that session's live check-in ids in the order
   * they should read, and rejects anything else. "Move id X to position 3"
   * would look simpler, but two operators tidying the same log — or one
   * retrying after a dropped connection — could interleave into an order
   * neither of them chose. Sending the whole list makes the write idempotent
   * and makes a stale tab fail loudly instead of silently reshuffling.
   *
   * checkedInAt is deliberately untouched: it records when the entry was
   * MADE, and rewriting it to fake a sort would falsify an FCC-facing log.
   */
  flat.patch('/:id/checkins/order', requireRole('NET_CONTROL'), asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const parsed = ReorderCheckInsInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION', 'Expected orderedIds: a list of check-in ids');
    }
    const { orderedIds } = parsed.data;

    const session = await prisma.netSession.findFirst({
      where: { id, deletedAt: null },
    });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');

    const live = await prisma.checkIn.findMany({
      where: { sessionId: id, deletedAt: null },
      select: { id: true },
    });

    // The submitted list must be exactly this session's live check-ins: same
    // count, no duplicates, nothing foreign, nothing missing. Anything else
    // means the client is working from a log that has since changed (someone
    // added or removed a station), and applying it would drop or duplicate a
    // position.
    const known = new Set(live.map((c) => c.id));
    const submitted = new Set(orderedIds);
    const sameSet =
      submitted.size === orderedIds.length &&
      orderedIds.length === live.length &&
      orderedIds.every((cid) => known.has(cid));
    if (!sameSet) {
      throw new HttpError(
        409,
        'CONFLICT',
        'The log changed while you were reordering it. Reload and try again.',
      );
    }

    await prisma.$transaction(
      orderedIds.map((cid, index) =>
        prisma.checkIn.update({ where: { id: cid }, data: { sequence: index + 1 } }),
      ),
    );

    const updated = await prisma.netSession.findUnique({
      where: { id },
      include: {
        topic: true,
        checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_DESC },
        controlOp: { select: { id: true, callsign: true, name: true } },
        net: { include: { repeater: true, links: { include: { repeater: true } } } },
      },
    });
    res.json(updated);
  }));

  flat.patch('/:id', requireRole('NET_CONTROL'), validateBody(NetSessionUpdate), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof NetSessionUpdate>;
    const before = await prisma.netSession.findUnique({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, endedAt: true, netId: true, startedAt: true },
    });
    if (!before) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    // The control op (when set) must be a real user. Reassigning control is
    // allowed on both in-progress sessions (live "change control") and ended
    // sessions (correcting a past net's log on the Stats page) — a finished
    // log is a legitimate thing to fix.
    if (body.controlOpId !== undefined) {
      const exists = await prisma.user.findUnique({
        where: { id: body.controlOpId },
        select: { id: true },
      });
      if (!exists) throw new HttpError(400, 'VALIDATION', 'Unknown control operator');
    }
    // Linking a topic suggestion (prep-view picker): validate the FK so a bad id
    // surfaces as a clean 404 instead of a Prisma constraint blow-up. Passing
    // null unlinks; omitting leaves the existing link untouched. A free-text
    // topic comes through as topicTitle-only and clears any prior link.
    if (body.topicId) {
      const topic = await prisma.topicSuggestion.findUnique({
        where: { id: body.topicId },
        select: { id: true },
      });
      if (!topic) throw new HttpError(404, 'NOT_FOUND', 'Topic not found');
    }
    const updated = await prisma.netSession.update({
      where: { id: req.params.id },
      data: {
        endedAt:
          body.endedAt === undefined ? undefined : body.endedAt ? new Date(body.endedAt) : null,
        notes: body.notes === undefined ? undefined : body.notes,
        controlOpId: body.controlOpId ?? undefined,
        topicTitle:
          body.topicTitle === undefined
            ? undefined
            : body.topicTitle && body.topicTitle.trim().length > 0
              ? body.topicTitle.trim()
              : null,
        // Keep topicId in sync: explicit id links, explicit null unlinks. When
        // topicId is absent but a free-text topicTitle was sent, drop any stale
        // link so the session's topic relation matches the new title.
        topicId:
          body.topicId !== undefined
            ? body.topicId
            : body.topicTitle !== undefined
              ? null
              : undefined,
      },
      include: {
        topic: true,
        net: { include: { repeater: true } },
        checkIns: { where: { deletedAt: null } },
        controlOp: { select: { callsign: true, name: true } },
      },
    });
    liftSessionCheckInModes(updated);
    res.json(updated);

    // Post Discord notification if session just ended (endedAt transitioned from null to non-null)
    const justEnded = before.endedAt === null && updated.endedAt !== null;
    if (justEnded) {
      void (async () => {
        try {
          const minutes = updated.endedAt
            ? Math.max(1, Math.round((updated.endedAt.getTime() - updated.startedAt.getTime()) / 60000))
            : 0;
          const checkInCount = updated.checkIns?.filter((c: CheckIn) => !c.deletedAt).length ?? 0;
          const freq = updated.net?.repeater?.frequency != null
            ? ` on ${updated.net.repeater.frequency.toFixed(3)} MHz`
            : '';
          const topic = updated.topicTitle ? ` · Topic: ${updated.topicTitle}` : '';
          const content = `🔴 **${updated.net?.name ?? 'Net'}** has ended${freq}${topic} · ${checkInCount} check-in(s) · ${minutes} min`;
          await postToDiscord(prisma, content);
        } catch { /* ignore */ }
      })();
    }
  }));

  return { nested, flat };
}
