import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let officer: string;
let member: string;
let member2: string;
let memberUserId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered is ADMIN (which satisfies requireRole('OFFICER'))
  const a = await request(app).post('/api/auth/register').send({
    email: 'o@x.co',
    password: 'hunter2hunter2',
    name: 'Officer',
    callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];

  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co',
    password: 'hunter2hunter2',
    name: 'Member',
    callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  memberUserId = m.body.id;

  const m2 = await request(app).post('/api/auth/register').send({
    email: 'm2@x.co',
    password: 'hunter2hunter2',
    name: 'Member2',
    callsign: 'KC0XYZ',
  });
  member2 = m2.headers['set-cookie'][0];
});

afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

beforeEach(async () => {
  await prisma.topicSuggestion.deleteMany();
});

describe('topic suggestions', () => {
  it('member creates and lists topics', async () => {
    const c = await request(app)
      .post('/api/topics')
      .set('Cookie', member)
      .send({ title: 'Antenna ideas', details: 'EFHW vs dipole' });
    expect(c.status).toBe(201);
    expect(c.body.title).toBe('Antenna ideas');

    const l = await request(app).get('/api/topics').set('Cookie', member);
    expect(l.status).toBe(200);
    expect(l.body).toHaveLength(1);
    expect(l.body[0].createdByCallsign).toBe('KB0BOB');
    expect(l.body[0].createdById).toBe(memberUserId);
  });

  it('unauthenticated create is rejected', async () => {
    const res = await request(app)
      .post('/api/topics')
      .send({ title: 'Nope' });
    expect(res.status).toBe(401);
  });

  it('officer updates status to USED', async () => {
    const c = await request(app)
      .post('/api/topics')
      .set('Cookie', member)
      .send({ title: 'Grounding best practices' });
    const patch = await request(app)
      .patch(`/api/topics/${c.body.id}/status`)
      .set('Cookie', officer)
      .send({ status: 'USED' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('USED');
  });

  it('member cannot update status (403)', async () => {
    const c = await request(app)
      .post('/api/topics')
      .set('Cookie', member)
      .send({ title: 'Repeater etiquette' });
    const patch = await request(app)
      .patch(`/api/topics/${c.body.id}/status`)
      .set('Cookie', member)
      .send({ status: 'USED' });
    expect(patch.status).toBe(403);
  });

  it('member can delete own OPEN topic but not someone else\'s', async () => {
    const mine = await request(app)
      .post('/api/topics')
      .set('Cookie', member)
      .send({ title: 'Mine' });
    const theirs = await request(app)
      .post('/api/topics')
      .set('Cookie', member2)
      .send({ title: 'Theirs' });

    const del1 = await request(app)
      .delete(`/api/topics/${mine.body.id}`)
      .set('Cookie', member);
    expect(del1.status).toBe(204);

    const del2 = await request(app)
      .delete(`/api/topics/${theirs.body.id}`)
      .set('Cookie', member);
    expect(del2.status).toBe(403);
  });
});
