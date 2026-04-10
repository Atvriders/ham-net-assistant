import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { NetSessionUpdate } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

export function sessionsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  nested.post('/', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    const { netId } = req.params as { netId: string };
    const net = await prisma.net.findUnique({ where: { id: netId } });
    if (!net) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    const created = await prisma.netSession.create({
      data: { netId, startedAt: new Date(), controlOpId: req.user!.id },
    });
    res.status(201).json(created);
  }));

  flat.get('/', asyncHandler(async (req, res) => {
    const { netId, from, to } = req.query as Record<string, string | undefined>;
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

  flat.get('/:id', asyncHandler(async (req, res) => {
    const s = await prisma.netSession.findUnique({
      where: { id: req.params.id },
      include: { checkIns: { orderBy: { checkedInAt: 'desc' } } },
    });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    res.json(s);
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
