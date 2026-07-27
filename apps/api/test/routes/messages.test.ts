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

describe('session messages window', () => {
  it('returns the NEWEST 400 messages, still in chronological order', async () => {
    // Ordering ascending before `take` pinned the panel to the oldest 400 rows:
    // once a session crossed the cap the chat silently froze — new messages
    // never appeared even though POSTs kept returning 201. That is reachable by
    // calendar time because the Discord bridge files inbound traffic into the
    // newest never-ended session.
    const base = Date.now() - 500 * 60 * 1000;
    await prisma.sessionMessage.createMany({
      data: Array.from({ length: 450 }, (_, i) => ({
        sessionId,
        callsign: 'KB0BOB',
        nameAtMessage: 'Bob',
        body: `msg-${String(i).padStart(3, '0')}`,
        createdAt: new Date(base + i * 60 * 1000),
      })),
    });

    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.status).toBe(200);
    const bodies = get.body.map((m: { body: string }) => m.body);
    expect(bodies).toHaveLength(400);
    // Window is the tail: msg-050..msg-449, oldest 50 dropped.
    expect(bodies[0]).toBe('msg-050');
    expect(bodies[399]).toBe('msg-449');
    expect(bodies).not.toContain('msg-049');
    // Still ascending by createdAt, which is what ChatBox renders.
    const times = get.body.map((m: { createdAt: string }) => new Date(m.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('a message posted after the cap is reached is visible immediately', async () => {
    const base = Date.now() - 500 * 60 * 1000;
    await prisma.sessionMessage.createMany({
      data: Array.from({ length: 420 }, (_, i) => ({
        sessionId,
        callsign: 'KB0BOB',
        nameAtMessage: 'Bob',
        body: `old-${i}`,
        createdAt: new Date(base + i * 60 * 1000),
      })),
    });
    const post = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'brand new' });
    expect(post.status).toBe(201);

    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    const bodies = get.body.map((m: { body: string }) => m.body);
    expect(bodies).toHaveLength(400);
    expect(bodies[bodies.length - 1]).toBe('brand new');
  });
});

describe('session messages 24h backfill', () => {
  // Each test in this block builds its own world (extra repeater/net/sessions)
  // so it stays independent of the outer suite's shared fixtures.
  it('returns recent messages from other sessions on the same Net but not older ones, and excludes other-Net or soft-deleted sessions', async () => {
    const current = await prisma.netSession.findUniqueOrThrow({ where: { id: sessionId } });

    // Same-Net sibling session, already ended (created directly to bypass the
    // "one session per net per day" guard on POST /nets/:id/sessions).
    const sibling = await prisma.netSession.create({
      data: {
        netId: current.netId,
        startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      },
    });

    // Different Net.
    const r2 = await request(app).post('/api/repeaters').set('Cookie', officer)
      .send({ name: 'R2-backfill', frequency: 147.0, offsetKhz: -600, mode: 'FM' });
    const otherNet = await request(app).post('/api/nets').set('Cookie', officer).send({
      name: 'Other Net BF', repeaterId: r2.body.id, dayOfWeek: 4,
      startLocal: '20:00', timezone: 'America/Chicago',
    });
    const otherSession = await prisma.netSession.create({
      data: {
        netId: otherNet.body.id,
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });

    // Same-Net but soft-deleted.
    const deletedSibling = await prisma.netSession.create({
      data: {
        netId: current.netId,
        startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
        deletedAt: new Date(),
      },
    });

    // Seed messages:
    //   - recent same-Net sibling (within 24h)  -> included
    //   - old same-Net sibling (> 24h)         -> excluded
    //   - other Net within 24h                 -> excluded
    //   - soft-deleted same-Net within 24h     -> excluded
    //   - current session                      -> included
    const recent = await prisma.sessionMessage.create({
      data: {
        sessionId: sibling.id,
        callsign: 'KB0BOB',
        nameAtMessage: 'Bob',
        body: 'recent sibling',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    await prisma.sessionMessage.create({
      data: {
        sessionId: sibling.id,
        callsign: 'KB0BOB',
        nameAtMessage: 'Bob',
        body: 'ancient sibling',
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    await prisma.sessionMessage.create({
      data: {
        sessionId: otherSession.id,
        callsign: 'KC0CAR',
        nameAtMessage: 'Cara',
        body: 'other net chatter',
        createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    });
    await prisma.sessionMessage.create({
      data: {
        sessionId: deletedSibling.id,
        callsign: 'KC0CAR',
        nameAtMessage: 'Cara',
        body: 'deleted sibling chatter',
        createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    });
    await request(app).post(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member).send({ body: 'live one' });

    const get = await request(app).get(`/api/sessions/${sessionId}/messages`)
      .set('Cookie', member);
    expect(get.status).toBe(200);
    const bodies = get.body.map((m: { body: string }) => m.body);
    expect(bodies).toContain('recent sibling');
    expect(bodies).toContain('live one');
    expect(bodies).not.toContain('ancient sibling');
    expect(bodies).not.toContain('other net chatter');
    expect(bodies).not.toContain('deleted sibling chatter');

    // Order ascending by createdAt: recent sibling (2h ago) precedes live one.
    const recentIdx = bodies.indexOf('recent sibling');
    const liveIdx = bodies.indexOf('live one');
    expect(recentIdx).toBeLessThan(liveIdx);

    // Each row carries its sessionId so the client can tell apart backfill.
    const recentRow = get.body.find((m: { id: string }) => m.id === recent.id);
    expect(recentRow.sessionId).toBe(sibling.id);
    const liveRow = get.body.find((m: { body: string }) => m.body === 'live one');
    expect(liveRow.sessionId).toBe(sessionId);
  });

  it('GET on a non-existent session returns 404', async () => {
    const res = await request(app).get('/api/sessions/no-such-id/messages')
      .set('Cookie', member);
    expect(res.status).toBe(404);
  });
});
