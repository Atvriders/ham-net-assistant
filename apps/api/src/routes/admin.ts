import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { lookupCallsignName } from '../lib/callsignNameLookup.js';
import { dayKeyInTz } from '../lib/sessionDedupe.js';
import { isUlsImportRunning, runUlsImport } from '../lib/ulsImport.js';
import { env } from '../env.js';

const TRASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Ceiling on how many check-in rows one backfill request pulls out of the DB.
 * Without it the handler streamed the entire table into memory before doing
 * any work.
 */
const BACKFILL_SCAN_LIMIT = 20_000;

/**
 * Ceiling on how many distinct callsigns one backfill request resolves. Each
 * one costs an upstream FCC lookup, so an uncapped run held the HTTP request
 * open for minutes (and the browser gave up long before the server did).
 * Repaired rows stop matching the candidate filter, so re-running the tool
 * walks the remaining backlog.
 */
const BACKFILL_CALLSIGN_LIMIT = 250;

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

/**
 * The "net night" a session belongs to, keyed in the net's own timezone.
 *
 * This tool exists to clean up duplicate sessions, and the duplicates it has
 * to find are precisely the ones created either side of 00:00 UTC on a US
 * evening net. Grouping by the *server's* local day filed those two rows under
 * two different dates, so the pair never appeared as a duplicate group at all
 * and the merge button could not reach them.
 */
function sessionDayKey(startedAt: Date, timezone: string | null | undefined): string {
  return dayKeyInTz(timezone || 'UTC', startedAt);
}

async function loadDuplicateGroups(prisma: PrismaClient): Promise<DuplicateGroup[]> {
  const all = await prisma.netSession.findMany({
    where: { deletedAt: null },
    include: {
      net: { select: { name: true, timezone: true } },
      controlOp: { select: { callsign: true, name: true } },
      _count: { select: { checkIns: { where: { deletedAt: null } } } },
    },
    orderBy: { startedAt: 'asc' },
  });

  const groupsMap = new Map<string, DuplicateGroup>();
  for (const s of all) {
    const dateKey = sessionDayKey(s.startedAt, s.net.timezone);
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
      include: { net: { select: { timezone: true } } },
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
    // Same-net is enforced first, so every row's day key can be compared in the
    // keeper net's timezone.
    const keeperDay = sessionDayKey(keeper.startedAt, keeper.net.timezone);
    for (const s of sessions) {
      if (s.netId !== keeper.netId) {
        throw new HttpError(400, 'VALIDATION', 'All sessions must belong to the same net');
      }
      if (sessionDayKey(s.startedAt, s.net.timezone) !== keeperDay) {
        throw new HttpError(400, 'VALIDATION', 'All sessions must fall on the same calendar day');
      }
    }

    // Re-parent check-ins. For each merged session, walk its check-ins; if a
    // check-in with the same callsign+nameAtCheckIn already exists on the
    // keeper, soft-delete the duplicate and keep the earliest checkedInAt on
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
          // Soft-delete, never hard-delete: "same callsign + same name" is a
          // heuristic, and a legitimate second check-in (a member who came
          // back later in the net, or two operators sharing a club call) looks
          // exactly like a duplicate. Every other deletion path in the app is
          // recoverable from the 30-day trash; an admin merge must be too.
          // The updateMany below then re-parents it onto the keeper so the
          // trash row doesn't dangle off a soft-deleted session.
          await tx.checkIn.update({
            where: { id: ci.id },
            data: { deletedAt: new Date() },
          });
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

const BackfillScope = z.union([
  z.object({ scope: z.literal('all') }),
  z.object({ scope: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({ scope: z.literal('net'), netId: z.string().min(1) }),
  z.object({
    scope: z.literal('range'),
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
]);

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
    const parsed = MergeInput.safeParse(req.body ?? {});
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

  router.post(
    '/backfill-names',
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      const raw = req.body && Object.keys(req.body).length > 0 ? req.body : { scope: 'all' };
      const parsed = BackfillScope.safeParse(raw);
      if (!parsed.success) {
        throw new HttpError(400, 'VALIDATION', 'Invalid backfill scope');
      }
      const body = parsed.data;
      const where: {
        deletedAt: null;
        sessionId?: string;
        session?: {
          deletedAt: null;
          netId?: string;
          startedAt?: { gte: Date; lte: Date };
        };
      } = { deletedAt: null };
      if (body.scope === 'session') {
        where.sessionId = body.sessionId;
      } else if (body.scope === 'net') {
        where.session = { deletedAt: null, netId: body.netId };
      } else if (body.scope === 'range') {
        where.session = {
          deletedAt: null,
          startedAt: { gte: new Date(body.from), lte: new Date(body.to) },
        };
      }

      // Pull a bounded candidate set and filter in JS — Prisma can't express
      // a column-to-column comparison (nameAtCheckIn === callsign). Ask for one
      // row past the limit so we can tell the admin whether more remain.
      const candidates = await prisma.checkIn.findMany({
        where,
        select: { id: true, callsign: true, nameAtCheckIn: true },
        orderBy: { checkedInAt: 'desc' },
        take: BACKFILL_SCAN_LIMIT + 1,
      });
      const scanTruncated = candidates.length > BACKFILL_SCAN_LIMIT;
      const filtered = candidates.slice(0, BACKFILL_SCAN_LIMIT).filter((c) => {
        const n = (c.nameAtCheckIn ?? '').trim();
        return n === '' || n === c.callsign;
      });

      // Group by callsign before doing any work. The old loop issued one FCC
      // lookup and one UPDATE per *row*, so a club with a few thousand
      // imported check-ins meant thousands of round trips inside a single
      // request; the same callsign now costs one lookup and one UPDATE
      // regardless of how many nets that operator has been on.
      const byCallsign = new Map<string, string[]>();
      for (const c of filtered) {
        const ids = byCallsign.get(c.callsign);
        if (ids) ids.push(c.id);
        else byCallsign.set(c.callsign, [c.id]);
      }
      const batch = [...byCallsign.entries()].slice(0, BACKFILL_CALLSIGN_LIMIT);
      const capped = scanTruncated || byCallsign.size > BACKFILL_CALLSIGN_LIMIT;

      const cache = new Map<string, string | null>();
      // `scanned` counts the check-in ROWS this run actually considered, so a
      // capped run reports the work it did rather than the size of the backlog.
      const scanned = batch.reduce((n, [, ids]) => n + ids.length, 0);
      let updated = 0;
      // Distinct callsigns the FCC lookup resolved (not rows) — with grouping
      // one lookup can repair many rows, which is the point.
      let lookedUp = 0;

      const queue = [...batch];
      async function worker(): Promise<void> {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry) return;
          const [callsign, ids] = entry;
          const found = await lookupCallsignName(prisma, callsign, cache);
          if (found) {
            lookedUp += 1;
            // One UPDATE per callsign instead of one per row.
            const repaired = await prisma.checkIn.updateMany({
              where: { id: { in: ids } },
              data: { nameAtCheckIn: found },
            });
            updated += repaired.count;
          }
        }
      }
      const workerCount = Math.max(1, Math.min(4, queue.length));
      if (workerCount > 0) {
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
      }

      // `capped` tells the admin UI "there is more backlog — run it again".
      // Newest-first ordering means a repeated run makes visible progress on
      // the log people are actually looking at.
      res.json({ scanned, updated, lookedUp, capped });
    }),
  );

  // ── FCC ULS mirror ────────────────────────────────────────────────────────
  // The weekly import (lib/ulsScheduler.ts) runs unattended in the small hours.
  // When Friday's run fails — the FCC was down, the club's uplink dropped mid
  // transfer — the club would otherwise wait a week for another attempt with no
  // way to see why. These two endpoints are that visibility and that retry.

  router.get('/uls', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    const [tableRows, runs] = await Promise.all([
      prisma.ulsLicense.count(),
      prisma.ulsImportRun.findMany({ orderBy: { startedAt: 'desc' }, take: 5 }),
    ]);
    const lastSuccess = runs.find((r) => r.outcome === 'success')
      ?? await prisma.ulsImportRun.findFirst({
        where: { outcome: 'success' },
        orderBy: { startedAt: 'desc' },
      });

    const shape = (r: (typeof runs)[number] | null) =>
      r === null
        ? null
        : {
            id: r.id,
            generation: r.generation,
            outcome: r.outcome,
            trigger: r.trigger,
            startedAt: r.startedAt.toISOString(),
            finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
            sourceUrl: r.sourceUrl,
            sourceFileDate: r.sourceFileDate,
            rowsRead: r.rowsRead,
            callsigns: r.callsigns,
            malformedRows: r.malformedRows,
            removedRows: r.removedRows,
            unnamedCallsigns: r.unnamedCallsigns,
            bytesRead: r.bytesRead,
            error: r.error,
          };

    res.json({
      enabled: env.ULS_IMPORT_ENABLED,
      sourceUrl: env.ULS_SOURCE_URL,
      // 0 = Sunday. Container-local time, which is UTC unless TZ is set.
      dayOfWeek: env.ULS_IMPORT_DAY,
      hour: env.ULS_IMPORT_HOUR,
      running: isUlsImportRunning(),
      /// Rows in the table, published or not. A number well above the last
      /// run's `callsigns` means an import is in flight or was interrupted:
      /// the extra rows are unpublished and invisible to lookups.
      tableRows,
      lastRun: shape(runs[0] ?? null),
      lastSuccess: shape(lastSuccess ?? null),
      recentRuns: runs.map((r) => shape(r)),
    });
  }));

  router.post('/uls/import', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    if (!env.ULS_IMPORT_ENABLED) {
      // The switch belongs to whoever runs the container and pays for the
      // bandwidth, not to whoever holds ADMIN in the app.
      throw new HttpError(
        409,
        'CONFLICT',
        'The FCC ULS import is disabled on this server (ULS_IMPORT_ENABLED=false).',
      );
    }
    if (isUlsImportRunning()) {
      throw new HttpError(409, 'CONFLICT', 'A ULS import is already running.');
    }
    // Deliberately not awaited: a full import streams ~155 MB and takes
    // minutes, and no browser will hold a request open that long. The client
    // polls GET /api/admin/uls for progress and the outcome.
    void runUlsImport(prisma, { url: env.ULS_SOURCE_URL, trigger: 'manual' }).catch(
      (e: unknown) => {
        console.warn('[uls] manual import failed', e);
      },
    );
    res.status(202).json({ started: true });
  }));

  return router;
}
