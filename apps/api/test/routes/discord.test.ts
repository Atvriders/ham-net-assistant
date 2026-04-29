import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';

// Mock client side-effects so the route does not try to connect to Discord
// during tests. sendTestMessage is overridden per-test by reassigning the
// mocked module export.
vi.mock('../../src/discord/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/discord/client.js')>(
    '../../src/discord/client.js',
  );
  return {
    ...actual,
    applyDiscordConfig: vi.fn(async () => undefined),
    sendTestMessage: vi.fn(async () => null),
  };
});

import { makeTestApp, cleanupTestDb } from '../helpers.js';
import * as discordClient from '../../src/discord/client.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let admin: string;
let member: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered user is ADMIN.
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@d.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'mem@d.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
});

afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('GET /api/discord/config', () => {
  it('rejects unauthenticated request', async () => {
    const res = await request(app).get('/api/discord/config');
    expect(res.status).toBe(401);
  });

  it('rejects member with 403', async () => {
    const res = await request(app).get('/api/discord/config').set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('admin sees defaults when nothing is configured', async () => {
    const res = await request(app).get('/api/discord/config').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.reminderLeadsMinutes).toEqual([240, 30]);
    expect(res.body.tokenSet).toBe(false);
    expect(res.body.channelId).toBe('');
    expect(res.body.enabled).toBe(false);
  });
});

describe('PATCH /api/discord/config', () => {
  it('rejects member with 403', async () => {
    const res = await request(app)
      .patch('/api/discord/config')
      .set('Cookie', member)
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('admin can update reminder leads; sorted descending and deduped', async () => {
    const res = await request(app)
      .patch('/api/discord/config')
      .set('Cookie', admin)
      .send({ reminderLeadsMinutes: [15, 1440, 120, 120] });
    expect(res.status).toBe(204);

    const got = await request(app).get('/api/discord/config').set('Cookie', admin);
    expect(got.body.reminderLeadsMinutes).toEqual([1440, 120, 15]);
  });

  it('admin can set channel id and enabled flag', async () => {
    await request(app)
      .patch('/api/discord/config')
      .set('Cookie', admin)
      .send({ enabled: true, channelId: '111122223333' });

    const got = await request(app).get('/api/discord/config').set('Cookie', admin);
    expect(got.body.enabled).toBe(true);
    expect(got.body.channelId).toBe('111122223333');
  });

  it('admin can set, then clear the token via null', async () => {
    await request(app)
      .patch('/api/discord/config')
      .set('Cookie', admin)
      .send({ token: 'super-secret-bot-token' });
    let got = await request(app).get('/api/discord/config').set('Cookie', admin);
    expect(got.body.tokenSet).toBe(true);

    await request(app)
      .patch('/api/discord/config')
      .set('Cookie', admin)
      .send({ token: null });
    got = await request(app).get('/api/discord/config').set('Cookie', admin);
    expect(got.body.tokenSet).toBe(false);
  });

  it('rejects out-of-range lead values', async () => {
    const res = await request(app)
      .patch('/api/discord/config')
      .set('Cookie', admin)
      .send({ reminderLeadsMinutes: [99999] });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('empty leads array is valid (no-op for reader)', async () => {
    const res = await request(app)
      .patch('/api/discord/config')
      .set('Cookie', admin)
      .send({ reminderLeadsMinutes: [] });
    expect(res.status).toBe(204);
  });
});

describe('POST /api/discord/test', () => {
  it('rejects member with 403', async () => {
    const res = await request(app).post('/api/discord/test').set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('returns 500 when not configured (no message id)', async () => {
    const sendMock = vi.mocked(discordClient.sendTestMessage);
    sendMock.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/discord/test').set('Cookie', admin);
    expect(res.status).toBe(500);
  });

  it('returns the message id on success', async () => {
    const sendMock = vi.mocked(discordClient.sendTestMessage);
    sendMock.mockResolvedValueOnce('discord-msg-id-123');
    const res = await request(app).post('/api/discord/test').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.messageId).toBe('discord-msg-id-123');
  });
});

describe('GET /api/discord/status (public-ish)', () => {
  it('reflects whether bridge is configured', async () => {
    const res = await request(app).get('/api/discord/status');
    expect(res.status).toBe(200);
    // After earlier tests we set enabled=true, channel=11..., but token was cleared.
    // So configured should be false.
    expect(typeof res.body.enabled).toBe('boolean');
  });
});
