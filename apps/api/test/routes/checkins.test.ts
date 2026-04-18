import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let member: string; let sessionId: string;

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
beforeEach(async () => { await prisma.checkIn.deleteMany(); });

describe('check-ins', () => {
  it('auth required', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    expect(res.status).toBe(401);
  });

  it('member can check in (self)', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'kb0bob', nameAtCheckIn: 'Bob' });
    expect(res.status).toBe(201);
    expect(res.body.callsign).toBe('KB0BOB');
    expect(res.body.userId).not.toBeNull();
  });

  it('officer can check in a visitor (no user match)', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBeNull();
  });

  it('officer can delete any check-in', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    const d = await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', officer);
    expect(d.status).toBe(204);
  });

  it('member can delete own check-in within 5 min', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    const d = await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', member);
    expect(d.status).toBe(204);
  });

  it('returns most recent nameAtCheckIn for a callsign via history endpoint', async () => {
    await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0VIS', nameAtCheckIn: 'Alice' });
    const res = await request(app)
      .get('/api/checkins/callsign-history/KC0VIS')
      .set('Cookie', member);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ callsign: 'KC0VIS', name: 'Alice' });
  });

  it('returns null name for never-seen callsign', async () => {
    const res = await request(app)
      .get('/api/checkins/callsign-history/KC9ZZZ')
      .set('Cookie', officer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ callsign: 'KC9ZZZ', name: null });
  });

  it('callsign-history endpoint requires auth', async () => {
    const res = await request(app).get('/api/checkins/callsign-history/W1AW');
    expect(res.status).toBe(401);
  });

  it('member can delete visitor check-in they created within 5 min', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    expect(c.status).toBe(201);
    expect(c.body.userId).toBeNull();
    const d = await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', member);
    expect(d.status).toBe(204);
  });

  it('officer can PATCH a check-in to update fields', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KC0NEW', nameAtCheckIn: 'Updated' });
    expect(p.status).toBe(200);
    expect(p.body.callsign).toBe('KC0NEW');
    expect(p.body.nameAtCheckIn).toBe('Updated');
  });

  it('member can PATCH own check-in within 5 min', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', member)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Robert' });
    expect(p.status).toBe(200);
    expect(p.body.nameAtCheckIn).toBe('Robert');
  });

  it("member cannot PATCH someone else's check-in", async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', member)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'Hacker' });
    expect(p.status).toBe(403);
  });

  it('PATCH unknown id returns 404', async () => {
    const p = await request(app).patch('/api/checkins/does-not-exist').set('Cookie', officer)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    expect(p.status).toBe(404);
  });

  it('PATCH with matching member callsign relinks userId', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0VIS', nameAtCheckIn: 'Visitor' });
    expect(c.body.userId).toBeNull();
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    expect(p.status).toBe(200);
    expect(p.body.userId).not.toBeNull();
  });

  it('PATCH with non-member callsign clears userId', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    expect(c.body.userId).not.toBeNull();
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KC0ZZZ', nameAtCheckIn: 'Stranger' });
    expect(p.status).toBe(200);
    expect(p.body.userId).toBeNull();
  });
});
