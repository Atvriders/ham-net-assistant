import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let repeaterId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer).send({
    name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM',
  });
  repeaterId = r.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => { await prisma.netSession.deleteMany(); await prisma.net.deleteMany(); });

const netBody = () => ({
  name: 'Wed Net', repeaterId, dayOfWeek: 3, startLocal: '20:00',
  timezone: 'America/Chicago', theme: 'Intro to CW', scriptMd: '# Hello',
});

describe('nets CRUD', () => {
  it('lists empty', async () => {
    const res = await request(app).get('/api/nets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
  it('creates, lists, updates, deletes', async () => {
    const c = await request(app).post('/api/nets').set('Cookie', officer).send(netBody());
    expect(c.status).toBe(201);
    expect(c.body.name).toBe('Wed Net');
    const list = await request(app).get('/api/nets');
    expect(list.body).toHaveLength(1);
    const u = await request(app).patch(`/api/nets/${c.body.id}`).set('Cookie', officer)
      .send({ ...netBody(), name: 'Wed Net v2' });
    expect(u.body.name).toBe('Wed Net v2');
    const d = await request(app).delete(`/api/nets/${c.body.id}`).set('Cookie', officer);
    expect(d.status).toBe(204);
  });
  it('validates startLocal format', async () => {
    const res = await request(app).post('/api/nets').set('Cookie', officer)
      .send({ ...netBody(), startLocal: '9pm' });
    expect(res.status).toBe(400);
  });
  it('rejects unauthenticated writes', async () => {
    const res = await request(app).post('/api/nets').send(netBody());
    expect(res.status).toBe(401);
  });
});
