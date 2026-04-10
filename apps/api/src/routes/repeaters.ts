import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { RepeaterInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

export function repeatersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const list = await prisma.repeater.findMany({ orderBy: { name: 'asc' } });
    res.json(list);
  }));

  router.post('/', requireRole('OFFICER'), validateBody(RepeaterInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof RepeaterInput._type;
    const created = await prisma.repeater.create({
      data: {
        name: body.name,
        frequency: body.frequency,
        offsetKhz: body.offsetKhz,
        toneHz: body.toneHz ?? null,
        mode: body.mode,
        coverage: body.coverage ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
      },
    });
    res.status(201).json(created);
  }));

  router.patch('/:id', requireRole('OFFICER'), validateBody(RepeaterInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof RepeaterInput._type;
    try {
      const updated = await prisma.repeater.update({
        where: { id: req.params.id },
        data: {
          name: body.name,
          frequency: body.frequency,
          offsetKhz: body.offsetKhz,
          toneHz: body.toneHz ?? null,
          mode: body.mode,
          coverage: body.coverage ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
        },
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Repeater not found');
    }
  }));

  router.delete('/:id', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    try {
      await prisma.repeater.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Repeater not found');
    }
  }));

  return router;
}
