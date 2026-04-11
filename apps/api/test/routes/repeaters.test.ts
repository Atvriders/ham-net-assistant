import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officerCookie: string; let memberCookie: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // first user = ADMIN (passes OFFICER checks), second = MEMBER
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officerCookie = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'M', callsign: 'KB0BOB',
  });
  memberCookie = m.headers['set-cookie'][0];
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => { await prisma.repeater.deleteMany(); });
afterEach(() => { vi.restoreAllMocks(); });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const callookOk = {
  status: 'VALID',
  name: 'JANE DOE',
  current: { operClass: 'Extra' },
  address: { line1: '1 Main', line2: 'MANHATTAN, KS 66502' },
  location: { latitude: '39.1836', longitude: '-96.5717', gridsquare: 'EM19jd' },
};

const repeaterbookOk = {
  count: 2,
  results: [
    {
      'State ID': '20',
      'Rptr ID': '1',
      Frequency: '146.940',
      'Input Freq': '146.340',
      PL: '88.5',
      'Nearest City': 'Manhattan',
      County: 'Riley',
      State: 'Kansas',
      Callsign: 'W0BPC',
      Lat: '39.183055',
      Long: '-96.574722',
    },
    {
      'State ID': '20',
      'Rptr ID': '2',
      Frequency: '443.100',
      'Input Freq': '448.100',
      PL: '',
      'Nearest City': 'Wamego',
      County: 'Pottawatomie',
      State: 'Kansas',
      Callsign: 'K0WAM',
      Lat: '39.2',
      Long: '-96.3',
    },
  ],
};

const valid = {
  name: 'KSU Main', frequency: 146.76, offsetKhz: -600,
  toneHz: 91.5, mode: 'FM', coverage: 'Manhattan, KS',
};

describe('GET /api/repeaters (public)', () => {
  it('lists repeaters without auth', async () => {
    await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    const res = await request(app).get('/api/repeaters');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].frequency).toBe(146.76);
  });
});

describe('POST /api/repeaters', () => {
  it('rejects unauthenticated', async () => {
    const res = await request(app).post('/api/repeaters').send(valid);
    expect(res.status).toBe(401);
  });
  it('rejects MEMBER', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', memberCookie).send(valid);
    expect(res.status).toBe(403);
  });
  it('creates as OFFICER+', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('KSU Main');
  });
  it('validates input', async () => {
    const res = await request(app)
      .post('/api/repeaters').set('Cookie', officerCookie)
      .send({ ...valid, frequency: -1 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH/DELETE /api/repeaters/:id', () => {
  it('updates and deletes as officer', async () => {
    const c = await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    const id = c.body.id;
    const u = await request(app)
      .patch(`/api/repeaters/${id}`).set('Cookie', officerCookie)
      .send({ ...valid, name: 'KSU Renamed' });
    expect(u.status).toBe(200);
    expect(u.body.name).toBe('KSU Renamed');
    const d = await request(app).delete(`/api/repeaters/${id}`).set('Cookie', officerCookie);
    expect(d.status).toBe(204);
    const g = await request(app).get('/api/repeaters');
    expect(g.body).toHaveLength(0);
  });
  it('404s unknown id', async () => {
    const res = await request(app)
      .patch('/api/repeaters/nope').set('Cookie', officerCookie).send(valid);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/repeaters/suggestions', () => {
  it('returns mapped repeaterbook results as suggestions', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(callookOk))
      .mockResolvedValueOnce(jsonResponse(repeaterbookOk));
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.body.suggestions).toHaveLength(2);
    const first = res.body.suggestions[0];
    expect(first.frequency).toBe(146.94);
    expect(first.offsetKhz).toBe(-600);
    expect(first.toneHz).toBe(88.5);
    expect(first.mode).toBe('FM');
    expect(first.coverage).toBe('Manhattan, Riley, Kansas');
    expect(first.name).toBe('W0BPC 146.94');
    expect(first.latitude).toBeCloseTo(39.183, 2);
    const second = res.body.suggestions[1];
    expect(second.frequency).toBe(443.1);
    expect(second.offsetKhz).toBe(5000);
    expect(second.toneHz).toBeNull();
  });

  it('returns empty list with reason=no-location when callook has no coords', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ status: 'UPDATING' }),
    );
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.reason).toBe('no-location');
  });

  it('returns empty list with reason=upstream-error when repeaterbook throws', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(callookOk))
      .mockRejectedValueOnce(new Error('network blew up'));
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.reason).toBe('upstream-error');
  });

  it('accepts lat/lon/dist variant and skips callook', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(repeaterbookOk));
    const res = await request(app)
      .get('/api/repeaters/suggestions?lat=39.18&lon=-96.57&dist=30')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain('repeaterbook.com');
    expect(calledUrl).toContain('lat=39.18');
    expect(calledUrl).toContain('long=-96.57');
    expect(calledUrl).toContain('dist=30');
    expect(res.body.suggestions).toHaveLength(2);
  });

  it('rejects invalid lat/lon query with 400', async () => {
    const res = await request(app)
      .get('/api/repeaters/suggestions?lat=999&lon=-96.57')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(400);
  });

  it('rejects MEMBER role with 403', async () => {
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', memberCookie);
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated with 401', async () => {
    const res = await request(app).get('/api/repeaters/suggestions?callsign=W1AW');
    expect(res.status).toBe(401);
  });
});
