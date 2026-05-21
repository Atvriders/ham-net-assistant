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

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered is ADMIN, satisfies OFFICER+ gating.
  const o = await request(app).post('/api/auth/register').send({
    email: 'o@x.co',
    password: 'hunter2hunter2',
    name: 'Officer',
    callsign: 'W1AW',
  });
  officer = o.headers['set-cookie'][0];

  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co',
    password: 'hunter2hunter2',
    name: 'Member',
    callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
});

afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

beforeEach(async () => {
  await prisma.netScript.deleteMany();
});

describe('saved script library', () => {
  it('officer creates a script and members can list it', async () => {
    const c = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'Opening', category: 'weekly', body: '# Hello' });
    expect(c.status).toBe(201);
    expect(c.body.title).toBe('Opening');
    expect(c.body.category).toBe('weekly');
    expect(c.body.createdByCallsign).toBe('W1AW');

    const l = await request(app).get('/api/scripts').set('Cookie', member);
    expect(l.status).toBe(200);
    expect(l.body).toHaveLength(1);
    expect(l.body[0].body).toBe('# Hello');
  });

  it('list filters by category', async () => {
    await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'A', category: 'weekly', body: 'a' });
    await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'B', category: 'general', body: 'b' });
    await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'C', category: 'impromptu', body: 'c' });

    const w = await request(app)
      .get('/api/scripts?category=weekly')
      .set('Cookie', officer);
    expect(w.status).toBe(200);
    expect(w.body.map((s: { title: string }) => s.title).sort()).toEqual(['A']);

    const i = await request(app)
      .get('/api/scripts?category=impromptu')
      .set('Cookie', officer);
    expect(i.body).toHaveLength(1);
    expect(i.body[0].title).toBe('C');
  });

  it('rejects unauthenticated list (401)', async () => {
    const res = await request(app).get('/api/scripts');
    expect(res.status).toBe(401);
  });

  it('member cannot create / patch / delete (403)', async () => {
    const post = await request(app)
      .post('/api/scripts')
      .set('Cookie', member)
      .send({ title: 'x', body: 'x' });
    expect(post.status).toBe(403);

    const c = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'x', body: 'x' });
    expect(c.status).toBe(201);
    const id = c.body.id as string;

    const patch = await request(app)
      .patch(`/api/scripts/${id}`)
      .set('Cookie', member)
      .send({ title: 'x', body: 'y' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/scripts/${id}`)
      .set('Cookie', member);
    expect(del.status).toBe(403);
  });

  it('patch updates fields and returns the updated row', async () => {
    const c = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'Old', category: 'general', body: 'old body' });
    const id = c.body.id as string;
    const p = await request(app)
      .patch(`/api/scripts/${id}`)
      .set('Cookie', officer)
      .send({ title: 'New', category: 'weekly', body: 'new body' });
    expect(p.status).toBe(200);
    expect(p.body.title).toBe('New');
    expect(p.body.category).toBe('weekly');
    expect(p.body.body).toBe('new body');
  });

  it('delete soft-deletes and list excludes it', async () => {
    const c = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'Bye', body: 'gone' });
    const id = c.body.id as string;

    const d = await request(app)
      .delete(`/api/scripts/${id}`)
      .set('Cookie', officer);
    expect(d.status).toBe(204);

    const l = await request(app).get('/api/scripts').set('Cookie', officer);
    expect(l.body.find((s: { id: string }) => s.id === id)).toBeUndefined();

    const g = await request(app).get(`/api/scripts/${id}`).set('Cookie', officer);
    expect(g.status).toBe(404);

    // Row still exists with deletedAt set
    const row = await prisma.netScript.findUnique({ where: { id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('validation rejects empty title and over-long body', async () => {
    const empty = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: '', body: 'x' });
    expect(empty.status).toBe(400);

    const big = 'x'.repeat(20001);
    const oversize = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'ok', body: big });
    expect(oversize.status).toBe(400);
  });

  it('GET /:id returns the script for any authenticated user', async () => {
    const c = await request(app)
      .post('/api/scripts')
      .set('Cookie', officer)
      .send({ title: 'Solo', body: 'body' });
    const id = c.body.id as string;
    const g = await request(app).get(`/api/scripts/${id}`).set('Cookie', member);
    expect(g.status).toBe(200);
    expect(g.body.title).toBe('Solo');
  });
});
