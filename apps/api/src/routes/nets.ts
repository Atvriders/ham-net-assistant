import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { NetInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

const netInclude = {
  repeater: true,
  links: { include: { repeater: true } },
} as const;

function normalizeLinkedIds(
  linkedRepeaterIds: string[] | undefined,
  primaryRepeaterId: string,
): string[] {
  if (!linkedRepeaterIds) return [];
  const deduped = Array.from(new Set(linkedRepeaterIds));
  return deduped.filter((id) => id !== primaryRepeaterId);
}

async function assertRepeatersExist(prisma: PrismaClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await prisma.repeater.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    throw new HttpError(400, 'VALIDATION', 'Unknown repeater in linkedRepeaterIds');
  }
}

export function netsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const list = await prisma.net.findMany({
      orderBy: [{ dayOfWeek: 'asc' }, { startLocal: 'asc' }],
      include: netInclude,
    });
    res.json(list);
  }));

  router.post('/', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetInput._type;
    const linkIds = normalizeLinkedIds(body.linkedRepeaterIds, body.repeaterId);
    await assertRepeatersExist(prisma, linkIds);
    const created = await prisma.$transaction(async (tx) => {
      const net = await tx.net.create({
        data: {
          name: body.name, repeaterId: body.repeaterId,
          dayOfWeek: body.dayOfWeek, startLocal: body.startLocal,
          timezone: body.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
          active: body.active ?? true,
        },
      });
      if (linkIds.length) {
        await tx.netLink.createMany({
          data: linkIds.map((repeaterId) => ({ netId: net.id, repeaterId })),
        });
      }
      return tx.net.findUniqueOrThrow({ where: { id: net.id }, include: netInclude });
    });
    res.status(201).json(created);
  }));

  router.patch('/:id', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetInput._type;
    const netId = req.params.id as string;
    const existing = await prisma.net.findUnique({ where: { id: netId } });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    const touchLinks = body.linkedRepeaterIds !== undefined;
    const linkIds = touchLinks
      ? normalizeLinkedIds(body.linkedRepeaterIds, body.repeaterId)
      : [];
    if (touchLinks) await assertRepeatersExist(prisma, linkIds);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        await tx.net.update({
          where: { id: netId },
          data: {
            name: body.name, repeaterId: body.repeaterId,
            dayOfWeek: body.dayOfWeek, startLocal: body.startLocal,
            timezone: body.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
            active: body.active ?? true,
          },
        });
        if (touchLinks) {
          await tx.netLink.deleteMany({ where: { netId: netId } });
          if (linkIds.length) {
            await tx.netLink.createMany({
              data: linkIds.map((repeaterId) => ({ netId: netId, repeaterId })),
            });
          }
        }
        return tx.net.findUniqueOrThrow({ where: { id: netId }, include: netInclude });
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
