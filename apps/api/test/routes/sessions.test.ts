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
  await prisma.topicSuggestion.deleteMany();
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
    expect(g.body.net).toBeDefined();
    expect(g.body.net.repeater).toBeDefined();
    expect(Array.isArray(g.body.net.links)).toBe(true);
  });
  it('GET list filters by netId', async () => {
    await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const list = await request(app).get(`/api/sessions?netId=${netId}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });
  it('GET list rejects malformed date query', async () => {
    const res = await request(app).get('/api/sessions?from=garbage');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
  it('starts session with topicId and marks topic USED', async () => {
    const t = await request(app).post('/api/topics').set('Cookie', officer)
      .send({ title: 'Winter Field Day' });
    expect(t.status).toBe(201);
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer)
      .send({ topicId: t.body.id });
    expect(res.status).toBe(201);
    expect(res.body.topicId).toBe(t.body.id);
    expect(res.body.topicTitle).toBe('Winter Field Day');
    const topicAfter = await request(app).get('/api/topics').set('Cookie', officer);
    const row = topicAfter.body.find((r: { id: string; status: string }) => r.id === t.body.id);
    expect(row.status).toBe('USED');
  });
  it('starts session with free-text topicTitle (no topicId)', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer)
      .send({ topicTitle: 'Custom topic' });
    expect(res.status).toBe(201);
    expect(res.body.topicId).toBeNull();
    expect(res.body.topicTitle).toBe('Custom topic');
  });
  it('starts session with empty body => both null', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer).send({});
    expect(res.status).toBe(201);
    expect(res.body.topicId).toBeNull();
    expect(res.body.topicTitle).toBeNull();
  });
  it('GET /api/sessions/:id returns topicTitle', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer)
      .send({ topicTitle: 'Snapshot topic' });
    const g = await request(app).get(`/api/sessions/${s.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.topicTitle).toBe('Snapshot topic');
  });
  it('ADMIN soft-deletes a session (row remains, filtered from GET)', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    const del = await request(app).delete(`/api/sessions/${s.body.id}`).set('Cookie', officer);
    expect(del.status).toBe(204);
    const get = await request(app).get(`/api/sessions/${s.body.id}`);
    expect(get.status).toBe(404);
    const row = await prisma.netSession.findUnique({ where: { id: s.body.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    // check-ins are NOT cascade-deleted; they stay in the DB as orphans
    const remainingCheckIns = await prisma.checkIn.findMany({ where: { sessionId: s.body.id } });
    expect(remainingCheckIns).toHaveLength(1);
  });
  it('MEMBER cannot delete a session (403)', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const m = await request(app).post('/api/auth/register').send({
      email: 'mem-del@x.co', password: 'hunter2hunter2', name: 'M', callsign: 'KB0DEL',
    });
    const res = await request(app).delete(`/api/sessions/${s.body.id}`)
      .set('Cookie', m.headers['set-cookie'][0]);
    expect(res.status).toBe(403);
  });
  it('DELETE unknown session id returns 404', async () => {
    const res = await request(app).delete('/api/sessions/does-not-exist').set('Cookie', officer);
    expect(res.status).toBe(404);
  });
  it('MEMBER GET /api/sessions/:id has net.scriptMd redacted to null', async () => {
    const r = await request(app).post('/api/repeaters').set('Cookie', officer)
      .send({ name: 'Rmem', frequency: 146.52, offsetKhz: 0, mode: 'FM' });
    const n = await request(app).post('/api/nets').set('Cookie', officer).send({
      name: 'Script Net', repeaterId: r.body.id, dayOfWeek: 2,
      startLocal: '19:00', timezone: 'America/Chicago', scriptMd: '# Top secret',
    });
    const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
    const m = await request(app).post('/api/auth/register').send({
      email: `mem-s-${Date.now()}@x.co`,
      password: 'hunter2hunter2', name: 'M', callsign: 'KB0SES',
    });
    const memberCookie = m.headers['set-cookie'][0];
    const g = await request(app).get(`/api/sessions/${s.body.id}`).set('Cookie', memberCookie);
    expect(g.status).toBe(200);
    expect(g.body.net.scriptMd).toBeNull();
  });
  it('OFFICER GET /api/sessions/:id preserves net.scriptMd', async () => {
    const r = await request(app).post('/api/repeaters').set('Cookie', officer)
      .send({ name: 'Rof', frequency: 147.00, offsetKhz: 600, mode: 'FM' });
    const n = await request(app).post('/api/nets').set('Cookie', officer).send({
      name: 'Script Net 2', repeaterId: r.body.id, dayOfWeek: 4,
      startLocal: '21:00', timezone: 'America/Chicago', scriptMd: '# Officer eyes only',
    });
    const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
    const g = await request(app).get(`/api/sessions/${s.body.id}`).set('Cookie', officer);
    expect(g.status).toBe(200);
    expect(g.body.net.scriptMd).toBe('# Officer eyes only');
  });
  it('PATCH controlOpId reassigns the control operator', async () => {
    const email = `offb-${Date.now()}@x.co`;
    await request(app).post('/api/auth/register').send({
      email, password: 'hunter2hunter2', name: 'Officer B', callsign: 'W2BW',
    });
    const bUser = await prisma.user.findFirst({ where: { callsign: 'W2BW' } });
    await prisma.user.update({ where: { id: bUser!.id }, data: { role: 'OFFICER' } });
    // Re-login to get a token with the OFFICER role
    const login = await request(app).post('/api/auth/login').send({ email, password: 'hunter2hunter2' });
    const officerB = login.headers['set-cookie'][0];

    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const patch = await request(app).patch(`/api/sessions/${s.body.id}`)
      .set('Cookie', officerB)
      .send({ controlOpId: bUser!.id });
    expect(patch.status).toBe(200);
    expect(patch.body.controlOpId).toBe(bUser!.id);
  });
  it('GET session includes controlOp with callsign and name', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const g = await request(app).get(`/api/sessions/${s.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.controlOp).toBeDefined();
    expect(g.body.controlOp.callsign).toBe('W1AW');
    expect(g.body.controlOp.name).toBe('A');
  });
  it('GET /api/sessions/:id/summary returns aggregated data', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    const res = await request(app).get(`/api/sessions/${s.body.id}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(s.body.id);
    expect(res.body.net.id).toBe(netId);
    expect(res.body.repeater).toBeDefined();
    expect(res.body.checkIns).toHaveLength(1);
    expect(res.body.stats.count).toBe(1);
  });
});
