import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { NetInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

export function netsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const list = await prisma.net.findMany({
      orderBy: [{ dayOfWeek: 'asc' }, { startLocal: 'asc' }],
      include: { repeater: true },
    });
    res.json(list);
  }));

  router.post('/', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetInput._type;
    const created = await prisma.net.create({
      data: {
        name: body.name, repeaterId: body.repeaterId,
        dayOfWeek: body.dayOfWeek, startLocal: body.startLocal,
        timezone: body.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
        active: body.active ?? true,
      },
    });
    res.status(201).json(created);
  }));

  router.patch('/:id', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetInput._type;
    try {
      const updated = await prisma.net.update({
        where: { id: req.params.id },
        data: {
          name: body.name, repeaterId: body.repeaterId,
          dayOfWeek: body.dayOfWeek, startLocal: body.startLocal,
          timezone: body.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
          active: body.active ?? true,
        },
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    }
  }));

  router.delete('/:id', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    try {
      await prisma.net.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    }
  }));

  return router;
}
