import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import {
  reapStaleSessionsTick,
  MAX_LIVE_SESSION_MS,
} from '../../src/lib/staleSessionReaper.js';

let prisma: PrismaClient;
let dbFile: string;
let netId: string;

beforeAll(async () => {
  ({ prisma, dbFile } = makeTestDb());
  const r = await prisma.repeater.create({
    data: { name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
  });
  const net = await prisma.net.create({
    data: {
      name: 'Wednesday Net', kind: 'weekly', repeaterId: r.id,
      dayOfWeek: 3, startLocal: '20:00', timezone: 'America/Chicago', active: true,
    },
  });
  netId = net.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});

// A stable reference instant, matching the other schedulers' injected-clock
// idiom: 2026-06-22T12:00:00Z (a Monday).
const NOW = new Date('2026-06-22T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60_000);

async function session(data: {
  liveAt?: Date | null;
  endedAt?: Date | null;
  deletedAt?: Date | null;
  startedAt?: Date;
}): Promise<string> {
  const s = await prisma.netSession.create({
    data: {
      netId,
      startedAt: data.startedAt ?? hoursAgo(5),
      liveAt: data.liveAt ?? null,
      endedAt: data.endedAt ?? null,
      deletedAt: data.deletedAt ?? null,
    },
  });
  return s.id;
}

describe('staleSessionReaper', () => {
  it('ends a session that has been live for 5 hours', async () => {
    // Nothing but a human pressing END ever wrote endedAt, so a club that
    // closed the laptop without ending the net left this row LIVE forever:
    // permanently on the Dashboard, permanently in /api/nets/active, and in
    // stats with no end time.
    const id = await session({ liveAt: hoursAgo(5) });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await reapStaleSessionsTick(prisma, NOW)).toBe(1);
      const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(id);
      expect(logged).toContain('Wednesday Net');
    } finally {
      log.mockRestore();
    }

    const s = await prisma.netSession.findUnique({ where: { id } });
    // endedAt is liveAt + 4h, not `now`: the duration recorded must not grow
    // with however long the reaper took to notice (e.g. server down all
    // weekend), and it keeps repeated passes deterministic.
    expect(s!.endedAt!.getTime()).toBe(hoursAgo(5).getTime() + MAX_LIVE_SESSION_MS);
  });

  it('leaves a fresh live session alone', async () => {
    const id = await session({ liveAt: hoursAgo(1) });
    expect(await reapStaleSessionsTick(prisma, NOW)).toBe(0);
    expect((await prisma.netSession.findUnique({ where: { id } }))!.endedAt).toBeNull();
  });

  it('leaves a session that is exactly at the boundary but not past it', async () => {
    // 4h ago exactly is <= cutoff, so it reaps; 4h minus a minute does not.
    const justUnder = await session({
      liveAt: new Date(NOW.getTime() - MAX_LIVE_SESSION_MS + 60_000),
    });
    expect(await reapStaleSessionsTick(prisma, NOW)).toBe(0);
    expect((await prisma.netSession.findUnique({ where: { id: justUnder } }))!.endedAt)
      .toBeNull();
  });

  it('leaves an already-ended session untouched', async () => {
    const endedAt = hoursAgo(4);
    const id = await session({ liveAt: hoursAgo(6), endedAt });
    expect(await reapStaleSessionsTick(prisma, NOW)).toBe(0);
    // The human-recorded end time is never rewritten.
    expect((await prisma.netSession.findUnique({ where: { id } }))!.endedAt!.getTime())
      .toBe(endedAt.getTime());
  });

  it('leaves a PREP session alone no matter how old', async () => {
    // liveAt null means the net never went on the air. Ending it would invent
    // a net that never happened; the auto-start scheduler already age-gates
    // these so they cannot surprise-start either.
    const id = await session({ liveAt: null, startedAt: hoursAgo(72) });
    expect(await reapStaleSessionsTick(prisma, NOW)).toBe(0);
    const s = await prisma.netSession.findUnique({ where: { id } });
    expect(s!.endedAt).toBeNull();
    expect(s!.liveAt).toBeNull();
  });

  it('never touches a soft-deleted session', async () => {
    // Soft-deleted rows are already out of every view; writing to them would
    // resurrect them in exports and stats.
    const id = await session({ liveAt: hoursAgo(9), deletedAt: hoursAgo(8) });
    expect(await reapStaleSessionsTick(prisma, NOW)).toBe(0);
    expect((await prisma.netSession.findUnique({ where: { id } }))!.endedAt).toBeNull();
  });

  it('leaves a long net that is STILL taking check-ins', async () => {
    // Field Day, an ARES activation or a long swap net can run well past four
    // hours. Ending one out from under the control op is not a cleanup: the
    // POST /checkins guard answers 409 "Session already ended", so every
    // further check-in is silently refused for the rest of the night.
    const id = await session({ liveAt: hoursAgo(5) });
    await prisma.checkIn.create({
      data: {
        sessionId: id, callsign: 'K1ABC', nameAtCheckIn: 'Bo',
        checkedInAt: new Date(NOW.getTime() - 60_000), // one minute ago
      },
    });

    expect(await reapStaleSessionsTick(prisma, NOW)).toBe(0);
    expect((await prisma.netSession.findUnique({ where: { id } }))!.endedAt).toBeNull();
  });

  it('ends it once the log has been silent for the window, never before its last check-in', async () => {
    // Same long session, but the last check-in was 4.5h ago: the net really was
    // abandoned. endedAt must be anchored to that check-in, not to liveAt —
    // `liveAt + 4h` would stamp an end time BEFORE a check-in the log already
    // contains, which skews every duration in stats and the exports.
    const id = await session({ liveAt: hoursAgo(9) });
    const lastCheckIn = hoursAgo(4.5);
    await prisma.checkIn.create({
      data: {
        sessionId: id, callsign: 'K1ABC', nameAtCheckIn: 'Bo', checkedInAt: lastCheckIn,
      },
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await reapStaleSessionsTick(prisma, NOW)).toBe(1);
    } finally {
      log.mockRestore();
    }
    const endedAt = (await prisma.netSession.findUnique({ where: { id } }))!.endedAt!;
    expect(endedAt.getTime()).toBe(lastCheckIn.getTime() + MAX_LIVE_SESSION_MS);
    expect(endedAt.getTime()).toBeGreaterThan(lastCheckIn.getTime());
    // Anchored to stored timestamps, so it can never be in the future.
    expect(endedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('is idempotent — a second pass ends nothing and changes nothing', async () => {
    const id = await session({ liveAt: hoursAgo(5) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await reapStaleSessionsTick(prisma, NOW)).toBe(1);
      const first = (await prisma.netSession.findUnique({ where: { id } }))!.endedAt!;
      // Second pass an hour later: already ended, so it no longer matches.
      const later = new Date(NOW.getTime() + 60 * 60_000);
      expect(await reapStaleSessionsTick(prisma, later)).toBe(0);
      expect((await prisma.netSession.findUnique({ where: { id } }))!.endedAt!.getTime())
        .toBe(first.getTime());
    } finally {
      log.mockRestore();
    }
  });

  it('sweeps several stale sessions in one pass', async () => {
    await session({ liveAt: hoursAgo(5) });
    await session({ liveAt: hoursAgo(30) });
    const fresh = await session({ liveAt: hoursAgo(2) });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await reapStaleSessionsTick(prisma, NOW)).toBe(2);
    } finally {
      log.mockRestore();
    }
    expect((await prisma.netSession.findUnique({ where: { id: fresh } }))!.endedAt)
      .toBeNull();
    expect(await prisma.netSession.count({ where: { endedAt: null } })).toBe(1);
  });
});
