import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
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

/**
 * The local FCC ULS mirror is consulted before callook.info. Everything above
 * this point runs against an empty mirror, which is itself the "club that has
 * never imported" case: every one of those tests still reaches callook.
 */
describe('GET /api/callsign-lookup/:callsign — local ULS mirror', () => {
  beforeEach(async () => {
    await prisma.ulsLicense.deleteMany();
  });

  async function seed(over: Partial<{
    callsign: string;
    usi: number;
    name: string | null;
    operatorClass: string | null;
    status: string | null;
    city: string | null;
    state: string | null;
    statusGeneration: number | null;
  }> = {}) {
    await prisma.ulsLicense.create({
      data: {
        callsign: 'W1AAA',
        usi: 4000001,
        name: 'Alice Anderson',
        operatorClass: 'EXTRA',
        status: 'A',
        city: 'BOSTON',
        state: 'MA',
        statusGeneration: 1,
        ...over,
      },
    });
  }

  it('answers from the mirror without touching the network', async () => {
    await seed();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app).get('/api/callsign-lookup/W1AAA');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      callsign: 'W1AAA',
      name: 'Alice Anderson',
      licenseClass: 'EXTRA',
      country: 'US',
      found: true,
      gridSquare: null,
      latitude: null,
      longitude: null,
      address: 'BOSTON, MA',
    });
    // The whole point: no outbound request during a net.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the exact response shape the SPA consumes', async () => {
    await seed();
    const local = await request(app).get('/api/callsign-lookup/W1AAA');
    mockCallook({ status: 'VALID', name: 'BOB BAKER', current: { operClass: 'GENERAL' } });
    const remote = await request(app).get('/api/callsign-lookup/W1ZZZ');
    expect(Object.keys(local.body).sort()).toEqual(Object.keys(remote.body).sort());
  });

  it('falls back to callook for a callsign the mirror does not hold', async () => {
    await seed();
    mockCallook({ status: 'VALID', name: 'BOB BAKER', current: { operClass: 'GENERAL' } });

    const res = await request(app).get('/api/callsign-lookup/W1ZZZ');

    expect(res.body.found).toBe(true);
    expect(res.body.name).toBe('Bob Baker');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  // An unpublished row is what an interrupted import leaves behind.
  it('ignores a row the import never confirmed active', async () => {
    await seed({ status: null, statusGeneration: null });
    mockCallook({ status: 'VALID', name: 'BOB BAKER', current: { operClass: 'GENERAL' } });

    const res = await request(app).get('/api/callsign-lookup/W1AAA');

    expect(res.body.name).toBe('Bob Baker');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('falls back when the mirror row has no name to give', async () => {
    await seed({ name: null });
    mockCallook({ status: 'VALID', name: 'BOB BAKER', current: { operClass: 'GENERAL' } });

    const res = await request(app).get('/api/callsign-lookup/W1AAA');
    expect(res.body.name).toBe('Bob Baker');
  });

  it('renders a club, which has a name but no operator class', async () => {
    await seed({ callsign: 'K1CLUB', name: 'Ham Club Of Somewhere', operatorClass: null });
    const res = await request(app).get('/api/callsign-lookup/K1CLUB');
    expect(res.body.name).toBe('Ham Club Of Somewhere');
    expect(res.body.licenseClass).toBeNull();
  });

  it('omits the address when the mirror has no city or state', async () => {
    await seed({ city: null, state: null });
    const res = await request(app).get('/api/callsign-lookup/W1AAA');
    expect(res.body.address).toBeNull();
  });

  /**
   * The FCC's bulk data carries no coordinates, so RepeatersPage's grid
   * autofill asks for them explicitly. Without the flag the hot path stays
   * offline; with it, the local identity is merged with callook's location.
   */
  it('merges callook location fields when ?location=1 is passed', async () => {
    await seed();
    mockCallook({
      status: 'VALID',
      name: 'SOMEONE ELSE',
      current: { operClass: 'GENERAL' },
      address: { line2: 'BOSTON, MA 02101' },
      location: { latitude: '42.3601', longitude: '-71.0589', gridsquare: 'FN42' },
    });

    const res = await request(app).get('/api/callsign-lookup/W1AAA?location=1');

    expect(res.body.gridSquare).toBe('FN42');
    expect(res.body.latitude).toBeCloseTo(42.3601, 3);
    expect(res.body.longitude).toBeCloseTo(-71.0589, 3);
    // Identity still comes from the authoritative local mirror.
    expect(res.body.name).toBe('Alice Anderson');
    expect(res.body.licenseClass).toBe('EXTRA');
    // The remote address line carries the ZIP, which the mirror does not store.
    expect(res.body.address).toBe('BOSTON, MA 02101');
  });

  it('still returns the local answer when ?location=1 and callook is down', async () => {
    await seed();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).get('/api/callsign-lookup/W1AAA?location=1');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice Anderson');
    expect(res.body.gridSquare).toBeNull();
  });

  it('does not consult callook without the flag, even though it has no grid', async () => {
    await seed();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await request(app).get('/api/callsign-lookup/W1AAA');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
