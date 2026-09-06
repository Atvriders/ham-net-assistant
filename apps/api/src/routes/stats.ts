import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { ParticipationStats } from '@hna/shared';
import { toCsvRow } from '../lib/csv.js';
import { renderParticipationPdf } from '../lib/pdf.js';
import { asyncHandler } from '../middleware/async.js';
import { requireRole } from '../middleware/auth.js';
import { normalizeCheckInMode } from '../lib/checkinMode.js';
import { CHECKIN_LOG_ORDER_ASC } from '../lib/checkInOrder.js';

const RangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function parseRange(q: unknown): { from: Date; to: Date } {
  const parsed = RangeQuery.parse(q);
  const to = parsed.to ? new Date(parsed.to) : new Date();
  const from = parsed.from
    ? new Date(parsed.from)
    : new Date(to.getTime() - 180 * 24 * 60 * 60 * 1000);
  return { from, to };
}

async function computeStats(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<ParticipationStats> {
  const sessions = await prisma.netSession.findMany({
    where: { startedAt: { gte: from, lte: to }, deletedAt: null },
    include: {
      net: true,
      // Ordered in the query, not re-sorted below: this payload feeds the
      // Stats page, its Edit session dialog, and the PDF, and a JS re-sort by
      // checkedInAt silently threw away an operator's reordering — the log
      // saved correctly and then came back in the old order.
      checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_ASC },
      controlOp: { select: { callsign: true, name: true } },
    },
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

  const sessionList = [...sessions]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .map((s) => {
      // Already in log order from the query above — deliberately not re-sorted.
      const sortedCheckIns = s.checkIns;
      return {
        id: s.id,
        netId: s.netId,
        netName: s.net.name,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
        topic: s.topicTitle ?? null,
        notes: s.notes ?? null,
        controlOpId: s.controlOpId ?? null,
        controlOp: s.controlOp
          ? { callsign: s.controlOp.callsign, name: s.controlOp.name }
          : null,
        checkIns: sortedCheckIns.map((ci) => ({
          id: ci.id,
          callsign: ci.callsign,
          name: ci.nameAtCheckIn,
          checkedInAt: ci.checkedInAt.toISOString(),
          mode: normalizeCheckInMode(ci.mode),
        })),
      };
    });

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totalSessions: sessions.length,
    totalCheckIns,
    perMember: [...perMemberMap.values()].sort((a, b) => b.count - a.count),
    perNet: [...perNetMap.values()],
    sessions: sessionList,
  };
}

export function statsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/participation', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req.query);
    res.json(await computeStats(prisma, from, to));
  }));

  router.get('/export.csv', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="checkins.csv"');
    res.write(toCsvRow(['checkedInAt', 'netName', 'callsign', 'name', 'mode', 'comment']));
    const checkIns = await prisma.checkIn.findMany({
      where: {
        deletedAt: null,
        session: { startedAt: { gte: from, lte: to }, deletedAt: null },
      },
      include: { session: { include: { net: true } } },
      orderBy: CHECKIN_LOG_ORDER_ASC,
    });
    for (const ci of checkIns) {
      res.write(
        toCsvRow([
          ci.checkedInAt.toISOString(),
          ci.session.net.name,
          ci.callsign,
          ci.nameAtCheckIn,
          // Uppercase the mode for the FCC-friendly log ('RF' / 'ECHOLINK').
          normalizeCheckInMode(ci.mode).toUpperCase(),
          ci.comment,
        ]),
      );
    }

    const stats = await computeStats(prisma, from, to);
    res.write(toCsvRow([]));
    res.write(
      toCsvRow(['SESSION', 'Net', 'Started', 'Ended', 'Topic', 'Control', 'Check-ins']),
    );
    for (const s of stats.sessions) {
      const checkInsStr = s.checkIns
        .map((c) =>
          c.mode === 'echolink'
            ? `${c.callsign} - ${c.name} (EchoLink)`
            : `${c.callsign} - ${c.name}`,
        )
        .join(' | ');
      res.write(
        toCsvRow([
          s.id,
          s.netName,
          s.startedAt,
          s.endedAt ?? '',
          s.topic ?? '',
          s.controlOp ? `${s.controlOp.callsign} (${s.controlOp.name})` : '',
          checkInsStr,
        ]),
      );
    }
    res.end();
  }));

  router.get('/export.pdf', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const stats = await computeStats(prisma, from, to);
    const stream = await renderParticipationPdf(stats, 'Ham-Net-Assistant Club');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="participation.pdf"');
    stream.pipe(res);
  }));

  return router;
}
