/**
 * The name replacement, attacked.
 *
 * ulsNameSync.test.ts covers the contract. This file covers the ways the
 * feature could quietly destroy a club's log instead of repairing it, each one
 * written first as a failing case:
 *
 *  - an FCC "name" that is blank or nothing but spaces, written over a real one;
 *  - `N0CALL`, this app's placeholder for "unlicensed member", taking the name
 *    of whoever the FCC says holds that call;
 *  - a write that dies half-way, leaving the log half rewritten and the path to
 *    the only snapshot unreported;
 *  - a control operator pressing START while the plan is being built.
 *
 * Plus the properties that have to hold at size: the snapshot really precedes
 * the first UPDATE, the preview's number really is the number that happens, and
 * six thousand rows go in bounded transactions that hand back the event loop.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { findUlsLicense, findUlsNames } from '../../src/lib/ulsLookup.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let admin: string;
let netId: string;
let backupDir: string;
let adminId: string;
let noCallAId: string;
let noCallBId: string;

const PREVIEW = '/api/admin/uls/name-sync/preview';
const RUN = '/api/admin/uls/name-sync';

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-adv-'));
  process.env.HNA_BACKUP_DIR = backupDir;

  const a = await request(app).post('/api/auth/register').send({
    email: 'adv-admin@x.co', password: 'hunter2hunter2', name: 'Ada', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  adminId = a.body.id;

  const u1 = await request(app).post('/api/auth/register').send({
    email: 'adv-nc1@x.co', password: 'hunter2hunter2', name: 'Unlicensed One', callsign: 'N0CALL',
  });
  noCallAId = u1.body.id;
  const u2 = await request(app).post('/api/auth/register').send({
    email: 'adv-nc2@x.co', password: 'hunter2hunter2', name: 'Unlicensed Two', callsign: 'N0CALL7',
  });
  noCallBId = u2.body.id;

  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R-adv', frequency: 147.0, offsetKhz: 600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Adv Net', repeaterId: r.body.id, dayOfWeek: 2,
    startLocal: '19:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});

afterAll(async () => {
  delete process.env.HNA_BACKUP_DIR;
  fs.rmSync(backupDir, { recursive: true, force: true });
  await cleanupTestDb(prisma, dbFile);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.HNA_BACKUP_DIR = backupDir;
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
  await prisma.ulsLicense.deleteMany();
  await prisma.user.update({ where: { id: adminId }, data: { name: 'Ada' } });
  await prisma.user.update({ where: { id: noCallAId }, data: { name: 'Unlicensed One' } });
  await prisma.user.update({ where: { id: noCallBId }, data: { name: 'Unlicensed Two' } });
  for (const f of fs.readdirSync(backupDir)) fs.rmSync(path.join(backupDir, f), { force: true });
});

async function seedUls(
  rows: { callsign: string; name?: string | null; status?: string | null }[],
): Promise<void> {
  await prisma.ulsLicense.createMany({
    data: rows.map((r, i) => ({
      callsign: r.callsign,
      usi: 5000 + i,
      name: r.name === undefined ? `Name ${r.callsign}` : r.name,
      status: r.status === undefined ? 'A' : r.status,
      statusGeneration: 1,
    })),
  });
}

async function makeSession(): Promise<string> {
  const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', admin);
  return s.body.id as string;
}

async function planted(
  sessionId: string,
  rows: { callsign: string; name: string; count?: number }[],
): Promise<void> {
  const data = [];
  for (const row of rows) {
    for (let i = 0; i < (row.count ?? 1); i += 1) {
      data.push({ sessionId, callsign: row.callsign, nameAtCheckIn: row.name, checkedInAt: new Date() });
    }
  }
  await prisma.checkIn.createMany({ data });
}

function names(): Promise<{ callsign: string; nameAtCheckIn: string }[]> {
  return prisma.checkIn.findMany({
    where: { deletedAt: null },
    select: { callsign: true, nameAtCheckIn: true },
    orderBy: [{ callsign: 'asc' }, { nameAtCheckIn: 'asc' }],
  });
}

function run(body: unknown) {
  return request(app).post(RUN).set('Cookie', admin).send(body as object);
}

// ── 1. Can a name end up blank / whitespace? ────────────────────────────────
describe('ADVERSARIAL: blanking', () => {
  it('never writes an empty-string FCC name over a real one', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: '' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    const preview = await request(app).get(PREVIEW).set('Cookie', admin);
    expect(preview.body.checkIns).toMatchObject({ changing: 0, noUlsName: 1 });

    const res = await run({ confirm: 'REPLACE NAMES' });
    expect(res.status).toBe(200);
    expect(await names()).toEqual([{ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' }]);
  });

  it('never writes a whitespace-only FCC name over a real one', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: '   ' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    const preview = await request(app).get(PREVIEW).set('Cookie', admin);
    expect(preview.body.checkIns).toMatchObject({ changing: 0, noUlsName: 1 });

    const res = await run({ confirm: 'REPLACE NAMES' });
    expect(res.status).toBe(200);
    expect(await names()).toEqual([{ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' }]);
  });
});

// ── 2. The app's own placeholder callsign ───────────────────────────────────
describe('ADVERSARIAL: N0CALL placeholder', () => {
  it('does not put an FCC licensee name on N0CALL check-ins or accounts', async () => {
    // N0CALL is this app's shared sentinel for "unlicensed member" (auth.ts
    // folds N0CALL<n> into it and lets it repeat). If the FCC mirror ever
    // carries an active N0CALL licence, every unlicensed member and every
    // placeholder log row would take a stranger's name.
    await seedUls([{ callsign: 'N0CALL', name: 'Norman Zerocall' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'N0CALL', name: 'Visitor Vic', count: 4 }]);

    const res = await run({ confirm: 'REPLACE NAMES', includeUsers: true });

    expect(res.status).toBe(200);
    expect(await names()).toEqual([
      { callsign: 'N0CALL', nameAtCheckIn: 'Visitor Vic' },
      { callsign: 'N0CALL', nameAtCheckIn: 'Visitor Vic' },
      { callsign: 'N0CALL', nameAtCheckIn: 'Visitor Vic' },
      { callsign: 'N0CALL', nameAtCheckIn: 'Visitor Vic' },
    ]);
    expect((await prisma.user.findUnique({ where: { id: noCallAId } }))?.name)
      .toBe('Unlicensed One');
    expect((await prisma.user.findUnique({ where: { id: noCallBId } }))?.name)
      .toBe('Unlicensed Two');
  });

  it('reports N0CALL rows as skipped in the preview', async () => {
    await seedUls([{ callsign: 'N0CALL', name: 'Norman Zerocall' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'N0CALL', name: 'Visitor Vic', count: 2 }]);

    const res = await request(app).get(`${PREVIEW}?includeUsers=true`).set('Cookie', admin);
    expect(res.body.checkIns).toMatchObject({ scanned: 2, changing: 0, noUlsName: 2 });
    expect(res.body.users.changing).toBe(0);
  });
});

// ── 3. Failure part-way through the write ───────────────────────────────────
describe('ADVERSARIAL: a write that fails half-way', () => {
  it('takes the snapshot before the first write', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob', count: 3 }]);

    let filesAtFirstWrite: string[] = [];
    const real = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, '$transaction').mockImplementation(((arg: never) => {
      if (filesAtFirstWrite.length === 0) filesAtFirstWrite = fs.readdirSync(backupDir);
      return real(arg);
    }) as typeof prisma.$transaction);

    const res = await run({ confirm: 'REPLACE NAMES' });
    expect(res.status).toBe(200);
    // A pre-name-sync snapshot already existed when the first UPDATE ran.
    expect(filesAtFirstWrite.filter((f) => f.startsWith('pre-name-sync-'))).toHaveLength(1);
  });

  it('tells the admin where the snapshot is when the write dies part-way', async () => {
    const callsigns = Array.from({ length: 400 }, (_, i) => `W8A${String(i).padStart(3, '0')}`);
    await seedUls(callsigns.map((callsign) => ({ callsign })));
    const s = await makeSession();
    await planted(s, callsigns.map((callsign) => ({ callsign, name: 'Typed Wrong', count: 6 })));

    let calls = 0;
    const real = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, '$transaction').mockImplementation(((arg: never) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('database is locked'));
      return real(arg);
    }) as typeof prisma.$transaction);

    const res = await run({ confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(500);
    // The database is now half-rewritten; the ONLY undo is the snapshot file,
    // so its path has to survive into the response.
    expect(res.body.error.message).toMatch(/pre-name-sync-/);
    const snapshots = fs.readdirSync(backupDir).filter((f) => f.startsWith('pre-name-sync-'));
    expect(snapshots).toHaveLength(1);
  });
});

// ── 4. Guards ───────────────────────────────────────────────────────────────
describe('ADVERSARIAL: guards', () => {
  it('refuses a second concurrent run', async () => {
    const callsigns = Array.from({ length: 300 }, (_, i) => `W7A${String(i).padStart(3, '0')}`);
    await seedUls(callsigns.map((callsign) => ({ callsign })));
    const s = await makeSession();
    await planted(s, callsigns.map((callsign) => ({ callsign, name: 'Typed Wrong', count: 10 })));

    const [a, b] = await Promise.all([
      run({ confirm: 'REPLACE NAMES' }),
      run({ confirm: 'REPLACE NAMES' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.message).toMatch(/already running/i);
  });

  it('refuses when a net goes live while the plan is being built', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob', count: 3 }]);

    // The operator presses START one millisecond after the guard ran.
    const realGroupBy = prisma.checkIn.groupBy.bind(prisma.checkIn);
    vi.spyOn(prisma.checkIn, 'groupBy').mockImplementation((async (arg: never) => {
      await prisma.netSession.update({ where: { id: s }, data: { liveAt: new Date() } });
      return realGroupBy(arg);
    }) as typeof prisma.checkIn.groupBy);

    const res = await run({ confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(409);
    expect(await names()).toEqual([
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
    ]);
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });
});

// ── 5. Preview honesty + scale ──────────────────────────────────────────────
describe('ADVERSARIAL: preview honesty and scale', () => {
  it('preview.changing equals what apply writes, on a hostile corpus', async () => {
    await seedUls([
      { callsign: 'KB0BOB', name: 'Robert Bobson' },
      { callsign: 'W1AW', name: 'Hiram Percy Maxim' },
      { callsign: 'K9EMPTY', name: '' },
      { callsign: 'K9NULL', name: null },
      { callsign: 'K9EXP', name: 'Expired Ed', status: 'E' },
      { callsign: 'N0CALL', name: 'Norman Zerocall' },
    ]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob', count: 5 },
      { callsign: 'kb0bob', name: 'bob', count: 2 },
      { callsign: ' KB0BOB ', name: 'Bobby' },
      { callsign: 'KB0BOB/M', name: 'Bob Mobile', count: 3 },
      { callsign: 'VE3/KB0BOB', name: 'Bob Portable' },
      { callsign: 'W1AW', name: 'Hiram Percy Maxim', count: 2 },
      { callsign: 'K9EMPTY', name: 'Ed Empty' },
      { callsign: 'K9NULL', name: 'Nora Null' },
      { callsign: 'K9EXP', name: 'Ed Expired' },
      { callsign: 'N0CALL', name: 'Visitor Vic', count: 4 },
      { callsign: 'W1XYZ', name: 'Mystery Op' },
    ]);

    const preview = await request(app).get(`${PREVIEW}?includeUsers=true`).set('Cookie', admin);
    const before = await names();
    const res = await run({ confirm: 'REPLACE NAMES', includeUsers: true });

    expect(res.status).toBe(200);
    expect(res.body.checkInsUpdated).toBe(preview.body.checkIns.changing);
    expect(res.body.usersUpdated).toBe(preview.body.users.changing);
    expect(res.body.skippedNoUlsName)
      .toBe(preview.body.checkIns.noUlsName + preview.body.users.noUlsName);
    // Every row the preview did not promise to change is byte-identical.
    const after = await names();
    expect(after.length).toBe(before.length);
    const changedRows = after.filter((row, i) => row.nameAtCheckIn !== before[i]!.nameAtCheckIn);
    expect(changedRows.length).toBe(preview.body.checkIns.changing);
  });

  it('a large log is written in bounded transactions that yield the event loop', async () => {
    const callsigns = Array.from({ length: 1200 }, (_, i) => `W6A${String(i).padStart(4, '0')}`);
    await seedUls(callsigns.map((callsign) => ({ callsign })));
    const s = await makeSession();
    await planted(s, callsigns.map((callsign) => ({ callsign, name: 'Typed Wrong', count: 5 })));
    const rows = callsigns.length * 5; // 6,000

    const durations: number[] = [];
    const real = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (arg: never) => {
      const t0 = Date.now();
      try {
        return await real(arg);
      } finally {
        durations.push(Date.now() - t0);
      }
    }) as typeof prisma.$transaction);

    // Proof the loop is handed back: a 5 ms timer keeps ticking during the run.
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const res = await run({ confirm: 'REPLACE NAMES' });
    clearInterval(timer);

    expect(res.status).toBe(200);
    expect(res.body.checkInsUpdated).toBe(rows);
    expect(durations.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...durations)).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(2);
    expect(await prisma.checkIn.count({ where: { nameAtCheckIn: 'Typed Wrong' } })).toBe(0);
  });
});

// ── 6. One matching rule, two readers ───────────────────────────────────────
describe('ADVERSARIAL: the match', () => {
  it('the bulk reader answers exactly what the single lookup answers', async () => {
    await seedUls([
      { callsign: 'KB0BOB', name: 'Robert Bobson' },
      { callsign: 'K9BLANK', name: '' },
      { callsign: 'K9SPACE', name: '   ' },
      { callsign: 'K9NULL', name: null },
      { callsign: 'K9EXP', name: 'Expired Ed', status: 'E' },
      { callsign: 'K9PEND', name: 'Pending Pat', status: null },
      { callsign: 'K9PAD', name: '  Padded Pete  ' },
    ]);
    const probes = [
      'KB0BOB', 'kb0bob', '  KB0BOB  ', 'KB0BOB/M', 'VE3/KB0BOB',
      'K9BLANK', 'K9SPACE', 'K9NULL', 'K9EXP', 'K9PEND', 'K9PAD',
      'W1XYZ', '',
    ];

    const bulk = await findUlsNames(prisma, probes);
    for (const probe of probes) {
      const single = await findUlsLicense(prisma, probe);
      const fromBulk = bulk.get(probe.trim().toUpperCase()) ?? null;
      expect([probe, fromBulk]).toEqual([probe, single?.name ?? null]);
    }
    // And specifically: no blank ever escapes either reader.
    for (const value of bulk.values()) expect(value.trim()).not.toBe('');
  });

  it('cannot hold a previous holder as a second row for the same callsign', async () => {
    // 9.2% of active callsigns also carry an expired licence for a previous
    // holder. UlsLicense.callsign is the PRIMARY KEY and the importer resolves
    // the winner on `usi`, so "which of the two rows did the bulk reader pick?"
    // is not a question this table can be asked.
    await seedUls([{ callsign: 'W1REUSE', name: 'Alice Active' }]);
    await expect(
      prisma.ulsLicense.create({
        data: { callsign: 'W1REUSE', usi: 1, name: 'Percy Previous', status: 'A', statusGeneration: 1 },
      }),
    ).rejects.toThrow();

    const s = await makeSession();
    await planted(s, [{ callsign: 'W1REUSE', name: 'Typed Wrong' }]);
    const res = await run({ confirm: 'REPLACE NAMES' });
    expect(res.status).toBe(200);
    expect(await names()).toEqual([{ callsign: 'W1REUSE', nameAtCheckIn: 'Alice Active' }]);
  });
});
