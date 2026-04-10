import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let netId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});

describe('sessions', () => {
  it('OFFICER starts a session', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(res.status).toBe(201);
    expect(res.body.netId).toBe(netId);
    expect(res.body.endedAt).toBeNull();
  });
  it('MEMBER cannot start', async () => {
    const m = await request(app).post('/api/auth/register').send({
      email: 'm@x.co', password: 'hunter2hunter2', name: 'M', callsign: 'KB0BOB',
    });
    const res = await request(app).post(`/api/nets/${netId}/sessions`)
      .set('Cookie', m.headers['set-cookie'][0]);
    expect(res.status).toBe(403);
  });
  it('PATCH ends session', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const u = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString(), notes: 'good net' });
    expect(u.status).toBe(200);
    expect(u.body.endedAt).not.toBeNull();
    expect(u.body.notes).toBe('good net');
  });
  it('GET session returns with checkins', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const g = await request(app).get(`/api/sessions/${s.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.checkIns).toEqual([]);
  });
  it('GET list filters by netId', async () => {
    await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const list = await request(app).get(`/api/sessions?netId=${netId}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });
});
