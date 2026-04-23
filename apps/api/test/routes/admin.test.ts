import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let admin: string; let member: string; let netId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered user is ADMIN.
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'mem@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Admin Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});

describe('admin trash', () => {
  it('MEMBER cannot list trash (403)', async () => {
    const res = await request(app).get('/api/admin/trash').set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('ADMIN sees empty trash initially', async () => {
    const res = await request(app).get('/api/admin/trash').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.checkIns).toEqual([]);
  });

  it('soft-deleted check-in appears in trash and can be restored', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
    const c = await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', member)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    const del = await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', member);
    expect(del.status).toBe(204);

    const trash = await request(app).get('/api/admin/trash').set('Cookie', admin);
    expect(trash.status).toBe(200);
    expect(trash.body.checkIns).toHaveLength(1);
    expect(trash.body.checkIns[0].id).toBe(c.body.id);
    expect(trash.body.checkIns[0].netName).toBe('Admin Net');

    const restore = await request(app)
      .post(`/api/admin/trash/checkins/${c.body.id}/restore`)
      .set('Cookie', admin);
    expect(restore.status).toBe(200);
    expect(restore.body.ok).toBe(true);
    expect(restore.body.parentSoftDeleted).toBe(false);

    const after = await request(app).get('/api/admin/trash').set('Cookie', admin);
    expect(after.body.checkIns).toHaveLength(0);
  });

  it('ADMIN permanently deletes a soft-deleted check-in', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
    const c = await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', admin)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', admin);

    const purge = await request(app)
      .delete(`/api/admin/trash/checkins/${c.body.id}`)
      .set('Cookie', admin);
    expect(purge.status).toBe(204);
    const row = await prisma.checkIn.findUnique({ where: { id: c.body.id } });
    expect(row).toBeNull();
    // restore now fails
    const restore = await request(app)
      .post(`/api/admin/trash/checkins/${c.body.id}/restore`)
      .set('Cookie', admin);
    expect(restore.status).toBe(404);
  });

  it('soft-deleted session lists in trash, restore works', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
    const del = await request(app).delete(`/api/sessions/${s.body.id}`).set('Cookie', admin);
    expect(del.status).toBe(204);

    const trash = await request(app).get('/api/admin/trash').set('Cookie', admin);
    expect(trash.body.sessions).toHaveLength(1);
    expect(trash.body.sessions[0].id).toBe(s.body.id);
    expect(trash.body.sessions[0].netName).toBe('Admin Net');

    const restore = await request(app)
      .post(`/api/admin/trash/sessions/${s.body.id}/restore`)
      .set('Cookie', admin);
    expect(restore.status).toBe(200);
    const after = await request(app).get('/api/admin/trash').set('Cookie', admin);
    expect(after.body.sessions).toHaveLength(0);
    // Session is now visible again
    const g = await request(app).get(`/api/sessions/${s.body.id}`).set('Cookie', admin);
    expect(g.status).toBe(200);
  });

  it('soft-deleted session is excluded from GET, stats, active', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
    await request(app).delete(`/api/sessions/${s.body.id}`).set('Cookie', admin);

    const g = await request(app).get(`/api/sessions/${s.body.id}`);
    expect(g.status).toBe(404);

    const stats = await request(app).get('/api/stats/participation').set('Cookie', admin);
    expect(stats.status).toBe(200);
    const sIds = (stats.body.sessions as Array<{ id: string }>).map((x) => x.id);
    expect(sIds).not.toContain(s.body.id);

    const active = await request(app).get('/api/nets/active').set('Cookie', admin);
    const activeIds = (active.body as Array<{ id: string }>).map((x) => x.id);
    expect(activeIds).not.toContain(s.body.id);
  });

  it('restoring a check-in warns if parent session is still soft-deleted', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
    const c = await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', admin)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', admin);
    await request(app).delete(`/api/sessions/${s.body.id}`).set('Cookie', admin);

    const restore = await request(app)
      .post(`/api/admin/trash/checkins/${c.body.id}/restore`)
      .set('Cookie', admin);
    expect(restore.status).toBe(200);
    expect(restore.body.ok).toBe(true);
    expect(restore.body.parentSoftDeleted).toBe(true);
  });

  it('MEMBER cannot restore or purge', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
    await request(app).delete(`/api/sessions/${s.body.id}`).set('Cookie', admin);
    const r1 = await request(app)
      .post(`/api/admin/trash/sessions/${s.body.id}/restore`)
      .set('Cookie', member);
    expect(r1.status).toBe(403);
    const r2 = await request(app)
      .delete(`/api/admin/trash/sessions/${s.body.id}`)
      .set('Cookie', member);
    expect(r2.status).toBe(403);
  });
});
