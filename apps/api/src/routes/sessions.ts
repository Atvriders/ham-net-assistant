import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NetSessionUpdate } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

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
  }));

  flat.get('/', asyncHandler(async (req, res) => {
    const { netId, from, to } = RangeQuery.parse(req.query);
    const list = await prisma.netSession.findMany({
      where: {
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
    const session = await prisma.netSession.findUnique({
      where: { id: req.params.id },
      include: {
        topic: true,
        net: {
          include: {
            repeater: true,
            links: { include: { repeater: true } },
          },
        },
        checkIns: { orderBy: { checkedInAt: 'asc' } },
      },
    });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    const { net, checkIns, ...rest } = session;
    const { repeater, links, ...netRest } = net;
    res.json({
      session: rest,
      net: { ...netRest, links },
      repeater,
      checkIns,
      stats: { count: checkIns.length },
    });
  }));

  flat.get('/:id', asyncHandler(async (req, res) => {
    const s = await prisma.netSession.findUnique({
      where: { id: req.params.id },
      include: {
        topic: true,
        checkIns: { orderBy: { checkedInAt: 'desc' } },
        net: {
          include: {
            repeater: true,
            links: { include: { repeater: true } },
          },
        },
      },
    });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    res.json(s);
  }));

  flat.delete('/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    try {
      await prisma.netSession.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    }
  }));

  flat.patch('/:id', requireRole('OFFICER'), validateBody(NetSessionUpdate), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetSessionUpdate._type;
    try {
      const updated = await prisma.netSession.update({
        where: { id: req.params.id },
        data: {
          endedAt:
            body.endedAt === undefined ? undefined : body.endedAt ? new Date(body.endedAt) : null,
          notes: body.notes === undefined ? undefined : body.notes,
        },
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    }
  }));

  return { nested, flat };
}
