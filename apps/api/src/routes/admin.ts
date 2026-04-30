import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

const TRASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface DuplicateSessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  topicTitle: string | null;
  controlOpCallsign: string | null;
  controlOpName: string | null;
  checkInCount: number;
}

interface DuplicateGroup {
  netId: string;
  netName: string;
  date: string;
  sessions: DuplicateSessionRow[];
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadDuplicateGroups(prisma: PrismaClient): Promise<DuplicateGroup[]> {
  const all = await prisma.netSession.findMany({
    where: { deletedAt: null },
    include: {
      net: { select: { name: true } },
      controlOp: { select: { callsign: true, name: true } },
      _count: { select: { checkIns: { where: { deletedAt: null } } } },
    },
    orderBy: { startedAt: 'asc' },
  });

  const groupsMap = new Map<string, DuplicateGroup>();
  for (const s of all) {
    const dateKey = localDateKey(s.startedAt);
    const key = `${s.netId}|${dateKey}`;
    let g = groupsMap.get(key);
    if (!g) {
      g = {
        netId: s.netId,
        netName: s.net.name,
        date: dateKey,
        sessions: [],
      };
      groupsMap.set(key, g);
    }
    g.sessions.push({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      topicTitle: s.topicTitle ?? null,
      controlOpCallsign: s.controlOp ? s.controlOp.callsign : null,
      controlOpName: s.controlOp ? s.controlOp.name : null,
      checkInCount: s._count.checkIns,
    });
  }

  const dupGroups = Array.from(groupsMap.values()).filter((g) => g.sessions.length > 1);
  // Order: date desc, then within group by startedAt asc (already asc from query)
  dupGroups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return dupGroups;
}

async function mergeGroup(
  prisma: PrismaClient,
  keepSessionId: string,
  mergeSessionIds: string[],
): Promise<{ keptSessionId: string; mergedCount: number; mergedCheckIns: number }> {
  if (mergeSessionIds.length === 0) {
    throw new HttpError(400, 'VALIDATION', 'mergeSessionIds is empty');
  }
  if (mergeSessionIds.includes(keepSessionId)) {
    throw new HttpError(400, 'VALIDATION', 'keepSessionId must not appear in mergeSessionIds');
  }

  return prisma.$transaction(async (tx) => {
    const ids = [keepSessionId, ...mergeSessionIds];
    const sessions = await tx.netSession.findMany({
      where: { id: { in: ids } },
    });
    if (sessions.length !== ids.length) {
      throw new HttpError(400, 'VALIDATION', 'One or more sessions not found');
    }
    for (const s of sessions) {
      if (s.deletedAt) {
        throw new HttpError(400, 'VALIDATION', 'Cannot merge a soft-deleted session');
      }
    }
    const keeper = sessions.find((s) => s.id === keepSessionId);
    if (!keeper) {
      throw new HttpError(400, 'VALIDATION', 'Keeper session not found');
    }
    const keeperDay = localDateKey(keeper.startedAt);
    for (const s of sessions) {
      if (s.netId !== keeper.netId) {
        throw new HttpError(400, 'VALIDATION', 'All sessions must belong to the same net');
      }
      if (localDateKey(s.startedAt) !== keeperDay) {
        throw new HttpError(400, 'VALIDATION', 'All sessions must fall on the same calendar day');
      }
    }

    // Re-parent check-ins. For each merged session, walk its check-ins; if a
    // check-in with the same callsign+nameAtCheckIn already exists on the
    // keeper, hard-delete the duplicate and keep the earliest checkedInAt on
    // the keeper. Otherwise reassign the check-in to the keeper.
    let mergedCheckIns = 0;
    for (const mergeId of mergeSessionIds) {
      const cis = await tx.checkIn.findMany({
        where: { sessionId: mergeId, deletedAt: null },
        orderBy: { checkedInAt: 'asc' },
      });
      for (const ci of cis) {
        const existing = await tx.checkIn.findFirst({
          where: {
            sessionId: keepSessionId,
            callsign: ci.callsign,
            nameAtCheckIn: ci.nameAtCheckIn,
            deletedAt: null,
          },
        });
        if (existing) {
          // Keep earliest checkedInAt on the keeper.
          if (ci.checkedInAt < existing.checkedInAt) {
            await tx.checkIn.update({
              where: { id: existing.id },
              data: { checkedInAt: ci.checkedInAt },
            });
          }
          await tx.checkIn.delete({ where: { id: ci.id } });
        } else {
          await tx.checkIn.update({
            where: { id: ci.id },
            data: { sessionId: keepSessionId },
          });
          mergedCheckIns++;
        }
      }
      // Also re-parent any soft-deleted check-ins so the trash row points at
      // the kept session (avoids dangling).
      await tx.checkIn.updateMany({
        where: { sessionId: mergeId, deletedAt: { not: null } },
        data: { sessionId: keepSessionId },
      });
    }

    // Re-parent SessionMessage rows to the keeper.
    for (const mergeId of mergeSessionIds) {
      await tx.sessionMessage.updateMany({
        where: { sessionId: mergeId },
        data: { sessionId: keepSessionId },
      });
    }

    // Topic and control op transfer.
    let newTopicTitle = keeper.topicTitle ?? null;
    let newTopicId = keeper.topicId ?? null;
    let newControlOpId = keeper.controlOpId ?? null;
    for (const s of sessions.filter((x) => x.id !== keepSessionId)) {
      if (s.topicTitle) {
        if (!newTopicTitle) {
          newTopicTitle = s.topicTitle;
        } else if (newTopicTitle !== s.topicTitle) {
          const combined = `${newTopicTitle}; ${s.topicTitle}`;
          newTopicTitle = combined.length > 200 ? combined.slice(0, 200) : combined;
        }
      }
      if (!newTopicId && s.topicId) newTopicId = s.topicId;
      if (!newControlOpId && s.controlOpId) newControlOpId = s.controlOpId;
    }

    await tx.netSession.update({
      where: { id: keepSessionId },
      data: {
        topicTitle: newTopicTitle,
        topicId: newTopicId,
        controlOpId: newControlOpId,
      },
    });

    // Soft-delete merged sessions.
    const now = new Date();
    await tx.netSession.updateMany({
      where: { id: { in: mergeSessionIds } },
      data: { deletedAt: now },
    });

    return {
      keptSessionId: keepSessionId,
      mergedCount: mergeSessionIds.length,
      mergedCheckIns,
    };
  });
}

const MergeInput = z.object({
  keepSessionId: z.string().min(1),
  mergeSessionIds: z.array(z.string().min(1)).min(1),
});

const AutoMergeInput = z.object({
  strategy: z.enum(['most-checkins', 'earliest']).optional(),
});

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

  router.get('/duplicate-sessions', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    const groups = await loadDuplicateGroups(prisma);
    res.json(groups);
  }));

  router.post('/duplicate-sessions/merge', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const parsed = MergeInput.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION', 'Invalid merge body');
    }
    const result = await mergeGroup(
      prisma,
      parsed.data.keepSessionId,
      parsed.data.mergeSessionIds,
    );
    res.json({ ok: true, ...result });
  }));

  router.post('/duplicate-sessions/auto-merge-all', requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const parsed = AutoMergeInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION', 'Invalid auto-merge body');
    }
    const strategy = parsed.data.strategy ?? 'most-checkins';
    const groups = await loadDuplicateGroups(prisma);

    let groupsMerged = 0;
    let sessionsMerged = 0;
    let checkInsMoved = 0;
    for (const g of groups) {
      // Pick keeper.
      let keeper = g.sessions[0]!;
      if (strategy === 'most-checkins') {
        for (const s of g.sessions) {
          if (
            s.checkInCount > keeper.checkInCount ||
            (s.checkInCount === keeper.checkInCount && s.startedAt < keeper.startedAt)
          ) {
            keeper = s;
          }
        }
      } else {
        for (const s of g.sessions) {
          if (s.startedAt < keeper.startedAt) keeper = s;
        }
      }
      const mergeIds = g.sessions.filter((s) => s.id !== keeper.id).map((s) => s.id);
      if (mergeIds.length === 0) continue;
      const r = await mergeGroup(prisma, keeper.id, mergeIds);
      groupsMerged++;
      sessionsMerged += r.mergedCount;
      checkInsMoved += r.mergedCheckIns;
    }

    res.json({ groupsMerged, sessionsMerged, checkInsMoved });
  }));

  return router;
}
