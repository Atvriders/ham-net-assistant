import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let admin: string; let member: string; let netId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'bf-admin@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'bf-mem@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R-bf', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Backfill Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});

afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockCallook(body: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

async function makeSession(): Promise<string> {
  const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
  return s.body.id as string;
}

async function rawCheckIn(
  sessionId: string,
  callsign: string,
  nameAtCheckIn: string,
): Promise<string> {
  // Bypass the normal create path so we can plant a check-in whose name is
  // exactly the callsign (the import fallback signature) without the API
  // rejecting it.
  const ci = await prisma.checkIn.create({
    data: {
      sessionId,
      callsign,
      nameAtCheckIn,
      checkedInAt: new Date(),
    },
  });
  return ci.id;
}

describe('admin backfill names', () => {
  it('MEMBER cannot backfill (403)', async () => {
    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', member)
      .send({ scope: 'all' });
    expect(res.status).toBe(403);
  });

  it('ADMIN with no candidates returns zeros', async () => {
    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', admin)
      .send({ scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 0, updated: 0, lookedUp: 0 });
  });

  it('updates a check-in whose nameAtCheckIn equals callsign', async () => {
    mockCallook({ status: 'VALID', name: 'TOM THEIS', current: { operClass: 'Extra' } });
    const sId = await makeSession();
    const ciId = await rawCheckIn(sId, 'KD0XYZ', 'KD0XYZ');

    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', admin)
      .send({ scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.lookedUp).toBe(1);

    const row = await prisma.checkIn.findUnique({ where: { id: ciId } });
    expect(row?.nameAtCheckIn).toBe('Tom Theis');
  });

  it('updates a check-in whose nameAtCheckIn is empty', async () => {
    mockCallook({ status: 'VALID', name: 'JANE DOE', current: { operClass: 'General' } });
    const sId = await makeSession();
    const ciId = await rawCheckIn(sId, 'KE0ABC', '');

    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', admin)
      .send({ scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.updated).toBe(1);

    const row = await prisma.checkIn.findUnique({ where: { id: ciId } });
    expect(row?.nameAtCheckIn).toBe('Jane Doe');
  });

  it('skips check-ins that already have a real name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sId = await makeSession();
    const ciId = await rawCheckIn(sId, 'KE0ABC', 'Tom Theis');

    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', admin)
      .send({ scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(0);
    expect(res.body.updated).toBe(0);
    expect(res.body.lookedUp).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = await prisma.checkIn.findUnique({ where: { id: ciId } });
    expect(row?.nameAtCheckIn).toBe('Tom Theis');
  });

  it('does not increment lookedUp when callook returns no match', async () => {
    mockCallook({ status: 'UPDATING' });
    const sId = await makeSession();
    const ciId = await rawCheckIn(sId, 'KF0NOPE', 'KF0NOPE');

    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', admin)
      .send({ scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.lookedUp).toBe(0);

    const row = await prisma.checkIn.findUnique({ where: { id: ciId } });
    expect(row?.nameAtCheckIn).toBe('KF0NOPE');
  });

  it('scope=session restricts updates to that session', async () => {
    mockCallook({ status: 'VALID', name: 'JOHN SMITH', current: { operClass: 'Extra' } });
    const targetSession = await makeSession();
    // Two same-day sessions for one net are coalesced by the API, so plant
    // the second session directly on a different calendar day.
    const otherSessionRow = await prisma.netSession.create({
      data: {
        netId,
        startedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
    const otherSession = otherSessionRow.id;
    const targetId = await rawCheckIn(targetSession, 'KG0AAA', 'KG0AAA');
    const otherId = await rawCheckIn(otherSession, 'KH0BBB', 'KH0BBB');

    const res = await request(app)
      .post('/api/admin/backfill-names')
      .set('Cookie', admin)
      .send({ scope: 'session', sessionId: targetSession });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.updated).toBe(1);

    const targetRow = await prisma.checkIn.findUnique({ where: { id: targetId } });
    const otherRow = await prisma.checkIn.findUnique({ where: { id: otherId } });
    expect(targetRow?.nameAtCheckIn).toBe('John Smith');
    expect(otherRow?.nameAtCheckIn).toBe('KH0BBB');
  });
});
