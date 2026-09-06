import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

/**
 * Re-placing a check-in log, and correcting a finished one.
 *
 * The invariant under test is that reordering never touches `checkedInAt`:
 * that column records when the entry was MADE, and an FCC-facing log that
 * rewrote it to achieve a sort order would be a falsified record.
 */
let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let member: string;
let netId: string; let sessionId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

/** A fresh LIVE session with three check-ins, oldest first. */
async function seedLog(): Promise<{ a: string; b: string; c: string }> {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
  const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
  sessionId = s.body.id;
  await request(app).post(`/api/sessions/${sessionId}/start`).set('Cookie', officer);
  const add = async (cs: string) => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: cs, nameAtCheckIn: cs.toLowerCase() });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  return { a: await add('K0ABC'), b: await add('W0XYZ'), c: await add('N0QRP') };
}

beforeEach(async () => { await seedLog(); });

describe('PATCH /api/sessions/:id/checkins/order', () => {
  it('re-places the log without touching the recorded times', async () => {
    const rowsBefore = await prisma.checkIn.findMany({ where: { sessionId } });
    const timeById = new Map(rowsBefore.map((r) => [r.id, r.checkedInAt.getTime()]));
    const { a, b, c } = { a: rowsBefore[0]!.id, b: rowsBefore[1]!.id, c: rowsBefore[2]!.id };

    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', officer)
      .send({ orderedIds: [c, a, b] });
    expect(res.status).toBe(200);

    const rows = await prisma.checkIn.findMany({
      where: { sessionId }, orderBy: { sequence: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([c, a, b]);
    // The whole point: the order is a correction, the times are the record.
    for (const r of rows) {
      expect(r.checkedInAt.getTime()).toBe(timeById.get(r.id));
    }
  });

  it('refuses a list that no longer matches the log', async () => {
    const rows = await prisma.checkIn.findMany({ where: { sessionId } });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', officer)
      // Someone added a station since this tab loaded: the list is short.
      .send({ orderedIds: [rows[1]!.id, rows[0]!.id] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/reload/i);
  });

  it('refuses a duplicated id', async () => {
    const rows = await prisma.checkIn.findMany({ where: { sessionId } });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', officer)
      .send({ orderedIds: [rows[0]!.id, rows[0]!.id, rows[1]!.id] });
    expect(res.status).toBe(409);
  });

  it('is not open to a plain member', async () => {
    const rows = await prisma.checkIn.findMany({ where: { sessionId } });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', member)
      .send({ orderedIds: rows.map((r) => r.id) });
    expect(res.status).toBe(403);
  });

  it('404s for a session that does not exist', async () => {
    const res = await request(app)
      .patch('/api/sessions/does-not-exist/checkins/order')
      .set('Cookie', officer)
      .send({ orderedIds: ['x'] });
    expect(res.status).toBe(404);
  });
});

describe('adding a missed station to a finished log', () => {
  it('lets an officer add one after the net ended, appended to the end', async () => {
    await request(app).patch(`/api/sessions/${sessionId}`)
      .set('Cookie', officer).send({ endedAt: new Date().toISOString() });

    const res = await request(app)
      .post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KD0MISS', nameAtCheckIn: 'Missed Station' });
    expect(res.status).toBe(201);
    expect(res.body.sequence).toBe(4);
  });

  it('still refuses a plain member once the net has ended', async () => {
    await request(app).patch(`/api/sessions/${sessionId}`)
      .set('Cookie', officer).send({ endedAt: new Date().toISOString() });

    const res = await request(app)
      .post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member)
      .send({ callsign: 'KD0MISS', nameAtCheckIn: 'Missed Station' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/net control|officer/i);
  });
});

describe('the saved order survives every read path', () => {
  /**
   * The bug this pins: the order saved correctly, then /stats/participation
   * re-sorted the check-ins by checkedInAt in JS and handed back the OLD
   * order. From the operator's side the reorder simply did not save.
   *
   * The Stats page, its Edit session dialog, the CSV and the PDF all read that
   * payload, so one JS sort undid the feature on four screens at once.
   */
  it('is reflected by /stats/participation, not re-sorted by time', async () => {
    const rows = await prisma.checkIn.findMany({
      where: { sessionId }, orderBy: { sequence: 'asc' },
    });
    const [a, b, c] = [rows[0]!.id, rows[1]!.id, rows[2]!.id];

    // Put the LAST-logged station first — the whole point of reordering.
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', officer)
      .send({ orderedIds: [c, a, b] });
    expect(res.status).toBe(200);

    const stats = await request(app)
      .get('/api/stats/participation')
      .set('Cookie', officer);
    expect(stats.status).toBe(200);
    const session = stats.body.sessions.find(
      (s: { id: string }) => s.id === sessionId,
    );
    expect(session, 'session missing from stats payload').toBeDefined();
    expect(session.checkIns.map((x: { id: string }) => x.id)).toEqual([c, a, b]);
  });

  it('is reflected by the session summary', async () => {
    const rows = await prisma.checkIn.findMany({
      where: { sessionId }, orderBy: { sequence: 'asc' },
    });
    const [a, b, c] = [rows[0]!.id, rows[1]!.id, rows[2]!.id];
    await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', officer)
      .send({ orderedIds: [b, c, a] });

    const summary = await request(app)
      .get(`/api/sessions/${sessionId}/summary`)
      .set('Cookie', officer);
    expect(summary.status).toBe(200);
    expect(summary.body.checkIns.map((x: { id: string }) => x.id)).toEqual([b, c, a]);
  });

  it('is reflected by the CSV export', async () => {
    const rows = await prisma.checkIn.findMany({
      where: { sessionId }, orderBy: { sequence: 'asc' },
    });
    const [a, b, c] = [rows[0]!.id, rows[1]!.id, rows[2]!.id];
    const byId = new Map(rows.map((r) => [r.id, r.callsign]));
    await request(app)
      .patch(`/api/sessions/${sessionId}/checkins/order`)
      .set('Cookie', officer)
      .send({ orderedIds: [c, b, a] });

    const csv = await request(app)
      .get('/api/stats/export.csv')
      .set('Cookie', officer);
    expect(csv.status).toBe(200);
    const order = [c, b, a].map((id) => byId.get(id)!);
    const positions = order.map((cs) => csv.text.indexOf(cs));
    expect(positions.every((n) => n >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });
});
