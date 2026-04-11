import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { TopicSuggestionInput, UpdateTopicStatusInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

export function topicsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const rows = await prisma.topicSuggestion.findMany({
        orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { callsign: true, name: true } } },
      });
      res.json(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          details: r.details,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          createdById: r.createdById,
          createdByCallsign: r.createdBy.callsign,
          createdByName: r.createdBy.name,
        })),
      );
    }),
  );

  router.post(
    '/',
    requireAuth,
    validateBody(TopicSuggestionInput),
    asyncHandler(async (req, res) => {
      const body = req.body as typeof TopicSuggestionInput._type;
      const created = await prisma.topicSuggestion.create({
        data: {
          title: body.title,
          details: body.details ?? null,
          createdById: req.user!.id,
        },
      });
      res.status(201).json(created);
    }),
  );

  router.patch(
    '/:id/status',
    requireRole('OFFICER'),
    validateBody(UpdateTopicStatusInput),
    asyncHandler(async (req, res) => {
      try {
        const updated = await prisma.topicSuggestion.update({
          where: { id: req.params.id },
          data: {
            status: (req.body as typeof UpdateTopicStatusInput._type).status,
          },
        });
        res.json(updated);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'Topic not found');
      }
    }),
  );

  router.delete(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const t = await prisma.topicSuggestion.findUnique({
        where: { id: req.params.id },
      });
      if (!t) throw new HttpError(404, 'NOT_FOUND', 'Topic not found');
      const me = req.user!;
      const isOfficer = me.role === 'OFFICER' || me.role === 'ADMIN';
      if (!isOfficer && (t.createdById !== me.id || t.status !== 'OPEN')) {
        throw new HttpError(403, 'FORBIDDEN', 'Cannot delete this topic');
      }
      await prisma.topicSuggestion.delete({ where: { id: t.id } });
      res.status(204).end();
    }),
  );

  return router;
}
