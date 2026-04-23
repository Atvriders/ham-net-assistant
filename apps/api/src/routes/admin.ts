import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

const TRASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function adminRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/trash', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    const cutoff = new Date(Date.now() - TRASH_WINDOW_MS);

    const sessionsRaw = await prisma.netSession.findMany({
      where: { deletedAt: { not: null, gte: cutoff } },
      include: {
        net: { select: { id: true, name: true } },
        controlOp: { select: { callsign: true, name: true } },
      },
      orderBy: { deletedAt: 'desc' },
    });
    const sessionIds = sessionsRaw.map((s) => s.id);
    const counts = sessionIds.length
      ? await prisma.checkIn.groupBy({
          by: ['sessionId'],
          where: { sessionId: { in: sessionIds }, deletedAt: null },
          _count: { _all: true },
        })
      : [];
    const countMap = new Map<string, number>();
    for (const c of counts) countMap.set(c.sessionId, c._count._all);

    const sessions = sessionsRaw.map((s) => ({
      id: s.id,
      netId: s.netId,
      netName: s.net.name,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      deletedAt: s.deletedAt ? s.deletedAt.toISOString() : null,
      topic: s.topicTitle ?? null,
      controlOp: s.controlOp
        ? { callsign: s.controlOp.callsign, name: s.controlOp.name }
        : null,
      checkInCount: countMap.get(s.id) ?? 0,
    }));

    const checkInsRaw = await prisma.checkIn.findMany({
      where: { deletedAt: { not: null, gte: cutoff } },
      include: {
        session: { include: { net: { select: { name: true } } } },
      },
      orderBy: { deletedAt: 'desc' },
    });
    const checkIns = checkInsRaw.map((ci) => ({
      id: ci.id,
      sessionId: ci.sessionId,
      netName: ci.session.net.name,
      callsign: ci.callsign,
      nameAtCheckIn: ci.nameAtCheckIn,
      checkedInAt: ci.checkedInAt.toISOString(),
      deletedAt: ci.deletedAt ? ci.deletedAt.toISOString() : null,
    }));

    res.json({ sessions, checkIns });
  }));

  router.post('/trash/sessions/:id/restore', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const s = await prisma.netSession.findUnique({ where: { id: req.params.id } });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    if (!s.deletedAt) {
      res.json({ ok: true, alreadyRestored: true });
      return;
    }
    await prisma.netSession.update({
      where: { id: s.id },
      data: { deletedAt: null },
    });
    res.json({ ok: true });
  }));

  router.post('/trash/checkins/:id/restore', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const ci = await prisma.checkIn.findUnique({
      where: { id: req.params.id },
      include: { session: { select: { deletedAt: true } } },
    });
    if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    if (ci.deletedAt) {
      await prisma.checkIn.update({
        where: { id: ci.id },
        data: { deletedAt: null },
      });
    }
    const parentSoftDeleted = ci.session.deletedAt !== null;
    res.json({ ok: true, parentSoftDeleted });
  }));

  router.delete('/trash/sessions/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    try {
      await prisma.netSession.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    }
  }));

  router.delete('/trash/checkins/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    try {
      await prisma.checkIn.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    }
  }));

  return router;
}
