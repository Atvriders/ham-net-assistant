import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockCallook(body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('GET /api/callsign-lookup/:callsign', () => {
  it('returns prettified "First Last" for 2-word name', async () => {
    mockCallook({ status: 'VALID', name: 'JOHN SMITH', current: { operClass: 'Extra' } });
    const res = await request(app).get('/api/callsign-lookup/W1AW');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.callsign).toBe('W1AW');
    expect(res.body.name).toBe('John Smith');
    expect(res.body.licenseClass).toBe('Extra');
  });

  it('returns grid square, lat/lon, and address when present', async () => {
    mockCallook({
      status: 'VALID',
      name: 'JANE DOE',
      current: { operClass: 'Extra' },
      address: { line1: '123 Main St', line2: 'MANHATTAN, KS 66502' },
      location: { latitude: '39.1836', longitude: '-96.5717', gridsquare: 'EM19jd' },
    });
    const res = await request(app).get('/api/callsign-lookup/K0JAM');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.gridSquare).toBe('EM19jd');
    expect(res.body.latitude).toBeCloseTo(39.1836, 3);
    expect(res.body.longitude).toBeCloseTo(-96.5717, 3);
    expect(res.body.address).toBe('MANHATTAN, KS 66502');
  });

  it('location fields are null when callook has no location block', async () => {
    mockCallook({ status: 'UPDATING' });
    const res = await request(app).get('/api/callsign-lookup/W1AW');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.gridSquare).toBeNull();
    expect(res.body.latitude).toBeNull();
    expect(res.body.longitude).toBeNull();
    expect(res.body.address).toBeNull();
  });

  it('drops middle name from "FIRST MIDDLE LAST"', async () => {
    mockCallook({
      status: 'VALID',
      name: 'JOHN MICHAEL SMITH',
      current: { operClass: 'General' },
    });
    const res = await request(app).get('/api/callsign-lookup/K1ABC');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.name).toBe('John Smith');
  });

  // Compound last names like "van Buren" are a known limitation: callook
  // doesn't distinguish middle names from compound surname particles.
  it('4-word name collapses to first + last word (compound surname limitation)', async () => {
    mockCallook({
      status: 'VALID',
      name: 'MARY ELIZABETH VAN BUREN',
      current: { operClass: 'Technician' },
    });
    const res = await request(app).get('/api/callsign-lookup/K2XYZ');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Mary Buren');
  });

  it('1-word name returns title-cased single token', async () => {
    mockCallook({ status: 'VALID', name: 'MADONNA', current: { operClass: 'Extra' } });
    const res = await request(app).get('/api/callsign-lookup/N1POP');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Madonna');
  });

  it('returns found:false when callook status is not VALID', async () => {
    mockCallook({ status: 'UPDATING' });
    const res = await request(app).get('/api/callsign-lookup/W1AW');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.name).toBeNull();
  });

  it('rejects malformed callsign with 400', async () => {
    const res = await request(app).get('/api/callsign-lookup/X');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
