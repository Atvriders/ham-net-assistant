import { Router } from 'express';
import type { z } from 'zod';
import { PrismaClient, Prisma } from '@prisma/client';
import { NetScriptInput, ScriptCategory } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

const scriptInclude = {
  createdBy: { select: { callsign: true, name: true } },
} as const;

type ScriptRow = Prisma.NetScriptGetPayload<{ include: typeof scriptInclude }>;

function serialize(row: ScriptRow) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    body: row.body,
    createdById: row.createdById,
    createdByCallsign: row.createdBy?.callsign,
    createdByName: row.createdBy?.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function scriptsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      const rawCategory = typeof req.query.category === 'string' ? req.query.category : undefined;
      const category = rawCategory ? ScriptCategory.parse(rawCategory) : undefined;
      const rows = await prisma.netScript.findMany({
        where: {
          deletedAt: null,
          ...(category ? { category } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }],
        include: scriptInclude,
      });
      res.json(rows.map(serialize));
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const row = await prisma.netScript.findFirst({
        where: { id: req.params.id, deletedAt: null },
        include: scriptInclude,
      });
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'Script not found');
      res.json(serialize(row));
    }),
  );

  router.post(
    '/',
    requireRole('OFFICER'),
    validateBody(NetScriptInput),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof NetScriptInput>;
      const created = await prisma.netScript.create({
        data: {
          title: body.title,
          category: body.category ?? 'general',
          body: body.body,
          createdById: req.user!.id,
        },
        include: scriptInclude,
      });
      res.status(201).json(serialize(created));
    }),
  );

  router.patch(
    '/:id',
    requireRole('OFFICER'),
    validateBody(NetScriptInput),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof NetScriptInput>;
      const existing = await prisma.netScript.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Script not found');
      const updated = await prisma.netScript.update({
        where: { id: existing.id },
        data: {
          title: body.title,
          category: body.category ?? existing.category,
          body: body.body,
        },
        include: scriptInclude,
      });
      res.json(serialize(updated));
    }),
  );

  router.delete(
    '/:id',
    requireRole('OFFICER'),
    asyncHandler(async (req, res) => {
      const existing = await prisma.netScript.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Script not found');
      await prisma.netScript.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      res.status(204).end();
    }),
  );

  return router;
}
