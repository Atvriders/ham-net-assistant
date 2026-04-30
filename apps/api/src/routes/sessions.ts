import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NetSessionUpdate } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { redactScriptsForRole } from '../lib/scriptGate.js';
import { findSameDaySession } from '../lib/sessionDedupe.js';
import { postToDiscord } from '../discord/client.js';

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

  nested.post('/', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    const { netId } = req.params as { netId: string };
    const body = req.body && Object.keys(req.body).length > 0
      ? StartSessionInput.parse(req.body)
      : { topicId: undefined as string | undefined, topicTitle: undefined as string | undefined };
    const net = await prisma.net.findUnique({ where: { id: netId } });
    if (!net) throw new HttpError(404, 'NOT_FOUND', 'Net not found');

    // Check for existing same-day session
    const existing = await findSameDaySession(prisma, netId, new Date());
    if (existing) {
      if (existing.endedAt === null) {
        // Reuse the active session
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
    res.status(201).json(created);
    // Fire-and-forget Discord "now live" notification. Only on truly new sessions
    // (we already returned early above when reusing an active same-day session).
    void (async () => {
      try {
        const repeater = created.net?.repeater;
        const freq = repeater?.frequency != null ? `${repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = repeater?.name ? ` (${repeater.name})` : '';
        const topicLine = created.topicTitle ? ` · Topic: ${created.topicTitle}` : '';
        const content =
          `🟢 **${created.net.name}** is now live on ${freq}${repeaterName}${topicLine}`;
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
      checkIns,
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

  flat.patch('/:id', requireRole('OFFICER'), validateBody(NetSessionUpdate), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetSessionUpdate._type;
    const before = await prisma.netSession.findUnique({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, endedAt: true, netId: true, startedAt: true },
    });
    if (!before) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    const updated = await prisma.netSession.update({
      where: { id: req.params.id },
      data: {
        endedAt:
          body.endedAt === undefined ? undefined : body.endedAt ? new Date(body.endedAt) : null,
        notes: body.notes === undefined ? undefined : body.notes,
        controlOpId: body.controlOpId ?? undefined,
      },
      include: {
        net: { include: { repeater: true } },
        checkIns: { where: { deletedAt: null } },
      },
    });
    res.json(updated);

    // Post Discord notification if session just ended (endedAt transitioned from null to non-null)
    const justEnded = before.endedAt === null && updated.endedAt !== null;
    if (justEnded) {
      void (async () => {
        try {
          const minutes = updated.endedAt
            ? Math.max(1, Math.round((updated.endedAt.getTime() - updated.startedAt.getTime()) / 60000))
            : 0;
          const checkInCount = updated.checkIns?.filter((c: any) => !c.deletedAt).length ?? 0;
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
