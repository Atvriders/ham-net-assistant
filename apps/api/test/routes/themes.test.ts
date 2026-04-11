import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
beforeAll(async () => { ({ app, prisma, dbFile } = await makeTestApp()); });
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('GET /api/themes', () => {
  it('returns default theme at minimum, no auth required', async () => {
    const res = await request(app).get('/api/themes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const slugs = (res.body as Array<{ slug: string }>).map((t) => t.slug);
    expect(slugs).toContain('default');
  });
});

describe('default theme setting', () => {
  let adminCookie: string;
  let memberCookie: string;
  beforeAll(async () => {
    const a = await request(app).post('/api/auth/register').send({
      email: 'theme-admin@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1THM',
    });
    adminCookie = a.headers['set-cookie'][0];
    const m = await request(app).post('/api/auth/register').send({
      email: 'theme-mem@x.co', password: 'hunter2hunter2', name: 'Mem', callsign: 'KB0THM',
    });
    memberCookie = m.headers['set-cookie'][0];
  });

  it("GET /api/themes/default returns 'default' when unset", async () => {
    const res = await request(app).get('/api/themes/default');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('default');
  });

  it('PATCH /api/themes/default admin can set slug; subsequent GET returns it', async () => {
    const set = await request(app).patch('/api/themes/default')
      .set('Cookie', adminCookie).send({ slug: 'kstate' });
    expect(set.status).toBe(200);
    expect(set.body.slug).toBe('kstate');
    const get = await request(app).get('/api/themes/default');
    expect(get.body.slug).toBe('kstate');
  });

  it('PATCH /api/themes/default forbidden for non-admin', async () => {
    const res = await request(app).patch('/api/themes/default')
      .set('Cookie', memberCookie).send({ slug: 'default' });
    expect(res.status).toBe(403);
  });

  it('PATCH /api/themes/default rejects unknown slug', async () => {
    const res = await request(app).patch('/api/themes/default')
      .set('Cookie', adminCookie).send({ slug: 'nonexistent' });
    expect(res.status).toBe(400);
  });
});
