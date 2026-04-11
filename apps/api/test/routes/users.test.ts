import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let admin: string; let member: string; let memberId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  memberId = m.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('users', () => {
  it('PATCH /api/users/me updates self', async () => {
    const res = await request(app).patch('/api/users/me').set('Cookie', member)
      .send({ collegeSlug: 'kstate', name: 'Robert' });
    expect(res.status).toBe(200);
    expect(res.body.collegeSlug).toBe('kstate');
    expect(res.body.name).toBe('Robert');
  });
  it('GET /api/users [ADMIN only]', async () => {
    const forbidden = await request(app).get('/api/users').set('Cookie', member);
    expect(forbidden.status).toBe(403);
    const ok = await request(app).get('/api/users').set('Cookie', admin);
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBe(2);
  });
  it('GET /api/users/directory returns callsign+name list for any member', async () => {
    const unauth = await request(app).get('/api/users/directory');
    expect(unauth.status).toBe(401);
    const res = await request(app).get('/api/users/directory').set('Cookie', member);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0]).toHaveProperty('callsign');
    expect(res.body[0]).toHaveProperty('name');
  });

  it('PATCH /api/users/:id/role [ADMIN]', async () => {
    const res = await request(app).patch(`/api/users/${memberId}/role`).set('Cookie', admin)
      .send({ role: 'OFFICER' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('OFFICER');
  });
});
