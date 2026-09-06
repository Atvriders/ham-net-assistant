import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

/**
 * The real importer streams ~155 MB. It is replaced wholesale here so the route
 * tests exercise the HTTP surface — roles, conflict handling, the status
 * payload — and nothing in this file can reach the network.
 */
vi.mock('../../src/lib/ulsImport.js', async () => {
  const actual: object = await vi.importActual('../../src/lib/ulsImport.js');
  return {
    ...actual,
    runUlsImport: vi.fn().mockResolvedValue({
      runId: 'run-1',
      generation: 1,
      outcome: 'success',
      callsigns: 823_953,
      rowsRead: 4_200_000,
      malformedRows: 0,
      removedRows: 0,
      unnamedCallsigns: 0,
      bytesRead: 155_000_000,
      sourceFileDate: 'Sun Aug 30 09:07:53 EDT 2026',
      durationMs: 1000,
      error: null,
    }),
    isUlsImportRunning: vi.fn().mockReturnValue(false),
  };
});

import { isUlsImportRunning, runUlsImport } from '../../src/lib/ulsImport.js';

const runMock = runUlsImport as unknown as ReturnType<typeof vi.fn>;
const runningMock = isUlsImportRunning as unknown as ReturnType<typeof vi.fn>;

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let admin: string;
let officer: string;
let member: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // The first account ever created becomes ADMIN.
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@uls.test', password: 'hunter2hunter2', name: 'Ada', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];

  const o = await request(app).post('/api/auth/register').send({
    email: 'officer@uls.test', password: 'hunter2hunter2', name: 'Olly', callsign: 'K1OFF',
  });
  officer = o.headers['set-cookie'][0];
  await prisma.user.update({ where: { id: o.body.id }, data: { role: 'OFFICER' } });

  const m = await request(app).post('/api/auth/register').send({
    email: 'member@uls.test', password: 'hunter2hunter2', name: 'Mel', callsign: 'K1MEM',
  });
  member = m.headers['set-cookie'][0];
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
beforeEach(async () => {
  await prisma.ulsImportRun.deleteMany();
  await prisma.ulsLicense.deleteMany();
  runMock.mockClear();
  runningMock.mockReturnValue(false);
});

describe('GET /api/admin/uls — role boundary', () => {
  it('rejects an anonymous caller with 401', async () => {
    expect((await request(app).get('/api/admin/uls')).status).toBe(401);
  });

  it('rejects a MEMBER with 403', async () => {
    expect((await request(app).get('/api/admin/uls').set('Cookie', member)).status).toBe(403);
  });

  // The role ladder is MEMBER < NET_CONTROL < OFFICER < ADMIN, and this is an
  // ADMIN-only tool: an officer running a net must not be able to start a
  // 155 MB download.
  it('rejects an OFFICER with 403', async () => {
    expect((await request(app).get('/api/admin/uls').set('Cookie', officer)).status).toBe(403);
  });

  it('allows an ADMIN', async () => {
    expect((await request(app).get('/api/admin/uls').set('Cookie', admin)).status).toBe(200);
  });
});

describe('POST /api/admin/uls/import — role boundary', () => {
  it('rejects an anonymous caller with 401', async () => {
    expect((await request(app).post('/api/admin/uls/import')).status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects a MEMBER with 403', async () => {
    expect(
      (await request(app).post('/api/admin/uls/import').set('Cookie', member)).status,
    ).toBe(403);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects an OFFICER with 403', async () => {
    expect(
      (await request(app).post('/api/admin/uls/import').set('Cookie', officer)).status,
    ).toBe(403);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/uls/import', () => {
  it('accepts an ADMIN trigger and answers immediately', async () => {
    const res = await request(app).post('/api/admin/uls/import').set('Cookie', admin);
    // 202, not 200: an import takes minutes, so the work outlives the request.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][1]).toMatchObject({ trigger: 'manual' });
  });

  it('refuses a second trigger while one is already running', async () => {
    runningMock.mockReturnValue(true);
    const res = await request(app).post('/api/admin/uls/import').set('Cookie', admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/uls — status', () => {
  it('reports the configuration a club needs to see', async () => {
    const res = await request(app).get('/api/admin/uls').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      sourceUrl: 'https://data.fcc.gov/download/pub/uls/complete/l_amat.zip',
      dayOfWeek: 5, // Friday
      hour: 3,
      running: false,
      tableRows: 0,
    });
  });

  it('reports no runs before the first import', async () => {
    const res = await request(app).get('/api/admin/uls').set('Cookie', admin);
    expect(res.body.lastRun).toBeNull();
    expect(res.body.lastSuccess).toBeNull();
    expect(res.body.recentRuns).toEqual([]);
  });

  it('surfaces the failure reason from the last run', async () => {
    await prisma.ulsImportRun.create({
      data: {
        generation: 3,
        startedAt: new Date('2026-09-04T03:00:00Z'),
        finishedAt: new Date('2026-09-04T03:04:00Z'),
        outcome: 'failed',
        trigger: 'schedule',
        sourceUrl: 'https://data.fcc.gov/download/pub/uls/complete/l_amat.zip',
        error: 'the archive ended part-way through — the download was truncated',
      },
    });

    const res = await request(app).get('/api/admin/uls').set('Cookie', admin);

    expect(res.body.lastRun).toMatchObject({
      generation: 3,
      outcome: 'failed',
      trigger: 'schedule',
      error: 'the archive ended part-way through — the download was truncated',
    });
    // This is what tells the club they are still being answered from older data.
    expect(res.body.lastSuccess).toBeNull();
  });

  it('keeps the last SUCCESS separate from the last run, so stale data is visible', async () => {
    await prisma.ulsImportRun.create({
      data: {
        generation: 1,
        startedAt: new Date('2026-08-28T03:00:00Z'),
        finishedAt: new Date('2026-08-28T03:06:00Z'),
        outcome: 'success',
        trigger: 'schedule',
        sourceUrl: 'https://data.fcc.gov/download/pub/uls/complete/l_amat.zip',
        sourceFileDate: 'Sun Aug 23 09:07:53 EDT 2026',
        callsigns: 823_100,
      },
    });
    await prisma.ulsImportRun.create({
      data: {
        generation: 2,
        startedAt: new Date('2026-09-04T03:00:00Z'),
        finishedAt: new Date('2026-09-04T03:01:00Z'),
        outcome: 'failed',
        trigger: 'schedule',
        sourceUrl: 'https://data.fcc.gov/download/pub/uls/complete/l_amat.zip',
        error: 'source responded 503 Service Unavailable',
      },
    });

    const res = await request(app).get('/api/admin/uls').set('Cookie', admin);

    expect(res.body.lastRun.generation).toBe(2);
    expect(res.body.lastRun.outcome).toBe('failed');
    expect(res.body.lastSuccess.generation).toBe(1);
    expect(res.body.lastSuccess.callsigns).toBe(823_100);
    expect(res.body.lastSuccess.sourceFileDate).toBe('Sun Aug 23 09:07:53 EDT 2026');
    expect(res.body.recentRuns).toHaveLength(2);
  });

  it('counts every row in the table, published or not', async () => {
    await prisma.ulsLicense.createMany({
      data: [
        { callsign: 'W1AAA', usi: 1, name: 'A A', status: 'A', statusGeneration: 1 },
        // Unpublished: written by an EN pass that HD never confirmed.
        { callsign: 'W1BBB', usi: 2, name: 'B B' },
      ],
    });
    const res = await request(app).get('/api/admin/uls').set('Cookie', admin);
    expect(res.body.tableRows).toBe(2);
  });
});
