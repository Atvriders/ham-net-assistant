import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'Alice', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
  await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
    .send({ callsign: 'W1AW', nameAtCheckIn: 'Alice' });
  await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
    .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('stats', () => {
  it('GET /api/stats/participation returns totals', async () => {
    const res = await request(app).get('/api/stats/participation');
    expect(res.status).toBe(200);
    expect(res.body.totalCheckIns).toBe(2);
    expect(res.body.totalSessions).toBe(1);
    expect(res.body.perNet).toHaveLength(1);
  });

  it('GET /api/stats/export.csv streams CSV', async () => {
    const res = await request(app).get('/api/stats/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/callsign/i);
    expect(res.text).toMatch(/W1AW/);
    expect(res.text).toMatch(/KC0GST/);
  });

  it('GET /api/stats/export.pdf returns PDF bytes', async () => {
    const res = await request(app).get('/api/stats/export.pdf').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).slice(0, 5).toString()).toBe('%PDF-');
  });
});
