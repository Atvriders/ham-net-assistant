import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import type { ParticipationStats } from '@hna/shared';
import { toCsvRow } from '../lib/csv.js';
import { renderParticipationPdf } from '../lib/pdf.js';
import { asyncHandler } from '../middleware/async.js';

function parseRange(q: Record<string, string | undefined>): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 180 * 24 * 60 * 60 * 1000);
  return { from, to };
}

async function computeStats(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<ParticipationStats> {
  const sessions = await prisma.netSession.findMany({
    where: { startedAt: { gte: from, lte: to } },
    include: { net: true, checkIns: true },
  });
  const perMemberMap = new Map<string, { callsign: string; name: string; count: number }>();
  const perNetMap = new Map<
    string,
    { netId: string; netName: string; sessions: number; checkIns: number }
  >();
  let totalCheckIns = 0;
  for (const s of sessions) {
    const netAgg = perNetMap.get(s.netId) ?? {
      netId: s.netId,
      netName: s.net.name,
      sessions: 0,
      checkIns: 0,
    };
    netAgg.sessions += 1;
    for (const ci of s.checkIns) {
      totalCheckIns += 1;
      netAgg.checkIns += 1;
      const m = perMemberMap.get(ci.callsign) ?? {
        callsign: ci.callsign,
        name: ci.nameAtCheckIn,
        count: 0,
      };
      m.count += 1;
      perMemberMap.set(ci.callsign, m);
    }
    perNetMap.set(s.netId, netAgg);
  }
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totalSessions: sessions.length,
    totalCheckIns,
    perMember: [...perMemberMap.values()].sort((a, b) => b.count - a.count),
    perNet: [...perNetMap.values()],
  };
}

export function statsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/participation', asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req.query as Record<string, string | undefined>);
    res.json(await computeStats(prisma, from, to));
  }));

  router.get('/export.csv', asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req.query as Record<string, string | undefined>);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="checkins.csv"');
    res.write(toCsvRow(['checkedInAt', 'netName', 'callsign', 'name', 'comment']));
    const checkIns = await prisma.checkIn.findMany({
      where: { session: { startedAt: { gte: from, lte: to } } },
      include: { session: { include: { net: true } } },
      orderBy: { checkedInAt: 'asc' },
    });
    for (const ci of checkIns) {
      res.write(
        toCsvRow([
          ci.checkedInAt.toISOString(),
          ci.session.net.name,
          ci.callsign,
          ci.nameAtCheckIn,
          ci.comment,
        ]),
      );
    }
    res.end();
  }));

  router.get('/export.pdf', asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req.query as Record<string, string | undefined>);
    const stats = await computeStats(prisma, from, to);
    const stream = await renderParticipationPdf(stats, 'Ham-Net-Assistant Club');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="participation.pdf"');
    stream.pipe(res);
  }));

  return router;
}
