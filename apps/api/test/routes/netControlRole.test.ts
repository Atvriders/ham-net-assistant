import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

// Discord is fire-and-forget on start/end; stub it so these role tests don't
// reach the network (mirrors sessions.test.ts).
vi.mock('../../src/discord/client.js', async () => {
  const actual: object = await vi.importActual('../../src/discord/client.js');
  return {
    ...actual,
    postToDiscord: vi.fn().mockResolvedValue({ ok: false, reason: 'mocked' }),
    getActiveClient: vi.fn().mockReturnValue(null),
    loadDiscordConfig: vi.fn().mockResolvedValue({ enabled: false, token: null, channelId: null }),
  };
});

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

// Cookies carrying each role's JWT (role is baked into the token at login).
let admin: string;
let netctl: string;
let member: string;
let memberId: string;
let netctlId: string;
let netId: string;

/**
 * Register a user (they land as MEMBER), promote them to NET_CONTROL via the
 * ADMIN role route, then log in again so the returned cookie's JWT carries the
 * new role. Roles are free-form strings in the DB — no migration involved.
 */
async function makeNetControl(
  email: string,
  callsign: string,
): Promise<{ cookie: string; id: string }> {
  const password = 'hunter2hunter2';
  const reg = await request(app).post('/api/auth/register').send({
    email, password, name: 'Net Control Op', callsign,
  });
  const id = reg.body.id as string;
  const promote = await request(app)
    .patch(`/api/users/${id}/role`)
    .set('Cookie', admin)
    .send({ role: 'NET_CONTROL' });
  expect(promote.status).toBe(200);
  expect(promote.body.role).toBe('NET_CONTROL');
  const login = await request(app).post('/api/auth/login').send({ email, password });
  return { cookie: login.headers['set-cookie'][0], id };
}

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered user is ADMIN.
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];

  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'Member', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  memberId = m.body.id;

  const nc = await makeNetControl('nc@x.co', 'NC0NET');
  netctl = nc.cookie;
  netctlId = nc.id;

  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', admin).send({
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

/** Open + start a LIVE session as Net Control; returns the session id. */
async function openLiveSession(): Promise<string> {
  const opened = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', netctl);
  expect(opened.status).toBe(201);
  const started = await request(app).post(`/api/sessions/${opened.body.id}/start`)
    .set('Cookie', netctl);
  expect(started.status).toBe(200);
  expect(started.body.liveAt).not.toBeNull();
  return opened.body.id as string;
}

describe('NET_CONTROL — can run the net', () => {
  it('opens a session into PREP', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', netctl);
    expect(res.status).toBe(201);
    expect(res.body.netId).toBe(netId);
    expect(res.body.liveAt).toBeNull();
    // Net Control opened it, so it becomes the control operator.
    expect(res.body.controlOpId).toBe(netctlId);
  });

  it('starts (goes live)', async () => {
    const opened = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', netctl);
    const started = await request(app).post(`/api/sessions/${opened.body.id}/start`)
      .set('Cookie', netctl);
    expect(started.status).toBe(200);
    expect(started.body.liveAt).not.toBeNull();
  });

  it('takes / reassigns control (PATCH controlOpId)', async () => {
    const id = await openLiveSession();
    const patch = await request(app).patch(`/api/sessions/${id}`).set('Cookie', netctl)
      .send({ controlOpId: memberId });
    expect(patch.status).toBe(200);
    expect(patch.body.controlOpId).toBe(memberId);
  });

  it('sets and clears the net topic (PATCH topicTitle / topicId)', async () => {
    const id = await openLiveSession();
    const setTitle = await request(app).patch(`/api/sessions/${id}`).set('Cookie', netctl)
      .send({ topicTitle: 'Grid square hunting' });
    expect(setTitle.status).toBe(200);
    expect(setTitle.body.topicTitle).toBe('Grid square hunting');

    // Link a queued suggestion (topicId + topicTitle), then clear it.
    const topic = await request(app).post('/api/topics').set('Cookie', member)
      .send({ title: 'Winter Field Day' });
    const link = await request(app).patch(`/api/sessions/${id}`).set('Cookie', netctl)
      .send({ topicId: topic.body.id, topicTitle: 'Winter Field Day' });
    expect(link.status).toBe(200);
    expect(link.body.topicId).toBe(topic.body.id);

    const clear = await request(app).patch(`/api/sessions/${id}`).set('Cookie', netctl)
      .send({ topicTitle: '' });
    expect(clear.status).toBe(200);
    expect(clear.body.topicTitle).toBeNull();
    expect(clear.body.topicId).toBeNull();
  });

  it('marks a suggestion USED (PATCH /topics/:id/status)', async () => {
    const topic = await request(app).post('/api/topics').set('Cookie', member)
      .send({ title: 'Antenna clinic' });
    const patch = await request(app).patch(`/api/topics/${topic.body.id}/status`)
      .set('Cookie', netctl).send({ status: 'USED' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('USED');
  });

  it('edits and deletes ANY check-in (not just own-recent)', async () => {
    const id = await openLiveSession();
    // Member logs their own check-in.
    const ci = await request(app).post(`/api/sessions/${id}/checkins`).set('Cookie', member)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Member' });
    expect(ci.status).toBe(201);

    // Net Control edits someone else's entry.
    const edit = await request(app).patch(`/api/checkins/${ci.body.id}`).set('Cookie', netctl)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Corrected Name' });
    expect(edit.status).toBe(200);
    expect(edit.body.nameAtCheckIn).toBe('Corrected Name');

    // ...and deletes it.
    const del = await request(app).delete(`/api/checkins/${ci.body.id}`).set('Cookie', netctl);
    expect(del.status).toBe(204);
  });

  it('ends the net (PATCH endedAt)', async () => {
    const id = await openLiveSession();
    const end = await request(app).patch(`/api/sessions/${id}`).set('Cookie', netctl)
      .send({ endedAt: new Date().toISOString() });
    expect(end.status).toBe(200);
    expect(end.body.endedAt).not.toBeNull();
  });

  it('reads the change-control roster (GET /users/control-candidates)', async () => {
    const res = await request(app).get('/api/users/control-candidates').set('Cookie', netctl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('NET_CONTROL — cannot touch club configuration (403)', () => {
  it('cannot create a net', async () => {
    const res = await request(app).post('/api/nets').set('Cookie', netctl).send({
      name: 'Sneaky Net', repeaterId: 'x', dayOfWeek: 1,
      startLocal: '19:00', timezone: 'America/Chicago',
    });
    expect(res.status).toBe(403);
  });

  it('cannot edit a net', async () => {
    const res = await request(app).patch(`/api/nets/${netId}`).set('Cookie', netctl)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(403);
  });

  it('cannot create a repeater', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', netctl)
      .send({ name: 'R2', frequency: 147.0, offsetKhz: 600, mode: 'FM' });
    expect(res.status).toBe(403);
  });

  it('cannot create a saved script', async () => {
    const res = await request(app).post('/api/scripts').set('Cookie', netctl)
      .send({ title: 'Preamble', category: 'general', body: '# hi' });
    expect(res.status).toBe(403);
  });

  it('cannot view participation stats', async () => {
    const res = await request(app).get('/api/stats/participation').set('Cookie', netctl);
    expect(res.status).toBe(403);
  });

  it('cannot change a user role', async () => {
    const res = await request(app).patch(`/api/users/${memberId}/role`).set('Cookie', netctl)
      .send({ role: 'OFFICER' });
    expect(res.status).toBe(403);
  });

  it('cannot destructively delete a session (cleanup stays ADMIN)', async () => {
    const opened = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', netctl);
    const res = await request(app).delete(`/api/sessions/${opened.body.id}`).set('Cookie', netctl);
    expect(res.status).toBe(403);
  });
});

describe('MEMBER — zero net-control access (the critical guarantee)', () => {
  it('cannot open a session', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('cannot start a session', async () => {
    const id = await openLiveSession();
    // Re-open would collide; use the live session id — the gate rejects before
    // any state check, so a MEMBER never reaches the "already live" logic.
    const res = await request(app).post(`/api/sessions/${id}/start`).set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('cannot patch a session (control / topic / end)', async () => {
    const id = await openLiveSession();
    const res = await request(app).patch(`/api/sessions/${id}`).set('Cookie', member)
      .send({ topicTitle: 'nope' });
    expect(res.status).toBe(403);
  });

  it('cannot read the change-control roster', async () => {
    const res = await request(app).get('/api/users/control-candidates').set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('cannot mark a suggestion USED', async () => {
    const topic = await request(app).post('/api/topics').set('Cookie', member)
      .send({ title: 'Member topic' });
    const res = await request(app).patch(`/api/topics/${topic.body.id}/status`)
      .set('Cookie', member).send({ status: 'USED' });
    expect(res.status).toBe(403);
  });
});
