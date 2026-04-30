import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let admin: string; let member: string;
let netA: string; let netB: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'mem@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const nA = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Net A', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netA = nA.body.id;
  const nB = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Net B', repeaterId: r.body.id, dayOfWeek: 4,
    startLocal: '21:00', timezone: 'America/Chicago',
  });
  netB = nB.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.sessionMessage.deleteMany();
  await prisma.netSession.deleteMany();
});

function atLocal(year: number, month: number, day: number, hour: number, min = 0): Date {
  return new Date(year, month - 1, day, hour, min, 0, 0);
}

async function makeSession(netId: string, startedAt: Date, opts: {
  topicTitle?: string | null;
  controlOpId?: string | null;
  endedAt?: Date | null;
} = {}) {
  return prisma.netSession.create({
    data: {
      netId,
      startedAt,
      endedAt: opts.endedAt ?? null,
      topicTitle: opts.topicTitle ?? null,
      controlOpId: opts.controlOpId ?? null,
    },
  });
}

async function addCheckIn(sessionId: string, callsign: string, name: string, when: Date) {
  return prisma.checkIn.create({
    data: { sessionId, callsign, nameAtCheckIn: name, checkedInAt: when },
  });
}

describe('admin duplicate-sessions', () => {
  it('MEMBER cannot list duplicates (403)', async () => {
    const res = await request(app)
      .get('/api/admin/duplicate-sessions')
      .set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('ADMIN GET with no duplicates returns []', async () => {
    await makeSession(netA, atLocal(2026, 4, 25, 19, 0));
    const res = await request(app)
      .get('/api/admin/duplicate-sessions')
      .set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ADMIN GET returns one group when same net has 2 sessions same day', async () => {
    await makeSession(netA, atLocal(2026, 4, 25, 15, 0), { topicTitle: 'Afternoon' });
    await makeSession(netA, atLocal(2026, 4, 25, 19, 55), { topicTitle: 'Evening' });
    // A different day on the same net should NOT show up.
    await makeSession(netA, atLocal(2026, 4, 26, 19, 0));
    // A different net same day should NOT show up.
    await makeSession(netB, atLocal(2026, 4, 25, 19, 0));

    const res = await request(app)
      .get('/api/admin/duplicate-sessions')
      .set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].netId).toBe(netA);
    expect(res.body[0].date).toBe('2026-04-25');
    expect(res.body[0].sessions).toHaveLength(2);
    // Ordered by startedAt asc within group.
    expect(res.body[0].sessions[0].topicTitle).toBe('Afternoon');
    expect(res.body[0].sessions[1].topicTitle).toBe('Evening');
  });

  it('POST merge re-parents check-ins, soft-deletes merged, drops dup-by-callsign', async () => {
    const keeper = await makeSession(netA, atLocal(2026, 4, 25, 15, 0), {
      topicTitle: 'Keeper topic',
    });
    const dup = await makeSession(netA, atLocal(2026, 4, 25, 19, 55));
    // Keeper has KB0BOB; merged also has KB0BOB (dupe) plus K9NEW (unique).
    await addCheckIn(keeper.id, 'KB0BOB', 'Bob', atLocal(2026, 4, 25, 15, 5));
    await addCheckIn(dup.id, 'KB0BOB', 'Bob', atLocal(2026, 4, 25, 19, 58));
    await addCheckIn(dup.id, 'K9NEW', 'Newbie', atLocal(2026, 4, 25, 20, 1));

    const res = await request(app)
      .post('/api/admin/duplicate-sessions/merge')
      .set('Cookie', admin)
      .send({ keepSessionId: keeper.id, mergeSessionIds: [dup.id] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.keptSessionId).toBe(keeper.id);
    expect(res.body.mergedCount).toBe(1);
    expect(res.body.mergedCheckIns).toBe(1);

    const keeperCheckIns = await prisma.checkIn.findMany({
      where: { sessionId: keeper.id, deletedAt: null },
      orderBy: { callsign: 'asc' },
    });
    expect(keeperCheckIns.map((c) => c.callsign).sort()).toEqual(['K9NEW', 'KB0BOB']);

    const dupAfter = await prisma.netSession.findUnique({ where: { id: dup.id } });
    expect(dupAfter?.deletedAt).not.toBeNull();
  });

  it('POST merge with sessions on different nets returns 400', async () => {
    const a = await makeSession(netA, atLocal(2026, 4, 25, 15, 0));
    const b = await makeSession(netB, atLocal(2026, 4, 25, 19, 0));
    const res = await request(app)
      .post('/api/admin/duplicate-sessions/merge')
      .set('Cookie', admin)
      .send({ keepSessionId: a.id, mergeSessionIds: [b.id] });
    expect(res.status).toBe(400);
  });

  it('POST merge across different days returns 400', async () => {
    const a = await makeSession(netA, atLocal(2026, 4, 25, 15, 0));
    const b = await makeSession(netA, atLocal(2026, 4, 26, 15, 0));
    const res = await request(app)
      .post('/api/admin/duplicate-sessions/merge')
      .set('Cookie', admin)
      .send({ keepSessionId: a.id, mergeSessionIds: [b.id] });
    expect(res.status).toBe(400);
  });

  it('POST auto-merge-all resolves 3 groups', async () => {
    // Group 1: Net A on Apr 25 with 2 sessions
    const g1a = await makeSession(netA, atLocal(2026, 4, 25, 15, 0));
    const g1b = await makeSession(netA, atLocal(2026, 4, 25, 19, 55));
    await addCheckIn(g1a.id, 'KB0BOB', 'Bob', atLocal(2026, 4, 25, 15, 5));
    await addCheckIn(g1b.id, 'K9NEW', 'New', atLocal(2026, 4, 25, 20, 1));
    await addCheckIn(g1b.id, 'K9TWO', 'Two', atLocal(2026, 4, 25, 20, 2));
    // g1b has more check-ins → should be the keeper.

    // Group 2: Net A on Apr 26 with 2 sessions
    const g2a = await makeSession(netA, atLocal(2026, 4, 26, 15, 0));
    const g2b = await makeSession(netA, atLocal(2026, 4, 26, 19, 0));
    await addCheckIn(g2a.id, 'W1AW', 'AW', atLocal(2026, 4, 26, 15, 1));
    await addCheckIn(g2b.id, 'W1AW', 'AW', atLocal(2026, 4, 26, 19, 1));

    // Group 3: Net B on Apr 25 with 3 sessions
    const g3a = await makeSession(netB, atLocal(2026, 4, 25, 9, 0));
    const g3b = await makeSession(netB, atLocal(2026, 4, 25, 12, 0));
    const g3c = await makeSession(netB, atLocal(2026, 4, 25, 18, 0));
    await addCheckIn(g3b.id, 'KE0XYZ', 'Xyz', atLocal(2026, 4, 25, 12, 1));

    const res = await request(app)
      .post('/api/admin/duplicate-sessions/auto-merge-all')
      .set('Cookie', admin)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.groupsMerged).toBe(3);
    expect(res.body.sessionsMerged).toBe(4); // 1+1+2

    // After: no duplicates remain.
    const after = await request(app)
      .get('/api/admin/duplicate-sessions')
      .set('Cookie', admin);
    expect(after.body).toEqual([]);

    // g1b should be the keeper for group 1 (most check-ins).
    const g1bAfter = await prisma.netSession.findUnique({ where: { id: g1b.id } });
    const g1aAfter = await prisma.netSession.findUnique({ where: { id: g1a.id } });
    expect(g1bAfter?.deletedAt).toBeNull();
    expect(g1aAfter?.deletedAt).not.toBeNull();
  });
});
