import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string;
let sessionId: string;

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
  const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer)
    .send({ topicTitle: 'Antennas 101' });
  sessionId = s.body.id;
  // Transition PREP → LIVE so check-ins are accepted.
  await request(app).post(`/api/sessions/${s.body.id}/start`).set('Cookie', officer);
  await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
    .send({ callsign: 'W1AW', nameAtCheckIn: 'Alice' });
  await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
    .send({ callsign: 'KC0GST', nameAtCheckIn: 'Guest' });
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('stats', () => {
  it('GET /api/stats/participation requires auth', async () => {
    const res = await request(app).get('/api/stats/participation');
    expect(res.status).toBe(401);
  });

  it('GET /api/stats/participation returns totals', async () => {
    const res = await request(app).get('/api/stats/participation').set('Cookie', officer);
    expect(res.status).toBe(200);
    expect(res.body.totalCheckIns).toBe(2);
    expect(res.body.totalSessions).toBe(1);
    expect(res.body.perNet).toHaveLength(1);
  });

  it('GET /api/stats/participation returns sessions array with per-session detail', async () => {
    const res = await request(app).get('/api/stats/participation').set('Cookie', officer);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions).toHaveLength(1);
    const [s] = res.body.sessions;
    expect(s.id).toBe(sessionId);
    expect(s.netName).toBe('Wed Net');
    expect(s.topic).toBe('Antennas 101');
    expect(s.controlOp).toBeTruthy();
    expect(s.controlOp.callsign).toBe('W1AW');
    expect(s.controlOp.name).toBe('Alice');
    expect(s.checkIns).toHaveLength(2);
    // chronological: W1AW came first
    expect(s.checkIns[0].callsign).toBe('W1AW');
    expect(s.checkIns[0].name).toBe('Alice');
    expect(s.checkIns[1].callsign).toBe('KC0GST');
    const t0 = new Date(s.checkIns[0].checkedInAt).getTime();
    const t1 = new Date(s.checkIns[1].checkedInAt).getTime();
    expect(t0).toBeLessThanOrEqual(t1);
  });

  it('session detail exposes ids needed for editing', async () => {
    const res = await request(app).get('/api/stats/participation').set('Cookie', officer);
    const [s] = res.body.sessions;
    // controlOpId + check-in ids let the Stats Edit modal pre-select and patch.
    expect(typeof s.controlOpId).toBe('string');
    expect('notes' in s).toBe(true);
    for (const ci of s.checkIns) {
      expect(typeof ci.id).toBe('string');
    }
  });

  it('GET /api/stats/participation 400 on malformed from', async () => {
    const res = await request(app)
      .get('/api/stats/participation?from=garbage')
      .set('Cookie', officer);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('GET /api/stats/export.csv streams CSV', async () => {
    const res = await request(app).get('/api/stats/export.csv').set('Cookie', officer);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/callsign/i);
    expect(res.text).toMatch(/W1AW/);
    expect(res.text).toMatch(/KC0GST/);
    expect(res.text).toMatch(/SESSION,Net,Started,Ended,Topic,Control,Check-ins/);
    expect(res.text).toMatch(/Antennas 101/);
    expect(res.text).toMatch(/W1AW - Alice/);
  });

  it("CSV export includes a 'mode' column with RF / ECHOLINK values", async () => {
    // Isolated net + session so we can mix RF and EchoLink check-ins without
    // disturbing the count assertions other tests in this suite rely on.
    const r3 = await request(app).post('/api/repeaters').set('Cookie', officer)
      .send({ name: 'R3', frequency: 147.12, offsetKhz: 600, mode: 'FM' });
    const n3 = await request(app).post('/api/nets').set('Cookie', officer).send({
      name: 'Mode Net', repeaterId: r3.body.id, dayOfWeek: 6,
      startLocal: '21:00', timezone: 'America/Chicago',
    });
    const s3 = await request(app).post(`/api/nets/${n3.body.id}/sessions`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${s3.body.id}/start`).set('Cookie', officer);
    await request(app).post(`/api/sessions/${s3.body.id}/checkins`).set('Cookie', officer)
      .send({ callsign: 'KE0RF1', nameAtCheckIn: 'OnAir' });
    await request(app).post(`/api/sessions/${s3.body.id}/checkins`).set('Cookie', officer)
      .send({ callsign: 'KE0VOIP', nameAtCheckIn: 'Remote', mode: 'echolink' });
    const res = await request(app).get('/api/stats/export.csv').set('Cookie', officer);
    expect(res.status).toBe(200);
    // Header row now advertises the column.
    expect(res.text).toMatch(/^checkedInAt,netName,callsign,name,mode,comment/m);
    // Mode values are uppercased ('RF' / 'ECHOLINK') for the FCC log.
    const ecLine = res.text
      .split('\n')
      .find((l) => l.includes('KE0VOIP'));
    expect(ecLine).toBeDefined();
    expect(ecLine!).toMatch(/,ECHOLINK,/);
    const rfLine = res.text
      .split('\n')
      .find((l) => l.includes('KE0RF1'));
    expect(rfLine).toBeDefined();
    expect(rfLine!).toMatch(/,RF,/);
    // Per-session aggregate line tags EchoLink rows in the readable summary.
    expect(res.text).toMatch(/KE0VOIP - Remote \(EchoLink\)/);
  });

  it("participation feed exposes 'mode' on each check-in", async () => {
    const res = await request(app).get('/api/stats/participation').set('Cookie', officer);
    expect(res.status).toBe(200);
    for (const s of res.body.sessions) {
      for (const ci of s.checkIns) {
        expect(['rf', 'echolink']).toContain(ci.mode);
      }
    }
  });

  it('GET /api/stats/export.pdf returns PDF bytes', async () => {
    const res = await request(app)
      .get('/api/stats/export.pdf')
      .set('Cookie', officer)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).slice(0, 5).toString()).toBe('%PDF-');
  });

  it('topic + control corrections on an ended session show up in stats', async () => {
    // Isolated net/session so the mutation does not disturb other tests.
    const r2 = await request(app).post('/api/repeaters').set('Cookie', officer)
      .send({ name: 'R2', frequency: 147.0, offsetKhz: 600, mode: 'FM' });
    const n2 = await request(app).post('/api/nets').set('Cookie', officer).send({
      name: 'Edit Net', repeaterId: r2.body.id, dayOfWeek: 5,
      startLocal: '19:00', timezone: 'America/Chicago',
    });
    const s2 = await request(app).post(`/api/nets/${n2.body.id}/sessions`).set('Cookie', officer)
      .send({ topicTitle: 'Original topic' });
    // End the session, then correct its topic + control + notes (a past-log fix).
    await request(app).patch(`/api/sessions/${s2.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString() });
    const w1aw = await prisma.user.findFirst({ where: { callsign: 'W1AW' } });
    const patch = await request(app).patch(`/api/sessions/${s2.body.id}`).set('Cookie', officer)
      .send({ topicTitle: 'Corrected topic', controlOpId: w1aw!.id, notes: 'fixed log' });
    expect(patch.status).toBe(200);
    const res = await request(app).get('/api/stats/participation').set('Cookie', officer);
    const found = res.body.sessions.find((x: { id: string }) => x.id === s2.body.id);
    expect(found.topic).toBe('Corrected topic');
    expect(found.controlOpId).toBe(w1aw!.id);
    expect(found.notes).toBe('fixed log');
  });
});
