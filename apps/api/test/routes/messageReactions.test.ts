import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

// Skip the actual Discord forwarding so tests don't open network connections.
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
let officer: string; let member: string; let other: string;
let sessionId: string;

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
  const o = await request(app).post('/api/auth/register').send({
    email: 'o@x.co', password: 'hunter2hunter2', name: 'Cara', callsign: 'KC0CAR',
  });
  other = o.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
  sessionId = s.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.sessionMessageReaction.deleteMany();
  await prisma.sessionMessage.deleteMany();
});

async function postMessage(cookie: string, body: string): Promise<string> {
  const r = await request(app).post(`/api/sessions/${sessionId}/messages`)
    .set('Cookie', cookie).send({ body });
  return r.body.id as string;
}

describe('message reactions', () => {
  it('member POST reaction → 201, visible in GET /messages', async () => {
    const messageId = await postMessage(member, 'Hello');
    const post = await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', member).send({ emoji: '👍' });
    expect(post.status).toBe(201);
    expect(post.body.emoji).toBe('👍');
    expect(post.body.source).toBe('web');

    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.status).toBe(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].reactions).toHaveLength(1);
    expect(get.body[0].reactions[0].emoji).toBe('👍');
  });

  it('member DELETE own reaction → 204, gone from GET', async () => {
    const messageId = await postMessage(member, 'Hello');
    await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', member).send({ emoji: '🎉' });

    const del = await request(app)
      .delete(`/api/messages/${messageId}/reactions/${encodeURIComponent('🎉')}`)
      .set('Cookie', member);
    expect(del.status).toBe(204);

    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.body[0].reactions).toHaveLength(0);
  });

  it('member DELETE other user\'s reaction → 403', async () => {
    const messageId = await postMessage(member, 'Hello');
    await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', other).send({ emoji: '❤️' });

    const del = await request(app)
      .delete(`/api/messages/${messageId}/reactions/${encodeURIComponent('❤️')}`)
      .set('Cookie', member);
    expect(del.status).toBe(403);
  });

  it('unauthed POST reaction → 401', async () => {
    const messageId = await postMessage(member, 'Hello');
    const post = await request(app).post(`/api/messages/${messageId}/reactions`)
      .send({ emoji: '👍' });
    expect(post.status).toBe(401);
  });

  it('POST same reaction twice is idempotent', async () => {
    const messageId = await postMessage(member, 'Hi');
    const a = await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', member).send({ emoji: '⚡' });
    const b = await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', member).send({ emoji: '⚡' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.body[0].reactions).toHaveLength(1);
  });

  it('two users can both add same emoji and counts both', async () => {
    const messageId = await postMessage(member, 'Yo');
    await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', member).send({ emoji: '🎉' });
    await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', other).send({ emoji: '🎉' });
    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.body[0].reactions).toHaveLength(2);
  });

  it('POST with empty emoji → 400', async () => {
    const messageId = await postMessage(member, 'Hi');
    const post = await request(app).post(`/api/messages/${messageId}/reactions`)
      .set('Cookie', member).send({ emoji: '' });
    expect(post.status).toBe(400);
  });
});
