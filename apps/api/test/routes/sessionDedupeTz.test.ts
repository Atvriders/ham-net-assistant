// Regression cover for the duplicate-session bug: the manual "Open net" route
// deduped against the SERVER's calendar day while the auto-open scheduler used
// the NET's timezone. A US evening net runs straight through 00:00 UTC, so the
// two halves of one net night looked like two different days and a second press
// of "Open net" created a second PREP session — which the auto-start scheduler
// then also took live, firing two "net is live" announcements and splitting the
// check-in log in half.
//
// TZ is pinned to UTC for this file so the "server day" is the UTC day
// regardless of where the suite runs; without that pin the assertion below
// would pass by accident on a machine already set to America/Chicago.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

vi.mock('../../src/discord/client.js', async () => {
  const actual: object = await vi.importActual('../../src/discord/client.js');
  return {
    ...actual,
    postToDiscord: vi.fn().mockResolvedValue({ ok: false, reason: 'mocked' }),
    getActiveClient: vi.fn().mockReturnValue(null),
    loadDiscordConfig: vi.fn().mockResolvedValue({ enabled: false, token: null, channelId: null }),
  };
});

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let chicagoNetId: string; let utcNetId: string;

// 2026-04-29 18:50 America/Chicago = 2026-04-29 23:50 UTC
const BEFORE_UTC_MIDNIGHT = new Date('2026-04-29T23:50:00Z');
// 2026-04-29 19:10 America/Chicago = 2026-04-30 00:10 UTC — same net night,
// next UTC (and, with TZ=UTC, next server-local) calendar day.
const AFTER_UTC_MIDNIGHT = new Date('2026-04-30T00:10:00Z');

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'tz@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R-tz', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const chicago = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Evening Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  chicagoNetId = chicago.body.id;
  const utc = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'UTC Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'UTC',
  });
  utcNetId = utc.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
  // Only Date is faked: real timers keep supertest/Prisma I/O working.
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('open-net dedupe across UTC midnight', () => {
  it('a second "Open net" after 00:00 UTC reuses the same net-night session', async () => {
    vi.setSystemTime(BEFORE_UTC_MIDNIGHT);
    const first = await request(app).post(`/api/nets/${chicagoNetId}/sessions`)
      .set('Cookie', officer);
    expect(first.status).toBe(201);

    vi.setSystemTime(AFTER_UTC_MIDNIGHT);
    const second = await request(app).post(`/api/nets/${chicagoNetId}/sessions`)
      .set('Cookie', officer);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const rows = await prisma.netSession.findMany({ where: { netId: chicagoNetId } });
    expect(rows).toHaveLength(1);
  });

  it('the session the scheduler auto-opened before midnight is adopted, not duplicated', async () => {
    // The real production sequence: the scheduler opens a control-less PREP
    // session at 19:45 Chicago (00:45 UTC the next day, with TZ=UTC on the box)
    // and the operator presses "Open net" a few minutes later.
    vi.setSystemTime(BEFORE_UTC_MIDNIGHT);
    const auto = await prisma.netSession.create({
      data: {
        netId: chicagoNetId,
        startedAt: BEFORE_UTC_MIDNIGHT,
        liveAt: null,
        controlOpId: null,
        autoOpened: true,
      },
    });

    vi.setSystemTime(AFTER_UTC_MIDNIGHT);
    const opened = await request(app).post(`/api/nets/${chicagoNetId}/sessions`)
      .set('Cookie', officer);
    expect(opened.status).toBe(200);
    expect(opened.body.id).toBe(auto.id);
    expect(opened.body.reused).toBe(true);
    // The presser adopts the control-less session rather than starting a rival.
    expect(opened.body.controlOp.callsign).toBe('W1AW');
    expect(await prisma.netSession.count({ where: { netId: chicagoNetId } })).toBe(1);
  });

  it('a genuinely different net night still opens a new session', async () => {
    vi.setSystemTime(BEFORE_UTC_MIDNIGHT);
    const first = await request(app).post(`/api/nets/${chicagoNetId}/sessions`)
      .set('Cookie', officer);
    expect(first.status).toBe(201);
    await request(app).patch(`/api/sessions/${first.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });

    // 24 hours on: a new Chicago day, so this must NOT dedupe.
    vi.setSystemTime(new Date(AFTER_UTC_MIDNIGHT.getTime() + 24 * 60 * 60 * 1000));
    const next = await request(app).post(`/api/nets/${chicagoNetId}/sessions`)
      .set('Cookie', officer);
    expect(next.status).toBe(201);
    expect(next.body.id).not.toBe(first.body.id);
  });

  it('a UTC net still uses its own (UTC) day boundary', async () => {
    // Same two instants, but this net's own timezone IS UTC — so they really
    // are two different days and the second open must be refused/created new.
    vi.setSystemTime(BEFORE_UTC_MIDNIGHT);
    const first = await request(app).post(`/api/nets/${utcNetId}/sessions`)
      .set('Cookie', officer);
    expect(first.status).toBe(201);
    await request(app).patch(`/api/sessions/${first.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });

    vi.setSystemTime(AFTER_UTC_MIDNIGHT);
    const second = await request(app).post(`/api/nets/${utcNetId}/sessions`)
      .set('Cookie', officer);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
