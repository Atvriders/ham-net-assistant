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

  it('PATCH /api/users/:id [ADMIN] can change collegeSlug', async () => {
    const res = await request(app).patch(`/api/users/${memberId}`).set('Cookie', admin)
      .send({ collegeSlug: 'mit' });
    expect(res.status).toBe(200);
    expect(res.body.collegeSlug).toBe('mit');
  });
  it('PATCH /api/users/:id forbidden for non-admin', async () => {
    const res = await request(app).patch(`/api/users/${memberId}`).set('Cookie', member)
      .send({ collegeSlug: 'default' });
    expect(res.status).toBe(403);
  });

  it('PATCH /api/users/:id/role [ADMIN]', async () => {
    const res = await request(app).patch(`/api/users/${memberId}/role`).set('Cookie', admin)
      .send({ role: 'OFFICER' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('OFFICER');
  });

  it('DELETE /api/users/:id forbidden for MEMBER', async () => {
    const victim = await request(app).post('/api/auth/register').send({
      email: 'v1@x.co', password: 'hunter2hunter2', name: 'V1', callsign: 'K1VIC',
    });
    // Demote member-turned-officer back to MEMBER so we can check 403
    await request(app).patch(`/api/users/${memberId}/role`).set('Cookie', admin)
      .send({ role: 'MEMBER' });
    const res = await request(app)
      .delete(`/api/users/${victim.body.id}`).set('Cookie', member);
    expect(res.status).toBe(403);
  });

  it('DELETE /api/users/:id admin cannot delete self', async () => {
    const me = await request(app).get('/api/auth/me').set('Cookie', admin);
    const res = await request(app)
      .delete(`/api/users/${me.body.id}`).set('Cookie', admin);
    expect(res.status).toBe(400);
  });

  it('DELETE /api/users/:id admin deletes user; check-ins preserve callsign with null userId', async () => {
    // Register a user to delete
    const target = await request(app).post('/api/auth/register').send({
      email: 'del@x.co', password: 'hunter2hunter2', name: 'Del', callsign: 'W9DEL',
    });
    const targetId = target.body.id as string;

    // Create a repeater, net, and session as admin, then insert a check-in directly via
    // Prisma so we can assert that deleting the target user nulls both userId and
    // createdById relations (emulating check-ins that the target created).
    const rep = await request(app).post('/api/repeaters').set('Cookie', admin).send({
      name: 'T', frequency: 146.52, offsetKhz: 0, toneHz: null, mode: 'FM',
      coverage: null, latitude: null, longitude: null,
    });
    const net = await request(app).post('/api/nets').set('Cookie', admin).send({
      name: 'Test Net', repeaterId: rep.body.id, dayOfWeek: 1,
      startLocal: '19:00', timezone: 'America/Chicago', active: true,
    });
    const session = await request(app).post(`/api/nets/${net.body.id}/sessions`)
      .set('Cookie', admin).send({});
    expect(session.status).toBe(201);
    const createdCi = await prisma.checkIn.create({
      data: {
        sessionId: session.body.id,
        callsign: 'W9DEL',
        nameAtCheckIn: 'Del',
        userId: targetId,
        createdById: targetId,
      },
    });
    const ciId = createdCi.id;

    // Delete the user
    const del = await request(app).delete(`/api/users/${targetId}`).set('Cookie', admin);
    expect(del.status).toBe(204);

    // Check-in record should still exist with userId and createdById null but callsign preserved
    const surviving = await prisma.checkIn.findUnique({ where: { id: ciId } });
    expect(surviving).not.toBeNull();
    expect(surviving!.userId).toBeNull();
    expect(surviving!.createdById).toBeNull();
    expect(surviving!.callsign).toBe('W9DEL');
  });

  it('DELETE /api/users/:id returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/users/nope').set('Cookie', admin);
    expect(res.status).toBe(404);
  });
});
