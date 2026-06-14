import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

import { postToDiscord } from '../../src/discord/client.js';

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
  it('OFFICER opens a session into PREP state', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(res.status).toBe(201);
    expect(res.body.netId).toBe(netId);
    expect(res.body.endedAt).toBeNull();
    // New: opens the session in PREP — liveAt is null until /start.
    expect(res.body.liveAt).toBeNull();
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
    await request(app).post(`/api/sessions/${s.body.id}/start`).set('Cookie', officer);
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
    expect(patch.body.controlOp.callsign).toBe('W2BW');
  });
  it('PATCH controlOpId can assign a regular MEMBER as control operator', async () => {
    // A plain MEMBER is a valid Net Control target; only the user-exists check
    // applies. The OFFICER acting role still gates who may *make* the change.
    const m = await request(app).post('/api/auth/register').send({
      email: `mem-as-ctl-${Date.now()}@x.co`,
      password: 'hunter2hunter2', name: 'Plain Member', callsign: 'KB0PCM',
    });
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const patch = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ controlOpId: m.body.id });
    expect(patch.status).toBe(200);
    expect(patch.body.controlOpId).toBe(m.body.id);
    expect(patch.body.controlOp.callsign).toBe('KB0PCM');
  });
  it('rejects controlOpId pointing at a non-existent user', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const patch = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ controlOpId: 'not-a-real-user' });
    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe('VALIDATION');
  });
  it('allows correcting control + topic on an already-ended session', async () => {
    const a = await prisma.user.findFirst({ where: { callsign: 'W1AW' } });
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer)
      .send({ topicTitle: 'Original topic' });
    await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
    // Correcting a finished log's control op + topic is a legitimate fix.
    const patch = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ controlOpId: a!.id, topicTitle: 'Corrected topic' });
    expect(patch.status).toBe(200);
    expect(patch.body.controlOpId).toBe(a!.id);
    expect(patch.body.topicTitle).toBe('Corrected topic');
  });
  it('MEMBER cannot change net control', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const m = await request(app).post('/api/auth/register').send({
      email: `mem-ctl-${Date.now()}@x.co`,
      password: 'hunter2hunter2', name: 'M', callsign: 'KB0CTL',
    });
    const patch = await request(app).patch(`/api/sessions/${s.body.id}`)
      .set('Cookie', m.headers['set-cookie'][0])
      .send({ controlOpId: m.body.id });
    expect(patch.status).toBe(403);
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
    await request(app).post(`/api/sessions/${s.body.id}/start`).set('Cookie', officer);
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
  it('starting same net twice on same day when first is active reuses session', async () => {
    const s1 = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s1.status).toBe(201);
    expect(s1.body.endedAt).toBeNull();
    const s2 = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s2.status).toBe(200);
    expect(s2.body.id).toBe(s1.body.id);
    expect(s2.body.reused).toBe(true);
  });
  it('opening a session does NOT post to Discord (PREP is silent)', async () => {
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(res.status).toBe(201);
    expect(res.body.liveAt).toBeNull();
    // Wait for any fire-and-forget tick that *could* have run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    expect(fn.mock.calls.length).toBe(0);
  });

  it('POST /sessions/:id/start transitions PREP → LIVE and posts to Discord', async () => {
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(open.status).toBe(201);
    expect(open.body.liveAt).toBeNull();
    const start = await request(app)
      .post(`/api/sessions/${open.body.id}/start`)
      .set('Cookie', officer);
    expect(start.status).toBe(200);
    expect(start.body.liveAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
    const lastCall = fn.mock.calls[fn.mock.calls.length - 1];
    const content = String(lastCall[1] ?? '');
    expect(content).toContain('Wed Net');
    expect(content).toContain('live');
  });

  it('POST /sessions/:id/start on already-live session returns 409', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const first = await request(app)
      .post(`/api/sessions/${open.body.id}/start`)
      .set('Cookie', officer);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/sessions/${open.body.id}/start`)
      .set('Cookie', officer);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
    expect(second.body.error.message).toContain('already live');
  });

  it('POST /sessions/:id/start on ended session returns 409', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    await request(app)
      .post(`/api/sessions/${open.body.id}/start`)
      .set('Cookie', officer);
    await request(app).patch(`/api/sessions/${open.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
    const restart = await request(app)
      .post(`/api/sessions/${open.body.id}/start`)
      .set('Cookie', officer);
    expect(restart.status).toBe(409);
    expect(restart.body.error.code).toBe('CONFLICT');
    expect(restart.body.error.message).toContain('already ended');
  });

  it('POST /sessions/:id/start by MEMBER is forbidden', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const m = await request(app).post('/api/auth/register').send({
      email: `mem-start-${Date.now()}@x.co`,
      password: 'hunter2hunter2', name: 'M', callsign: 'KB0MST',
    });
    const res = await request(app)
      .post(`/api/sessions/${open.body.id}/start`)
      .set('Cookie', m.headers['set-cookie'][0]);
    expect(res.status).toBe(403);
  });

  it('POST /sessions/:id/start on unknown id returns 404', async () => {
    const res = await request(app)
      .post('/api/sessions/does-not-exist/start')
      .set('Cookie', officer);
    expect(res.status).toBe(404);
  });

  it('reusing an active same-day session does NOT re-post to Discord', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${open.body.id}/start`).set('Cookie', officer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    expect(fn.mock.calls.length).toBe(0);
  });

  it('starting same net twice on same day when first is ended returns 409', async () => {
    const s1 = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s1.status).toBe(201);
    const end = await request(app).patch(`/api/sessions/${s1.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
    expect(end.status).toBe(200);
    expect(end.body.endedAt).not.toBeNull();
    const s2 = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s2.status).toBe(409);
    expect(s2.body.error.code).toBe('CONFLICT');
    expect(s2.body.error.message).toContain('already exists today');
  });

  it('PATCH endedAt posts a Discord "net ended" notification', async () => {
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s.status).toBe(201);
    // Start the session so check-ins are accepted (PREP → LIVE).
    await request(app).post(`/api/sessions/${s.body.id}/start`).set('Cookie', officer);
    // Add a check-in so we have something to count
    await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    // End the session
    const end = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
    expect(end.status).toBe(200);
    expect(end.body.endedAt).not.toBeNull();
    // Wait for fire-and-forget to run
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
    const lastCall = fn.mock.calls[fn.mock.calls.length - 1];
    const content = String(lastCall[1] ?? '');
    expect(content).toContain('Wed Net');
    expect(content).toContain('ended');
    expect(content).toContain('check-in');
  });

  it('PATCH endedAt again on already-ended session does NOT re-post Discord', async () => {
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s.status).toBe(201);
    // End the session once
    const end1 = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
    expect(end1.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    // Try to PATCH endedAt again with a different timestamp
    const end2 = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date(Date.now() + 60000).toISOString() });
    expect(end2.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    expect(fn.mock.calls.length).toBe(0);
  });

  it('PATCH notes only (no endedAt) does NOT post Discord', async () => {
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(s.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    // PATCH only notes, not endedAt
    const patch = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ notes: 'just notes' });
    expect(patch.status).toBe(200);
    expect(patch.body.notes).toBe('just notes');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    expect(fn.mock.calls.length).toBe(0);
  });
});

describe('session prep gates', () => {
  it('check-in to a PREP session returns 409 CONFLICT', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(open.status).toBe(201);
    expect(open.body.liveAt).toBeNull();
    const ci = await request(app).post(`/api/sessions/${open.body.id}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    expect(ci.status).toBe(409);
    expect(ci.body.error.code).toBe('CONFLICT');
    expect(ci.body.error.message).toContain('preparing');
  });

  it('check-in to a LIVE session succeeds', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${open.body.id}/start`).set('Cookie', officer);
    const ci = await request(app).post(`/api/sessions/${open.body.id}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    expect(ci.status).toBe(201);
  });

  it('chat send to a PREP session is allowed (operators coordinate)', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(open.body.liveAt).toBeNull();
    const msg = await request(app).post(`/api/sessions/${open.body.id}/messages`)
      .set('Cookie', officer)
      .send({ body: 'prep: testing audio' });
    expect(msg.status).toBe(201);
    expect(msg.body.body).toBe('prep: testing audio');
  });

  it('GET /api/nets/active includes PREP sessions', async () => {
    const open = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(open.body.liveAt).toBeNull();
    const active = await request(app).get('/api/nets/active').set('Cookie', officer);
    expect(active.status).toBe(200);
    expect(active.body.some((s: { id: string }) => s.id === open.body.id)).toBe(true);
  });

  it('dedupe: a second POST returns the existing PREP session, not a new one', async () => {
    const first = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.reused).toBe(true);
  });
});
