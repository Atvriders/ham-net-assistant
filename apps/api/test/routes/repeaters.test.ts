import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { __resetHearhamCacheForTests } from '../../src/routes/repeaters.js';

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
beforeEach(async () => {
  await prisma.repeater.deleteMany();
  __resetHearhamCacheForTests();
});
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

const hearhamOk = [
  // Manhattan, KS — near callook coords (39.18, -96.57)
  {
    id: 101,
    callsign: 'W0BPC',
    latitude: 39.183,
    longitude: -96.574,
    city: 'Manhattan, KS',
    mode: 'FM',
    encode: '88.5',
    decode: '88.5',
    frequency: 146940000,
    offset: -600000,
    operational: 1,
  },
  // Very near too
  {
    id: 102,
    callsign: 'K0KSU',
    latitude: 39.19,
    longitude: -96.58,
    city: 'Manhattan, KS',
    mode: 'FM',
    encode: '0',
    decode: '0',
    frequency: 443100000,
    offset: 5000000,
    operational: 1,
  },
  // Far away — should be filtered out by distance
  {
    id: 103,
    callsign: 'FARAWAY',
    latitude: 0,
    longitude: 0,
    city: 'Nowhere',
    mode: 'FM',
    encode: '0',
    decode: '0',
    frequency: 146520000,
    offset: 0,
    operational: 1,
  },
];

describe('GET /api/repeaters/suggestions', () => {
  it('returns mapped hearham results as primary source', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(callookOk))
      .mockResolvedValueOnce(jsonResponse(hearhamOk));
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Second call should be hearham, not repeaterbook
    const hearhamUrl = String(fetchSpy.mock.calls[1]?.[0] ?? '');
    expect(hearhamUrl).toContain('hearham.com/api/repeaters/v1');
    expect(res.body.source).toBe('hearham');
    expect(res.body.suggestions).toHaveLength(2); // far-away row dropped
    const first = res.body.suggestions[0];
    expect(first.frequency).toBe(146.94);
    expect(first.offsetKhz).toBe(-600);
    expect(first.toneHz).toBe(88.5);
    expect(first.mode).toBe('FM');
    expect(first.coverage).toBe('Manhattan, KS');
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

  it('returns empty list with reason=upstream-error when every source fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(callookOk))
      .mockRejectedValueOnce(new Error('hearham blew up'))
      .mockRejectedValueOnce(new Error('rb prox blew up'))
      .mockRejectedValueOnce(new Error('rb row blew up'))
      .mockRejectedValueOnce(new Error('rb state blew up'));
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.reason).toBe('upstream-error');
    expect(res.body.source).toBe('none');
    expect(res.body.attempted).toEqual([
      'hearham',
      'repeaterbook-prox',
      'repeaterbook-row',
      'repeaterbook-state',
    ]);
  });

  it('falls back to repeaterbook prox when hearham fails (e.g. 403)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(callookOk))
      // hearham 403 — unreachable
      .mockResolvedValueOnce(
        new Response('forbidden', { status: 403 }),
      )
      // rb prox ok
      .mockResolvedValueOnce(jsonResponse(repeaterbookOk));
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(res.body.source).toBe('repeaterbook-prox');
    expect(res.body.suggestions).toHaveLength(2);
    expect(res.body.attempted).toEqual(['hearham', 'repeaterbook-prox']);
  });

  it('falls back to repeaterbook state query when hearham + prox + row all fail', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(callookOk))
      .mockRejectedValueOnce(new Error('hearham down'))
      .mockRejectedValueOnce(new Error('prox down'))
      .mockRejectedValueOnce(new Error('row down'))
      .mockResolvedValueOnce(
        jsonResponse({
          count: 3,
          results: [
            {
              Frequency: '146.940',
              'Input Freq': '146.340',
              PL: '88.5',
              'Nearest City': 'Manhattan',
              County: 'Riley',
              State: 'Kansas',
              Callsign: 'W0BPC',
              Lat: '39.183',
              Long: '-96.574',
            },
            {
              Frequency: '147.000',
              'Input Freq': '147.600',
              PL: '100.0',
              'Nearest City': 'Wichita',
              County: 'Sedgwick',
              State: 'Kansas',
              Callsign: 'W0KAN',
              Lat: '37.6872',
              Long: '-97.3301',
            },
            {
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
        }),
      );
    const res = await request(app)
      .get('/api/repeaters/suggestions?callsign=W1AW')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const stateUrl = String(fetchSpy.mock.calls[4]?.[0] ?? '');
    expect(stateUrl).toContain('qtype=state');
    expect(stateUrl).toContain('state=Kansas');
    expect(res.body.source).toBe('repeaterbook-state');
    expect(res.body.suggestions).toHaveLength(3);
    // Should be sorted by haversine distance from callook coords (39.1836,-96.5717)
    expect(res.body.suggestions[0].name).toBe('W0BPC 146.94');
  });

  it('accepts lat/lon/dist variant and skips callook', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(hearhamOk));
    const res = await request(app)
      .get('/api/repeaters/suggestions?lat=39.18&lon=-96.57&dist=30')
      .set('Cookie', officerCookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain('hearham.com');
    expect(res.body.source).toBe('hearham');
    expect(res.body.suggestions).toHaveLength(2);
  });

  it('sends an explicit User-Agent on upstream requests', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(hearhamOk));
    await request(app)
      .get('/api/repeaters/suggestions?lat=39.18&lon=-96.57&dist=30')
      .set('Cookie', officerCookie);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['User-Agent']).toContain('HamNetAssistant');
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
