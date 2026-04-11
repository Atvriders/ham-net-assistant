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

describe('GET /api/callsign-lookup/:callsign', () => {
  it('returns prettified name for valid callook response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'VALID',
          name: 'DOE JOHN',
          current: { operClass: 'Extra' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await request(app).get('/api/callsign-lookup/W1AW');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.callsign).toBe('W1AW');
    expect(res.body.name).toBe('John Doe');
    expect(res.body.licenseClass).toBe('Extra');
  });

  it('drops middle names, outputs only First Last', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'VALID',
          name: 'SMITH JOHN MICHAEL',
          current: { operClass: 'General' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await request(app).get('/api/callsign-lookup/K1ABC');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.name).toBe('John Smith');
  });

  it('rejects malformed callsign with 400', async () => {
    const res = await request(app).get('/api/callsign-lookup/X');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
