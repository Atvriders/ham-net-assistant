import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

// Cookies per role: the suggestion list is run-the-net data, so the role
// boundary (MEMBER out, NET_CONTROL in) is part of the contract under test.
let admin: string;
let netctl: string;
let member: string;
let netId: string;
let otherNetId: string;

/**
 * Register a user (everyone lands as MEMBER), promote to NET_CONTROL via the
 * ADMIN role route, then log in again — the cookie is minted at login, so the
 * pre-promotion one would still carry the old role. Mirrors netControlRole.test.ts.
 */
async function makeNetControl(email: string, callsign: string): Promise<string> {
  const password = 'hunter2hunter2';
  const reg = await request(app).post('/api/auth/register').send({
    email, password, name: 'Control Op', callsign,
  });
  const promote = await request(app)
    .patch(`/api/users/${reg.body.id}/role`)
    .set('Cookie', admin)
    .send({ role: 'NET_CONTROL' });
  expect(promote.status).toBe(200);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  return login.headers['set-cookie'][0];
}

function makeSession(forNetId: string, startedAt: Date, deletedAt: Date | null = null) {
  return prisma.netSession.create({ data: { netId: forNetId, startedAt, deletedAt } });
}

function addCheckIn(
  sessionId: string,
  callsign: string,
  name: string,
  when: Date,
  deletedAt: Date | null = null,
) {
  return prisma.checkIn.create({
    data: { sessionId, callsign, nameAtCheckIn: name, checkedInAt: when, deletedAt },
  });
}

const at = (day: number, hour: number) => new Date(Date.UTC(2026, 3, day, hour, 0, 0));

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First registered user is ADMIN, which outranks OFFICER for the setup writes.
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'member@x.co', password: 'hunter2hunter2', name: 'Member', callsign: 'K9XYZ',
  });
  member = m.headers['set-cookie'][0];
  netctl = await makeNetControl('netctl@x.co', 'N0CTL');

  const r = await request(app).post('/api/repeaters').set('Cookie', admin).send({
    name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM',
  });
  const netBody = {
    repeaterId: r.body.id, dayOfWeek: 3, startLocal: '20:00', timezone: 'America/Chicago',
  };
  const n = await request(app).post('/api/nets').set('Cookie', admin)
    .send({ ...netBody, name: 'Wed Net' });
  netId = n.body.id;
  const other = await request(app).post('/api/nets').set('Cookie', admin)
    .send({ ...netBody, name: 'Thu Net', dayOfWeek: 4 });
  otherNetId = other.body.id;
});

afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});

const url = (id: string = netId) => `/api/nets/${id}/recent-checkins`;

describe('GET /api/nets/:netId/recent-checkins', () => {
  it('returns [] for a net nobody has checked into', async () => {
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('orders most-recently-checked-in first', async () => {
    const s = await makeSession(netId, at(1, 1));
    await addCheckIn(s.id, 'W1AAA', 'Alice', at(1, 1));
    await addCheckIn(s.id, 'W2BBB', 'Bob', at(1, 3));
    await addCheckIn(s.id, 'W3CCC', 'Carol', at(1, 2));
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { callsign: string }) => r.callsign)).toEqual([
      'W2BBB', 'W3CCC', 'W1AAA',
    ]);
    expect(res.body[0].lastCheckedInAt).toBe(at(1, 3).toISOString());
  });

  it('returns one row per callsign across many sessions, with a count', async () => {
    const s1 = await makeSession(netId, at(1, 1));
    const s2 = await makeSession(netId, at(8, 1));
    const s3 = await makeSession(netId, at(15, 1));
    await addCheckIn(s1.id, 'W1AAA', 'Alice', at(1, 1));
    await addCheckIn(s2.id, 'W1AAA', 'Alice', at(8, 1));
    await addCheckIn(s3.id, 'W1AAA', 'Alice', at(15, 1));
    await addCheckIn(s2.id, 'W2BBB', 'Bob', at(8, 2));
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      callsign: 'W1AAA', count: 3, lastCheckedInAt: at(15, 1).toISOString(),
    });
    expect(res.body[1]).toMatchObject({ callsign: 'W2BBB', count: 1 });
  });

  it('takes name from the LATEST check-in, not the first', async () => {
    const s1 = await makeSession(netId, at(1, 1));
    const s2 = await makeSession(netId, at(8, 1));
    await addCheckIn(s1.id, 'W1AAA', 'Alice Old', at(1, 1));
    await addCheckIn(s2.id, 'W1AAA', 'Alice New', at(8, 1));
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Alice New');
  });

  it('excludes soft-deleted check-ins, including for the name and count', async () => {
    const s = await makeSession(netId, at(1, 1));
    await addCheckIn(s.id, 'W1AAA', 'Alice Live', at(1, 1));
    // A struck check-in is a correction: it must not become the suggested
    // name just because it happens to be the most recent row.
    await addCheckIn(s.id, 'W1AAA', 'Alice Struck', at(1, 5), at(1, 6));
    await addCheckIn(s.id, 'W9ZZZ', 'Ghost', at(1, 4), at(1, 6));
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      callsign: 'W1AAA', name: 'Alice Live', count: 1,
      lastCheckedInAt: at(1, 1).toISOString(),
    });
  });

  it('excludes check-ins belonging to soft-deleted sessions', async () => {
    const live = await makeSession(netId, at(1, 1));
    const trashed = await makeSession(netId, at(8, 1), at(9, 1));
    await addCheckIn(live.id, 'W1AAA', 'Alice', at(1, 1));
    await addCheckIn(trashed.id, 'W1AAA', 'Alice Trashed', at(8, 1));
    await addCheckIn(trashed.id, 'W9ZZZ', 'Ghost', at(8, 2));
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ callsign: 'W1AAA', name: 'Alice', count: 1 });
  });

  it('only counts check-ins from THIS net', async () => {
    const mine = await makeSession(netId, at(1, 1));
    const theirs = await makeSession(otherNetId, at(1, 2));
    await addCheckIn(mine.id, 'W1AAA', 'Alice', at(1, 1));
    await addCheckIn(theirs.id, 'W1AAA', 'Alice Elsewhere', at(1, 9));
    await addCheckIn(theirs.id, 'W8OTH', 'Other', at(1, 9));
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ callsign: 'W1AAA', name: 'Alice', count: 1 });
  });

  it('honors limit, keeping the most recent callsigns', async () => {
    const s = await makeSession(netId, at(1, 1));
    for (let i = 0; i < 5; i += 1) {
      await addCheckIn(s.id, `W${i}AAA`, `Op ${i}`, at(1, i + 1));
    }
    const res = await request(app).get(`${url()}?limit=2`).set('Cookie', netctl);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { callsign: string }) => r.callsign)).toEqual(['W4AAA', 'W3AAA']);
  });

  it('defaults to 12 suggestions when limit is omitted', async () => {
    const s = await makeSession(netId, at(1, 1));
    for (let i = 0; i < 15; i += 1) {
      await addCheckIn(s.id, `W${i}AAA`, `Op ${i}`, at(1, (i % 20) + 1));
    }
    const res = await request(app).get(url()).set('Cookie', netctl);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(12);
  });

  it.each(['0', '31', '-3', 'lots', '2.5', ''])('rejects limit=%s with 400', async (limit) => {
    const res = await request(app).get(`${url()}?limit=${limit}`).set('Cookie', netctl);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('accepts the boundary limits 1 and 30', async () => {
    const s = await makeSession(netId, at(1, 1));
    await addCheckIn(s.id, 'W1AAA', 'Alice', at(1, 1));
    await addCheckIn(s.id, 'W2BBB', 'Bob', at(1, 2));
    const one = await request(app).get(`${url()}?limit=1`).set('Cookie', netctl);
    expect(one.status).toBe(200);
    expect(one.body).toHaveLength(1);
    const thirty = await request(app).get(`${url()}?limit=30`).set('Cookie', netctl);
    expect(thirty.status).toBe(200);
    expect(thirty.body).toHaveLength(2);
  });

  it('404s for a net that does not exist', async () => {
    const res = await request(app).get(url('no-such-net')).set('Cookie', netctl);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects MEMBER with 403 but serves NET_CONTROL', async () => {
    const s = await makeSession(netId, at(1, 1));
    await addCheckIn(s.id, 'W1AAA', 'Alice', at(1, 1));
    const denied = await request(app).get(url()).set('Cookie', member);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const allowed = await request(app).get(url()).set('Cookie', netctl);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toHaveLength(1);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(401);
  });
});
