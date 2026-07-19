import { Router } from 'express';
import { PrismaClient, CheckIn } from '@prisma/client';
import { z } from 'zod';
import { NetSessionUpdate } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { redactScriptsForRole } from '../lib/scriptGate.js';
import { findSameDaySession } from '../lib/sessionDedupe.js';
import { postToDiscord } from '../discord/client.js';
import { withCheckInMode } from '../lib/checkinMode.js';

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
    const existing = await findSameDaySession(prisma, netId, new Date());
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
            checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'desc' } },
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
          checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'desc' } },
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
    const updated = await prisma.netSession.update({
      where: { id: session.id },
      data: {
        liveAt: new Date(),
        // The opener keeps control: START never reassigns an existing control
        // operator (someone else pressing Start must not steal the net). Only
        // when the session has no control op at all (legacy/edge rows — the
        // open route and dedupe path normally assign one) does the starter
        // become control, so a live net is never left control-less.
        ...(session.controlOpId === null ? { controlOpId: req.user!.id } : {}),
      },
      include: {
        topic: true,
        checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'desc' } },
        net: {
          include: {
            repeater: true,
            links: { include: { repeater: true } },
          },
        },
        controlOp: { select: { callsign: true, name: true } },
      },
    });
    liftSessionCheckInModes(updated);
    res.status(200).json(updated);
    // Fire-and-forget Discord "now live" notification — moved from the
    // session-create route so the 🟢 ping happens at the actual START moment.
    void (async () => {
      try {
        const repeater = updated.net?.repeater;
        const freq = repeater?.frequency != null ? `${repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = repeater?.name ? ` (${repeater.name})` : '';
        const topicLine = updated.topicTitle ? ` · Topic: ${updated.topicTitle}` : '';
        const content =
          `🟢 **${updated.net.name}** is now live on ${freq}${repeaterName}${topicLine}`;
        await postToDiscord(prisma, content);
      } catch { /* ignore */ }
    })();
  }));

  flat.get('/', asyncHandler(async (req, res) => {
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

  flat.get('/:id/summary', asyncHandler(async (req, res) => {
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
        checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'asc' } },
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

  flat.get('/:id', asyncHandler(async (req, res) => {
    const s = await prisma.netSession.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        topic: true,
        checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'desc' } },
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
