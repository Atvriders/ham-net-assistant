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
  // Transition PREP → LIVE so check-ins are accepted by /sessions/:id/checkins.
  await request(app).post(`/api/sessions/${sessionId}/start`).set('Cookie', officer);
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

  it('PATCH that omits comment preserves existing comment', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KC0VIS', nameAtCheckIn: 'Visitor', comment: 'first time on the net' });
    expect(c.body.comment).toBe('first time on the net');
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KC0VIS', nameAtCheckIn: 'Visitor Updated' });
    expect(p.status).toBe(200);
    expect(p.body.nameAtCheckIn).toBe('Visitor Updated');
    expect(p.body.comment).toBe('first time on the net');
  });

  it('PATCH with explicit null comment clears the comment', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KC0VIS', nameAtCheckIn: 'Visitor', comment: 'to be cleared' });
    expect(c.body.comment).toBe('to be cleared');
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KC0VIS', nameAtCheckIn: 'Visitor', comment: null });
    expect(p.status).toBe(200);
    expect(p.body.comment).toBeNull();
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

  it("defaults mode to 'rf' when omitted on POST", async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    expect(c.status).toBe(201);
    expect(c.body.mode).toBe('rf');
  });

  it("POST with mode 'echolink' persists and round-trips", async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest', mode: 'echolink' });
    expect(c.status).toBe(201);
    expect(c.body.mode).toBe('echolink');
    // Round-trip via the session fetch — the inline checkIns list should
    // surface 'echolink' too (DB write actually happened, not just the create
    // payload echo).
    const s = await request(app).get(`/api/sessions/${sessionId}`).set('Cookie', officer);
    expect(s.status).toBe(200);
    const found = s.body.checkIns.find((x: { id: string }) => x.id === c.body.id);
    expect(found?.mode).toBe('echolink');
  });

  it('rejects invalid mode values on POST', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest', mode: 'irlp' });
    expect(c.status).toBe(400);
  });

  it("PATCH can update mode 'rf' -> 'echolink'", async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    expect(c.body.mode).toBe('rf');
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest', mode: 'echolink' });
    expect(p.status).toBe(200);
    expect(p.body.mode).toBe('echolink');
  });

  it('PATCH that omits mode preserves existing mode', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest', mode: 'echolink' });
    expect(c.body.mode).toBe('echolink');
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Renamed' });
    expect(p.status).toBe(200);
    expect(p.body.nameAtCheckIn).toBe('Renamed');
    expect(p.body.mode).toBe('echolink');
  });
});

// The 5-minute member window had no coverage past expiry: deleting the time
// clause from both handlers left the whole suite green, so nothing stopped a
// member from rewriting a finalized log.
describe('member edit window on check-ins', () => {
  /** Push a check-in's timestamp back so the 5-minute window has lapsed. */
  async function backdate(id: string, minutes: number): Promise<void> {
    await prisma.checkIn.update({
      where: { id },
      data: { checkedInAt: new Date(Date.now() - minutes * 60 * 1000) },
    });
  }

  async function memberCheckIn(): Promise<string> {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    expect(c.status).toBe(201);
    return c.body.id as string;
  }

  it('member cannot PATCH their own check-in after 5 minutes', async () => {
    const id = await memberCheckIn();
    await backdate(id, 6);
    const p = await request(app).patch(`/api/checkins/${id}`).set('Cookie', member)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Rewritten' });
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe('FORBIDDEN');
    const row = await prisma.checkIn.findUnique({ where: { id } });
    expect(row!.nameAtCheckIn).toBe('Bob');
  });

  it('member cannot DELETE their own check-in after 5 minutes', async () => {
    const id = await memberCheckIn();
    await backdate(id, 6);
    const d = await request(app).delete(`/api/checkins/${id}`).set('Cookie', member);
    expect(d.status).toBe(403);
    const row = await prisma.checkIn.findUnique({ where: { id } });
    expect(row!.deletedAt).toBeNull();
  });

  it('member can still edit inside the window (4 minutes in)', async () => {
    const id = await memberCheckIn();
    await backdate(id, 4);
    const p = await request(app).patch(`/api/checkins/${id}`).set('Cookie', member)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Robert' });
    expect(p.status).toBe(200);
    expect(p.body.nameAtCheckIn).toBe('Robert');
  });

  it('an officer can still PATCH and DELETE a long-expired check-in', async () => {
    const id = await memberCheckIn();
    await backdate(id, 60 * 24);
    const p = await request(app).patch(`/api/checkins/${id}`).set('Cookie', officer)
      .send({ callsign: 'KB0BOB', nameAtCheckIn: 'Corrected by officer' });
    expect(p.status).toBe(200);
    expect(p.body.nameAtCheckIn).toBe('Corrected by officer');
    const d = await request(app).delete(`/api/checkins/${id}`).set('Cookie', officer);
    expect(d.status).toBe(204);
  });
});

// A member who checks in during the last minutes of a net is still inside the
// 5-minute window after the control op ends it. Editing a closed log is an
// officer-only action, so the handlers reject it.
describe('check-ins on an ENDED session', () => {
  let endedCheckIn: string;

  beforeEach(async () => {
    // Own net + session so ending it doesn't disturb the shared fixture.
    const r = await request(app).post('/api/repeaters').set('Cookie', officer)
      .send({ name: `R-end-${Date.now()}`, frequency: 147.21, offsetKhz: 600, mode: 'FM' });
    const n = await request(app).post('/api/nets').set('Cookie', officer).send({
      name: `Ended Net ${Date.now()}`, repeaterId: r.body.id, dayOfWeek: 5,
      startLocal: '19:00', timezone: 'America/Chicago',
    });
    const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${s.body.id}/start`).set('Cookie', officer);
    const c = await request(app).post(`/api/sessions/${s.body.id}/checkins`)
      .set('Cookie', member).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    endedCheckIn = c.body.id;
    await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
  });

  it('member cannot PATCH their own check-in once the net has ended', async () => {
    const p = await request(app).patch(`/api/checkins/${endedCheckIn}`).set('Cookie', member)
      .send({ nameAtCheckIn: 'Rewritten after the fact' });
    expect(p.status).toBe(403);
    expect(p.body.error.message).toMatch(/ended/i);
    const row = await prisma.checkIn.findUnique({ where: { id: endedCheckIn } });
    expect(row!.nameAtCheckIn).toBe('Bob');
  });

  it('member cannot DELETE their own check-in once the net has ended', async () => {
    const d = await request(app).delete(`/api/checkins/${endedCheckIn}`).set('Cookie', member);
    expect(d.status).toBe(403);
    expect(d.body.error.message).toMatch(/ended/i);
  });

  it('an officer can still correct the log after the net has ended', async () => {
    const p = await request(app).patch(`/api/checkins/${endedCheckIn}`).set('Cookie', officer)
      .send({ nameAtCheckIn: 'Bob Smith' });
    expect(p.status).toBe(200);
    expect(p.body.nameAtCheckIn).toBe('Bob Smith');
  });
});

// PATCH used to demand a full body (callsign + nameAtCheckIn) while /nets and
// /users accepted true partials.
describe('PATCH /api/checkins/:id partial bodies', () => {
  it('accepts nameAtCheckIn alone and leaves the callsign', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer)
      .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest', comment: 'first timer' });
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ nameAtCheckIn: 'Guest Renamed' });
    expect(p.status).toBe(200);
    expect(p.body.callsign).toBe('KC0GST');
    expect(p.body.nameAtCheckIn).toBe('Guest Renamed');
    expect(p.body.comment).toBe('first timer');
    expect(p.body.mode).toBe('rf');
  });

  it('accepts mode alone', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ mode: 'echolink' });
    expect(p.status).toBe(200);
    expect(p.body.mode).toBe('echolink');
    expect(p.body.nameAtCheckIn).toBe('Guest');
  });

  it('accepts callsign alone and relinks userId', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0VIS', nameAtCheckIn: 'Visitor' });
    expect(c.body.userId).toBeNull();
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ callsign: 'KB0BOB' });
    expect(p.status).toBe(200);
    expect(p.body.callsign).toBe('KB0BOB');
    expect(p.body.userId).not.toBeNull();
    expect(p.body.nameAtCheckIn).toBe('Visitor');
  });

  it('a PATCH that leaves the callsign alone keeps the existing userId link', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    expect(c.body.userId).not.toBeNull();
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ nameAtCheckIn: 'Bob S' });
    expect(p.status).toBe(200);
    expect(p.body.userId).toBe(c.body.userId);
  });

  it('an empty body is a no-op, not a 400', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    const p = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({});
    expect(p.status).toBe(200);
    expect(p.body.callsign).toBe('KC0GST');
    expect(p.body.nameAtCheckIn).toBe('Guest');
  });

  it('still validates the fields that ARE supplied', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
    const bad = await request(app).patch(`/api/checkins/${c.body.id}`).set('Cookie', officer)
      .send({ nameAtCheckIn: '' });
    expect(bad.status).toBe(400);
    const badMode = await request(app).patch(`/api/checkins/${c.body.id}`)
      .set('Cookie', officer).send({ mode: 'irlp' });
    expect(badMode.status).toBe(400);
  });
});
