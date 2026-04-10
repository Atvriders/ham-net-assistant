import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officerCookie: string; let memberCookie: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // first user = ADMIN (passes OFFICER checks), second = MEMBER
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officerCookie = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'M', callsign: 'KB0BOB',
  });
  memberCookie = m.headers['set-cookie'][0];
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => { await prisma.repeater.deleteMany(); });

const valid = {
  name: 'KSU Main', frequency: 146.76, offsetKhz: -600,
  toneHz: 91.5, mode: 'FM', coverage: 'Manhattan, KS',
};

describe('GET /api/repeaters (public)', () => {
  it('lists repeaters without auth', async () => {
    await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    const res = await request(app).get('/api/repeaters');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].frequency).toBe(146.76);
  });
});

describe('POST /api/repeaters', () => {
  it('rejects unauthenticated', async () => {
    const res = await request(app).post('/api/repeaters').send(valid);
    expect(res.status).toBe(401);
  });
  it('rejects MEMBER', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', memberCookie).send(valid);
    expect(res.status).toBe(403);
  });
  it('creates as OFFICER+', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('KSU Main');
  });
  it('validates input', async () => {
    const res = await request(app)
      .post('/api/repeaters').set('Cookie', officerCookie)
      .send({ ...valid, frequency: -1 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH/DELETE /api/repeaters/:id', () => {
  it('updates and deletes as officer', async () => {
    const c = await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    const id = c.body.id;
    const u = await request(app)
      .patch(`/api/repeaters/${id}`).set('Cookie', officerCookie)
      .send({ ...valid, name: 'KSU Renamed' });
    expect(u.status).toBe(200);
    expect(u.body.name).toBe('KSU Renamed');
    const d = await request(app).delete(`/api/repeaters/${id}`).set('Cookie', officerCookie);
    expect(d.status).toBe(204);
    const g = await request(app).get('/api/repeaters');
    expect(g.body).toHaveLength(0);
  });
  it('404s unknown id', async () => {
    const res = await request(app)
      .patch('/api/repeaters/nope').set('Cookie', officerCookie).send(valid);
    expect(res.status).toBe(404);
  });
});
