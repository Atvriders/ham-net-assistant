import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let cookie: string; let userId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  cookie = a.headers['set-cookie'][0];
  userId = a.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('presence heartbeat', () => {
  it('rejects an unauthenticated heartbeat', async () => {
    const res = await request(app).post('/api/presence/heartbeat');
    expect(res.status).toBe(401);
  });

  it('answers 401 (not 500) for a deleted account', async () => {
    // The tab keeps beating every 45s after an officer deletes the member;
    // this used to be an endless stream of 500s with nothing the client could
    // act on.
    const gone = await request(app).post('/api/auth/register').send({
      email: 'gone@x.co', password: 'hunter2hunter2', name: 'Gone', callsign: 'KG0ONE',
    });
    const goneCookie = gone.headers['set-cookie'][0];
    await prisma.user.delete({ where: { id: gone.body.id } });
    const res = await request(app).post('/api/presence/heartbeat').set('Cookie', goneCookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('answers 401 when the account disappears mid-request', async () => {
    // Same outcome for the narrow race where the row survives loadUser's read
    // and is gone by the time the write lands (Prisma raises P2025).
    const spy = vi.spyOn(prisma.user, 'update').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    try {
      const res = await request(app).post('/api/presence/heartbeat').set('Cookie', cookie);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    } finally {
      spy.mockRestore();
    }
  });

  it('updates lastSeenAt for the current user', async () => {
    const before = await prisma.user.findUnique({ where: { id: userId } });
    expect(before!.lastSeenAt).toBeNull();
    const res = await request(app).post('/api/presence/heartbeat').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.lastSeenAt).toBe('string');
    const after = await prisma.user.findUnique({ where: { id: userId } });
    expect(after!.lastSeenAt).not.toBeNull();
  });

  it('GET /online includes a user who just sent a heartbeat', async () => {
    await request(app).post('/api/presence/heartbeat').set('Cookie', cookie);
    const res = await request(app).get('/api/presence/online').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u: { id: string }) => u.id === userId)).toBe(true);
  });

  it('GET /online excludes a user whose lastSeenAt is stale (> 2 min)', async () => {
    // Register a separate user and backdate their lastSeenAt past the window.
    const b = await request(app).post('/api/auth/register').send({
      email: 'stale@x.co', password: 'hunter2hunter2', name: 'Stale', callsign: 'KB0OLD',
    });
    const staleId = b.body.id;
    await prisma.user.update({
      where: { id: staleId },
      data: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
    const res = await request(app).get('/api/presence/online').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.some((u: { id: string }) => u.id === staleId)).toBe(false);
  });

  it('GET /online excludes a user who never sent a heartbeat', async () => {
    const c = await request(app).post('/api/auth/register').send({
      email: 'never@x.co', password: 'hunter2hunter2', name: 'Never', callsign: 'KB0NEW',
    });
    const res = await request(app).get('/api/presence/online').set('Cookie', cookie);
    expect(res.body.some((u: { id: string }) => u.id === c.body.id)).toBe(false);
  });
});
