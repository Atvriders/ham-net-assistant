import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { autoStartTick } from '../../src/lib/autoStartScheduler.js';
import { startSession } from '../../src/lib/startSession.js';

// Neutralize Discord exactly like the start-route tests do: postToDiscord is
// mocked so no network is attempted and we can assert the 🟢 announcement.
vi.mock('../../src/discord/client.js', async () => {
  const actual: object = await vi.importActual('../../src/discord/client.js');
  return {
    ...actual,
    postToDiscord: vi.fn().mockResolvedValue({ ok: false, reason: 'mocked' }),
    getActiveClient: vi.fn().mockReturnValue(null),
    loadDiscordConfig: vi.fn().mockResolvedValue({ enabled: false, token: null, channelId: null }),
  };
});

import { postToDiscord } from '../../src/discord/client.js';

const discordMock = postToDiscord as unknown as {
  mock: { calls: unknown[][] };
  mockClear: () => void;
};

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let officerId: string;
let repeaterId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered user becomes ADMIN — enough for the manual-start route.
  const a = await request(app).post('/api/auth/register').send({
    email: 'autostart@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  officerId = a.body.id;
  const r = await prisma.repeater.create({
    data: { name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
  });
  repeaterId = r.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
  await prisma.net.deleteMany();
  discordMock.mockClear();
});

// A stable reference instant: 2026-06-22T12:00:00Z (a Monday), matching the
// autoOpenScheduler tests' injectable-clock pattern.
const NOW = new Date('2026-06-22T12:00:00Z');

/**
 * Create a weekly (or impromptu) net whose scheduled start is
 * `startOffsetMinutes` relative to NOW (negative = already started), with the
 * dayOfWeek + HH:mm derived from that instant's wall clock in the given IANA
 * timezone — so "today's startLocal" in the net's tz lands exactly on
 * NOW + offset.
 */
async function netStartingAt(
  startOffsetMinutes: number,
  tz = 'UTC',
  kind: 'weekly' | 'impromptu' = 'weekly',
): Promise<string> {
  const target = new Date(NOW.getTime() + startOffsetMinutes * 60_000);
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
      name: `Net ${tz} ${startOffsetMinutes >= 0 ? '+' : ''}${startOffsetMinutes}`,
      kind, repeaterId, dayOfWeek, startLocal, timezone: tz, active: true,
      reminderMinutes: null,
    },
  });
  return net.id;
}

async function prepSession(
  netId: string,
  extra: { controlOpId?: string | null; startedAt?: Date } = {},
): Promise<string> {
  const s = await prisma.netSession.create({
    data: {
      netId,
      startedAt: extra.startedAt ?? new Date(NOW.getTime() - 10 * 60_000),
      liveAt: null,
      controlOpId: extra.controlOpId ?? null,
      autoOpened: true,
    },
  });
  return s.id;
}

describe('autoStartScheduler', () => {
  it('auto-starts a PREP session once the start time arrives and fires the Discord announcement', async () => {
    const netId = await netStartingAt(-5); // started 5 min ago
    const sessionId = await prepSession(netId);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(1);

    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).not.toBeNull();
    expect(s!.endedAt).toBeNull();

    // The announcement goes through the shared startSession core — exactly
    // like a manual START press.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(1);
  });

  it('a control-less scheduler start is NOT announced as "now live"', async () => {
    // Nobody claimed the session and no human pressed START: telling the club
    // the net is live means members key up to silence. The ping still goes
    // out — reworded — so an officer can still step in and take control.
    const netId = await netStartingAt(-5);
    await prepSession(netId, { controlOpId: null });

    expect(await autoStartTick(prisma, NOW)).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(1);
    const content = String(discordMock.mock.calls[0]![1] ?? '');
    expect(content).not.toContain('is now live');
    expect(content).toContain('scheduled to start now');
    expect(content).toContain('no net control has taken the mic yet');
  });

  it('a scheduler start WITH a control op still announces "now live"', async () => {
    // Someone opened the console and took control during PREP — the net does
    // have a human at the mic, so the normal 🟢 wording is honest.
    const netId = await netStartingAt(-5);
    await prepSession(netId, { controlOpId: officerId });

    expect(await autoStartTick(prisma, NOW)).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(1);
    const content = String(discordMock.mock.calls[0]![1] ?? '');
    expect(content).toContain('is now live');
    expect(content).not.toContain('scheduled to start now');
  });

  it('a net with an Intl-invalid timezone does not stop other nets from starting', async () => {
    // "CDT" makes Intl.DateTimeFormat throw. That RangeError used to escape
    // the per-session loop, so ONE bad row permanently stopped auto-start for
    // every net. The bad session is created first so it is reached first.
    const badNet = await prisma.net.create({
      data: {
        name: 'Bad TZ Net', kind: 'weekly', repeaterId,
        dayOfWeek: 1, startLocal: '11:55', timezone: 'CDT', active: true,
        reminderMinutes: null,
      },
    });
    const badSession = await prepSession(badNet.id);
    const goodNet = await netStartingAt(-5);
    const goodSession = await prepSession(goodNet);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await autoStartTick(prisma, NOW)).toBe(1);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(badSession);
      expect(logged).toContain('CDT');
    } finally {
      warn.mockRestore();
    }

    expect((await prisma.netSession.findUnique({ where: { id: goodSession } }))!.liveAt)
      .not.toBeNull();
    expect((await prisma.netSession.findUnique({ where: { id: badSession } }))!.liveAt)
      .toBeNull();
  });

  it('does NOT start before the scheduled start time', async () => {
    const netId = await netStartingAt(5); // starts in 5 min
    const sessionId = await prepSession(netId);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(0);
    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).toBeNull();
  });

  it('does NOT start beyond the 15-min grace window (stale PREP session)', async () => {
    const netId = await netStartingAt(-20); // started 20 min ago
    const sessionId = await prepSession(netId);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(0);
    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(0);
  });

  it('never surprise-starts a week-old abandoned PREP session — only the fresh one starts', async () => {
    // Same net, same weekday: last week's auto-opened session was never
    // started, never ended, never deleted. This week's occurrence must start
    // ONLY the fresh session (one 🟢, one LIVE) — the abandoned row would
    // otherwise match the weekday + grace window again exactly a week later.
    const netId = await netStartingAt(-5);
    const staleId = await prepSession(netId, {
      startedAt: new Date(NOW.getTime() - 7 * 24 * 60 * 60_000 - 10 * 60_000),
    });
    const freshId = await prepSession(netId);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(1);
    expect((await prisma.netSession.findUnique({ where: { id: staleId } }))!.liveAt)
      .toBeNull();
    expect((await prisma.netSession.findUnique({ where: { id: freshId } }))!.liveAt)
      .not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(1);
  });

  it('starts at exactly the grace boundary (start + 15 min, inclusive)', async () => {
    const netId = await netStartingAt(-15);
    const sessionId = await prepSession(netId);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(1);
    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).not.toBeNull();
  });

  it('never auto-starts an impromptu net PREP session', async () => {
    const netId = await netStartingAt(-5, 'UTC', 'impromptu');
    const sessionId = await prepSession(netId);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(0);
    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).toBeNull();
  });

  it('evaluates the window in the NET\'s timezone, not the server\'s', async () => {
    // 12:00Z on a Monday is 08:00 Mon in America/New_York — the helper derives
    // the net's dayOfWeek/HH:mm in that tz, so the tick must too.
    const inWindow = await netStartingAt(-5, 'America/New_York');
    const inWindowSession = await prepSession(inWindow);
    const notYet = await netStartingAt(10, 'America/New_York');
    const notYetSession = await prepSession(notYet);

    const started = await autoStartTick(prisma, NOW);
    expect(started).toBe(1);
    expect((await prisma.netSession.findUnique({ where: { id: inWindowSession } }))!.liveAt)
      .not.toBeNull();
    expect((await prisma.netSession.findUnique({ where: { id: notYetSession } }))!.liveAt)
      .toBeNull();
  });

  it('scheduler start leaves controlOpId null when it was null', async () => {
    const netId = await netStartingAt(-5);
    const sessionId = await prepSession(netId, { controlOpId: null });

    await autoStartTick(prisma, NOW);
    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).not.toBeNull();
    // Scheduler starts never touch control — no human pressed anything.
    expect(s!.controlOpId).toBeNull();
  });

  it('scheduler start keeps an existing controlOpId', async () => {
    const netId = await netStartingAt(-5);
    const sessionId = await prepSession(netId, { controlOpId: officerId });

    await autoStartTick(prisma, NOW);
    const s = await prisma.netSession.findUnique({ where: { id: sessionId } });
    expect(s!.liveAt).not.toBeNull();
    expect(s!.controlOpId).toBe(officerId);
  });

  it('is idempotent — a second tick at the same now starts nothing and posts no second announcement', async () => {
    const netId = await netStartingAt(-5);
    await prepSession(netId);

    expect(await autoStartTick(prisma, NOW)).toBe(1);
    expect(await autoStartTick(prisma, NOW)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(1);
  });

  it('race: an already-LIVE session is untouched (updateMany guard)', async () => {
    const netId = await netStartingAt(-5);
    const liveAt = new Date(NOW.getTime() - 4 * 60_000);
    const live = await prisma.netSession.create({
      data: {
        netId, startedAt: new Date(NOW.getTime() - 10 * 60_000),
        liveAt, controlOpId: officerId, autoOpened: false,
      },
    });

    // The tick's query no longer matches it…
    expect(await autoStartTick(prisma, NOW)).toBe(0);
    // …and even calling the shared core directly (simulating losing the
    // manual-vs-scheduler race after a stale read) does not double-fire:
    const res = await startSession(prisma, live.id, null);
    expect(res.transitioned).toBe(false);

    const s = await prisma.netSession.findUnique({ where: { id: live.id } });
    expect(s!.liveAt!.getTime()).toBe(liveAt.getTime()); // timestamp untouched
    expect(s!.controlOpId).toBe(officerId);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(0); // no duplicate 🟢
  });

  it('regression: manual POST /:id/start still works and applies the human null-fallback', async () => {
    const netId = await netStartingAt(60); // schedule irrelevant to manual start
    const sessionId = await prepSession(netId, { controlOpId: null });

    const start = await request(app)
      .post(`/api/sessions/${sessionId}/start`)
      .set('Cookie', officer);
    expect(start.status).toBe(200);
    expect(start.body.liveAt).not.toBeNull();
    // Human start on a control-less session: the starter becomes control.
    expect(start.body.controlOpId).toBe(officerId);
    expect(start.body.controlOp.callsign).toBe('W1AW');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discordMock.mock.calls.length).toBe(1);

    // Second press: unchanged 409 contract.
    const again = await request(app)
      .post(`/api/sessions/${sessionId}/start`)
      .set('Cookie', officer);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    expect(again.body.error.message).toContain('already live');
  });
});
