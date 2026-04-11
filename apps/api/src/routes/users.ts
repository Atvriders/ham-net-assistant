// NOTE: callsigns are IMMUTABLE after registration. No endpoint allows
// changing a user's callsign. N0CALL placeholder stays N0CALL.
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { UpdateMeInput, UpdateRoleInput, PublicUser } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

const publicSelect = {
  id: true,
  email: true,
  name: true,
  callsign: true,
  role: true,
  collegeSlug: true,
} as const;

export function usersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.patch('/me', requireAuth, validateBody(UpdateMeInput.strict()), asyncHandler(async (req, res) => {
    const body = req.body as typeof UpdateMeInput._type;
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        name: body.name ?? undefined,
        collegeSlug: body.collegeSlug === undefined ? undefined : body.collegeSlug,
      },
      select: publicSelect,
    });
    res.json(PublicUser.parse(updated));
  }));

  router.get('/directory', requireAuth, asyncHandler(async (_req, res) => {
    const list = await prisma.user.findMany({
      select: { callsign: true, name: true },
      orderBy: { callsign: 'asc' },
    });
    res.json(list);
  }));

  router.get('/', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: publicSelect,
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map((u) => PublicUser.parse(u)));
  }));

  router.delete('/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id === req.user!.id) {
      throw new HttpError(400, 'VALIDATION', 'Cannot delete your own account');
    }
    try {
      await prisma.user.delete({ where: { id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'User not found');
    }
  }));

  router.patch(
    '/:id',
    requireRole('ADMIN'),
    validateBody(
      z.object({
        collegeSlug: z.string().max(40).nullable().optional(),
      }).strict(),
    ),
    asyncHandler(async (req, res) => {
      try {
        const updated = await prisma.user.update({
          where: { id: req.params.id },
          data: { collegeSlug: (req.body as { collegeSlug?: string | null }).collegeSlug },
          select: publicSelect,
        });
        res.json(PublicUser.parse(updated));
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'User not found');
      }
    }),
  );

  router.patch('/:id/role', requireRole('ADMIN'), validateBody(UpdateRoleInput), asyncHandler(async (req, res) => {
    try {
      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: { role: (req.body as typeof UpdateRoleInput._type).role },
        select: publicSelect,
      });
      res.json(PublicUser.parse(updated));
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'User not found');
    }
  }));

  return router;
}
