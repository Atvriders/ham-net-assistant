import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import { autoOpenTick } from '../../src/lib/autoOpenScheduler.js';

let prisma: PrismaClient;
let dbFile: string;
let repeaterId: string;

beforeAll(async () => {
  ({ prisma, dbFile } = makeTestDb());
  const r = await prisma.repeater.create({
    data: { name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
  });
  repeaterId = r.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.netSession.deleteMany();
  await prisma.net.deleteMany();
});

/**
 * Create a weekly net whose next scheduled occurrence is `minutesFromNow`
 * minutes after `now`, expressed in the given IANA timezone. We derive the
 * net's dayOfWeek + HH:mm from the target instant's wall-clock in that tz, so
 * nextOccurrence(now) lands exactly on `target`.
 */
async function netOccurringInTz(
  now: Date,
  minutesFromNow: number,
  tz: string,
  kind: 'weekly' | 'impromptu' = 'weekly',
): Promise<string> {
  const target = new Date(now.getTime() + minutesFromNow * 60_000);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(target).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeek = weekdayMap[parts.weekday!] ?? 0;
  const hh = String(Number(parts.hour) % 24).padStart(2, '0');
  const startLocal = `${hh}:${parts.minute}`;
  const net = await prisma.net.create({
    data: {
      name: `Net ${tz} +${minutesFromNow}`, kind, repeaterId,
      dayOfWeek, startLocal, timezone: tz, active: true,
      reminderMinutes: null,
    },
  });
  return net.id;
}

describe('autoOpenScheduler', () => {
  // A stable reference instant: 2026-06-22T12:00:00Z (a Monday).
  const NOW = new Date('2026-06-22T12:00:00Z');

  it('opens exactly one PREP session 10 min before a weekly net', async () => {
    const netId = await netOccurringInTz(NOW, 10, 'UTC');

    const opened = await autoOpenTick(prisma, NOW);
    expect(opened).toBe(1);

    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.liveAt).toBeNull();
    expect(s.autoOpened).toBe(true);
    expect(s.controlOpId).toBeNull();
    expect(s.topicId).toBeNull();
    expect(s.endedAt).toBeNull();
    // startedAt is the injected clock.
    expect(s.startedAt.getTime()).toBe(NOW.getTime());
  });

  it('is idempotent — a second tick at the same now opens no second session', async () => {
    const netId = await netOccurringInTz(NOW, 10, 'UTC');

    await autoOpenTick(prisma, NOW);
    const opened2 = await autoOpenTick(prisma, NOW);
    expect(opened2).toBe(0);

    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(1);
  });

  it('opens nothing 20 min before (outside the 15-min window)', async () => {
    const netId = await netOccurringInTz(NOW, 20, 'UTC');

    const opened = await autoOpenTick(prisma, NOW);
    expect(opened).toBe(0);

    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(0);
  });

  it('opens at exactly 15 min before (window boundary inclusive)', async () => {
    const netId = await netOccurringInTz(NOW, 15, 'UTC');

    const opened = await autoOpenTick(prisma, NOW);
    expect(opened).toBe(1);
    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(1);
  });

  it('skips a net that already has a session that day', async () => {
    const netId = await netOccurringInTz(NOW, 10, 'UTC');
    // An operator already opened (or ran, or ended) a session earlier today.
    await prisma.netSession.create({
      data: {
        netId,
        startedAt: new Date('2026-06-22T08:00:00Z'),
        liveAt: new Date('2026-06-22T08:00:00Z'),
        endedAt: new Date('2026-06-22T09:00:00Z'),
        autoOpened: false,
      },
    });

    const opened = await autoOpenTick(prisma, NOW);
    expect(opened).toBe(0);

    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(1);
    // The auto-opener did not add a row.
    expect(sessions[0]!.autoOpened).toBe(false);
  });

  it('never auto-opens an impromptu net', async () => {
    const netId = await netOccurringInTz(NOW, 10, 'UTC', 'impromptu');

    const opened = await autoOpenTick(prisma, NOW);
    expect(opened).toBe(0);

    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(0);
  });

  it('a net with an Intl-invalid timezone does not stop the others from opening', async () => {
    // Written straight to the DB the way a pre-validation row (or a hand-edited
    // one) would exist: "CDT" makes Intl.DateTimeFormat throw a RangeError.
    // That RangeError used to escape the per-net loop and permanently kill
    // auto-open for EVERY net, across restarts, with only a console.warn.
    // Created FIRST so it is reached first in the (rowid-ordered) loop: with
    // the bug, the good net that follows it never gets a chance.
    const bad = await prisma.net.create({
      data: {
        name: 'Bad TZ Net', kind: 'weekly', repeaterId,
        dayOfWeek: 1, startLocal: '12:05', timezone: 'CDT', active: true,
        reminderMinutes: null,
      },
    });
    const goodId = await netOccurringInTz(NOW, 10, 'UTC');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const opened = await autoOpenTick(prisma, NOW);
      expect(opened).toBe(1);
      // The offending row is named in the log so an officer can fix it.
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(bad.id);
      expect(logged).toContain('CDT');
    } finally {
      warn.mockRestore();
    }

    expect(await prisma.netSession.count({ where: { netId: goodId } })).toBe(1);
    expect(await prisma.netSession.count({ where: { netId: bad.id } })).toBe(0);
  });

  it('opens a net relative to its own timezone wall-clock (timezone correctness)', async () => {
    // A net in America/New_York whose next occurrence is 10 min from NOW.
    // netOccurringInTz derives the dayOfWeek/HH:mm in that tz, so the auto-open
    // window is evaluated against the net's own wall-clock, not the server's.
    const netId = await netOccurringInTz(NOW, 10, 'America/New_York');

    const opened = await autoOpenTick(prisma, NOW);
    expect(opened).toBe(1);

    const sessions = await prisma.netSession.findMany({ where: { netId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.autoOpened).toBe(true);

    // And a same-tz net 20 min out is still outside the window — proves the
    // window math is per-net-tz, not coincidentally passing.
    const farId = await netOccurringInTz(NOW, 20, 'America/New_York');
    const opened2 = await autoOpenTick(prisma, NOW);
    // The first net already has a session (idempotent), the far net is outside
    // the window, so nothing new opens.
    expect(opened2).toBe(0);
    expect(await prisma.netSession.count({ where: { netId: farId } })).toBe(0);
  });
});
