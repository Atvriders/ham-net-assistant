import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

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
beforeEach(async () => { await prisma.sessionMessage.deleteMany(); });

describe('session messages', () => {
  it('authenticated member can POST and GET returns it', async () => {
    const post = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'Hello net!' });
    expect(post.status).toBe(201);
    expect(post.body.callsign).toBe('KB0BOB');
    expect(post.body.nameAtMessage).toBe('Bob');
    expect(post.body.body).toBe('Hello net!');

    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.status).toBe(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].body).toBe('Hello net!');
  });

  it('unauthenticated POST returns 401', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .send({ body: 'nope' });
    expect(res.status).toBe(401);
  });

  it('unauthenticated GET returns 401', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/messages`);
    expect(res.status).toBe(401);
  });

  it('empty body returns 400', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: '' });
    expect(res.status).toBe(400);
  });

  it('whitespace-only body returns 400', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('501+ char body returns 400', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('POST to non-existent session returns 404', async () => {
    const res = await request(app).post('/api/sessions/missing/messages')
      .set('Cookie', member).send({ body: 'hi' });
    expect(res.status).toBe(404);
  });

  it('member can delete own message within 5 minutes', async () => {
    const post = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'delete me' });
    expect(post.status).toBe(201);
    const del = await request(app).delete(`/api/messages/${post.body.id}`)
      .set('Cookie', member);
    expect(del.status).toBe(204);
  });

  it('member cannot delete someone else\'s message (403)', async () => {
    const post = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'mine' });
    expect(post.status).toBe(201);
    const del = await request(app).delete(`/api/messages/${post.body.id}`)
      .set('Cookie', other);
    expect(del.status).toBe(403);
  });

  it('officer can delete any message', async () => {
    const post = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'by member' });
    expect(post.status).toBe(201);
    const del = await request(app).delete(`/api/messages/${post.body.id}`)
      .set('Cookie', officer);
    expect(del.status).toBe(204);
  });

  it('delete non-existent id returns 404', async () => {
    const res = await request(app).delete('/api/messages/does-not-exist')
      .set('Cookie', officer);
    expect(res.status).toBe(404);
  });

  it('member cannot delete own message after 5 minutes', async () => {
    const post = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'old' });
    expect(post.status).toBe(201);
    // Manually backdate
    await prisma.sessionMessage.update({
      where: { id: post.body.id },
      data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    const del = await request(app).delete(`/api/messages/${post.body.id}`)
      .set('Cookie', member);
    expect(del.status).toBe(403);
  });

  it('GET returns messages in chronological order', async () => {
    await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'first' });
    await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', officer).send({ body: 'second' });
    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.body).toHaveLength(2);
    expect(get.body[0].body).toBe('first');
    expect(get.body[1].body).toBe('second');
  });
});
