import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { NAME_SYNC_BATCH_ROWS } from '../../src/lib/ulsNameSync.js';

/**
 * ADMIN "replace every stored name with the FCC name".
 *
 * The feature is a bulk rewrite of the club's FCC-facing log, so most of what
 * is tested here is the refusals: an empty mirror, a live net, a missing
 * confirmation phrase, a callsign the FCC has no name for, and a snapshot that
 * could not be written. Each one is a way the club could otherwise lose a log
 * it cannot get back.
 *
 * Nothing here touches the network: the mirror is seeded straight into the
 * UlsLicense table, which is the same thing a completed import leaves behind.
 */

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let admin: string;
let officer: string;
let member: string;
let adminId: string;
let officerId: string;
let memberId: string;
let netId: string;
let backupDir: string;

const PREVIEW = '/api/admin/uls/name-sync/preview';
const RUN = '/api/admin/uls/name-sync';

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());

  // Snapshots must not land next to the test database (apps/api/backups) and
  // must not survive the run.
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-namesync-'));
  process.env.HNA_BACKUP_DIR = backupDir;

  // The first account ever created becomes ADMIN.
  const a = await request(app).post('/api/auth/register').send({
    email: 'ns-admin@x.co', password: 'hunter2hunter2', name: 'Ada', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  adminId = a.body.id;

  const o = await request(app).post('/api/auth/register').send({
    email: 'ns-officer@x.co', password: 'hunter2hunter2', name: 'Olly', callsign: 'K1OFF',
  });
  officer = o.headers['set-cookie'][0];
  officerId = o.body.id;
  await prisma.user.update({ where: { id: officerId }, data: { role: 'OFFICER' } });

  const m = await request(app).post('/api/auth/register').send({
    email: 'ns-member@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  memberId = m.body.id;

  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R-ns', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Name Sync Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
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
  // Account names are rewritten by the includeUsers half; put them back so each
  // case starts from the same place.
  await prisma.user.update({ where: { id: adminId }, data: { name: 'Ada' } });
  await prisma.user.update({ where: { id: officerId }, data: { name: 'Olly' } });
  await prisma.user.update({ where: { id: memberId }, data: { name: 'Bob' } });
  for (const f of fs.readdirSync(backupDir)) fs.rmSync(path.join(backupDir, f), { force: true });
});

/** Seed the mirror the way a completed import leaves it. */
async function seedUls(
  rows: { callsign: string; name?: string | null; status?: string | null }[],
): Promise<void> {
  await prisma.ulsLicense.createMany({
    data: rows.map((r, i) => ({
      callsign: r.callsign,
      usi: 1000 + i,
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
  rows: { callsign: string; name: string; count?: number; deleted?: boolean }[],
): Promise<void> {
  const data = [];
  for (const row of rows) {
    for (let i = 0; i < (row.count ?? 1); i += 1) {
      data.push({
        sessionId,
        callsign: row.callsign,
        nameAtCheckIn: row.name,
        checkedInAt: new Date(),
        deletedAt: row.deleted ? new Date() : null,
      });
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

function run(cookie: string, body: unknown) {
  return request(app).post(RUN).set('Cookie', cookie).send(body as object);
}

describe('name sync — role boundary', () => {
  it('rejects an anonymous caller', async () => {
    expect((await request(app).get(PREVIEW)).status).toBe(401);
    expect((await request(app).post(RUN).send({ confirm: 'REPLACE NAMES' })).status).toBe(401);
  });

  it('rejects a MEMBER with 403', async () => {
    expect((await request(app).get(PREVIEW).set('Cookie', member)).status).toBe(403);
    expect((await run(member, { confirm: 'REPLACE NAMES' })).status).toBe(403);
  });

  // MEMBER < NET_CONTROL < OFFICER < ADMIN. An officer runs the club's nets;
  // rewriting every name in the log is not part of running a net.
  it('rejects an OFFICER with 403', async () => {
    expect((await request(app).get(PREVIEW).set('Cookie', officer)).status).toBe(403);
    expect((await run(officer, { confirm: 'REPLACE NAMES' })).status).toBe(403);
  });

  it('allows an ADMIN to preview', async () => {
    expect((await request(app).get(PREVIEW).set('Cookie', admin)).status).toBe(200);
  });
});

describe('name sync — preview', () => {
  it('counts changing, unchanged and unanswerable rows separately', async () => {
    await seedUls([
      { callsign: 'KB0BOB', name: 'Robert Bobson' },
      { callsign: 'W1AW', name: 'Hiram Percy Maxim' },
    ]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob', count: 3 },
      { callsign: 'KB0BOB', name: 'Robert Bobson' },
      { callsign: 'W1XYZ', name: 'Mystery Op', count: 2 },
      // In the trash: not part of the log, so not in scope at all.
      { callsign: 'KB0BOB', name: 'Bobby', deleted: true },
    ]);

    const res = await request(app).get(PREVIEW).set('Cookie', admin);

    expect(res.status).toBe(200);
    expect(res.body.ulsRows).toBe(2);
    expect(res.body.checkIns).toMatchObject({
      scanned: 6,
      changing: 3,
      unchanged: 1,
      noUlsName: 2,
    });
    expect(res.body.checkIns.samples).toEqual([
      { callsign: 'KB0BOB', from: 'Bob', to: 'Robert Bobson', rows: 3 },
    ]);
  });

  it('leaves the users block empty unless includeUsers is asked for', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);

    const off = await request(app).get(PREVIEW).set('Cookie', admin);
    expect(off.body.users).toEqual({
      scanned: 0, changing: 0, unchanged: 0, noUlsName: 0, samples: [],
    });

    const on = await request(app).get(`${PREVIEW}?includeUsers=true`).set('Cookie', admin);
    expect(on.body.users).toMatchObject({ scanned: 3, changing: 1, unchanged: 0, noUlsName: 2 });
    expect(on.body.users.samples).toEqual([
      { callsign: 'KB0BOB', from: 'Bob', to: 'Robert Bobson' },
    ]);
  });

  it('answers with ulsRows 0 instead of an error when nothing has been imported', async () => {
    // The admin screen needs this number to explain why the button is disabled;
    // a 409 here would leave it with nothing to say.
    const res = await request(app).get(PREVIEW).set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.ulsRows).toBe(0);
  });

  it('caps the sample list at 25', async () => {
    await seedUls(Array.from({ length: 30 }, (_, i) => ({ callsign: `W9AB${i}` })));
    const s = await makeSession();
    await planted(
      s,
      Array.from({ length: 30 }, (_, i) => ({ callsign: `W9AB${i}`, name: 'Typed Wrong' })),
    );

    const res = await request(app).get(PREVIEW).set('Cookie', admin);
    expect(res.body.checkIns.changing).toBe(30);
    expect(res.body.checkIns.samples).toHaveLength(25);
  });

  it('predicts exactly what the run then does', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }, { callsign: 'W1AW' }]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob', count: 4 },
      { callsign: 'W1AW', name: 'Ada', count: 2 },
      { callsign: 'W1XYZ', name: 'Mystery Op' },
    ]);

    const preview = await request(app).get(PREVIEW).set('Cookie', admin);
    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body.checkInsUpdated).toBe(preview.body.checkIns.changing);
    expect(res.body.skippedNoUlsName).toBe(preview.body.checkIns.noUlsName);
  });
});

describe('name sync — refusals', () => {
  it('refuses an empty mirror with 409 and says to load the ULS data', async () => {
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/load the ULS data first/i);
    // Nothing may have been touched, and no snapshot taken for a refused run.
    expect(await names()).toEqual([{ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' }]);
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });

  it('refuses while a net is live with 409', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);
    await prisma.netSession.update({ where: { id: s }, data: { liveAt: new Date() } });

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/live right now \(Name Sync Net\)/);
    expect(await names()).toEqual([{ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' }]);
  });

  it('ignores an ended or soft-deleted session when checking for a live net', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    // Created directly: the session API applies same-day dedupe, and this case
    // needs two sessions on the same net night.
    const ended = await prisma.netSession.create({
      data: { netId, startedAt: new Date(), liveAt: new Date(), endedAt: new Date() },
    });
    await prisma.netSession.create({
      data: { netId, startedAt: new Date(), liveAt: new Date(), deletedAt: new Date() },
    });
    await planted(ended.id, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    expect((await run(admin, { confirm: 'REPLACE NAMES' })).status).toBe(200);
  });

  it.each([
    ['a missing confirmation', {}],
    ['the wrong phrase', { confirm: 'replace names' }],
    ['a truthy non-phrase', { confirm: true }],
    ['a bad includeUsers', { confirm: 'REPLACE NAMES', includeUsers: 'yes' }],
  ])('refuses %s with 400', async (_label, body) => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    const res = await run(admin, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(await names()).toEqual([{ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' }]);
  });
});

describe('name sync — never blanks a name', () => {
  it('skips a callsign the mirror has never heard of', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob' },
      { callsign: 'W1XYZ', name: 'Mystery Op', count: 2 },
    ]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body).toMatchObject({ checkInsUpdated: 1, skippedNoUlsName: 2 });
    expect(await names()).toEqual([
      { callsign: 'KB0BOB', nameAtCheckIn: 'Robert Bobson' },
      { callsign: 'W1XYZ', nameAtCheckIn: 'Mystery Op' },
      { callsign: 'W1XYZ', nameAtCheckIn: 'Mystery Op' },
    ]);
  });

  it('skips a mirror row that is present but nameless, or not yet published', async () => {
    await seedUls([
      // Active licence the importer could not prove a name for.
      { callsign: 'KB0BOB', name: null },
      // Written by an EN pass that HD.dat never confirmed active.
      { callsign: 'K1OFF', name: 'Oliver Officer', status: null },
      // Licence is in the mirror but expired.
      { callsign: 'W1AW', name: 'Hiram Percy Maxim', status: 'E' },
    ]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob' },
      { callsign: 'K1OFF', name: 'Olly' },
      { callsign: 'W1AW', name: 'Ada' },
    ]);

    const res = await run(admin, { confirm: 'REPLACE NAMES', includeUsers: true });

    expect(res.body).toMatchObject({ checkInsUpdated: 0, usersUpdated: 0, skippedNoUlsName: 6 });
    expect(await names()).toEqual([
      { callsign: 'K1OFF', nameAtCheckIn: 'Olly' },
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
      { callsign: 'W1AW', nameAtCheckIn: 'Ada' },
    ]);
  });

  it('skips a portable-suffix callsign rather than guessing at the base call', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB/M', name: 'Bob Mobile' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body).toMatchObject({ checkInsUpdated: 0, skippedNoUlsName: 1 });
    expect(await names()).toEqual([{ callsign: 'KB0BOB/M', nameAtCheckIn: 'Bob Mobile' }]);
  });

  it('leaves the trash alone', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob' },
      { callsign: 'KB0BOB', name: 'Bobby', deleted: true },
    ]);

    await run(admin, { confirm: 'REPLACE NAMES' });

    const trashed = await prisma.checkIn.findFirst({ where: { deletedAt: { not: null } } });
    expect(trashed?.nameAtCheckIn).toBe('Bobby');
  });
});

describe('name sync — matching', () => {
  it('matches a stored callsign case-insensitively, the way every lookup does', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'kb0bob', name: 'Bob' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body.checkInsUpdated).toBe(1);
    // The stored callsign is left exactly as it was: this tool rewrites names.
    expect(await names()).toEqual([{ callsign: 'kb0bob', nameAtCheckIn: 'Robert Bobson' }]);
  });

  it('counts one callsign once however many rows it repairs', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }, { callsign: 'W1AW' }]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob', count: 3 },
      { callsign: 'KB0BOB', name: 'Bobby', count: 2 },
      { callsign: 'W1AW', name: 'Ada' },
    ]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body).toMatchObject({ checkInsUpdated: 6, callsignsAffected: 2 });
  });
});

describe('name sync — member accounts', () => {
  it('leaves User.name untouched unless includeUsers is set', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body).toMatchObject({ checkInsUpdated: 1, usersUpdated: 0 });
    expect((await prisma.user.findUnique({ where: { id: memberId } }))?.name).toBe('Bob');
  });

  it('rewrites User.name when it is asked for', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES', includeUsers: true });

    expect(res.body).toMatchObject({ usersUpdated: 1, callsignsAffected: 1 });
    expect((await prisma.user.findUnique({ where: { id: memberId } }))?.name).toBe('Robert Bobson');
    // The other two accounts are not in the mirror, so they keep their names.
    expect((await prisma.user.findUnique({ where: { id: adminId } }))?.name).toBe('Ada');
    expect((await prisma.user.findUnique({ where: { id: officerId } }))?.name).toBe('Olly');
  });
});

describe('name sync — the snapshot is the undo', () => {
  it('writes a pre-name-sync snapshot holding the names as they were', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(200);
    const snapshot: string = res.body.snapshot;
    expect(path.dirname(snapshot)).toBe(backupDir);
    // Its own prefix, so pre-migration retention can never prune it away.
    expect(path.basename(snapshot)).toMatch(/^pre-name-sync-\d{8}T\d{6}Z(_\d\d)?\.db$/);
    expect(fs.existsSync(snapshot)).toBe(true);

    const snap = new PrismaClient({ datasourceUrl: `file:${snapshot}` });
    try {
      const rows = await snap.checkIn.findMany({ select: { nameAtCheckIn: true } });
      expect(rows.map((r) => r.nameAtCheckIn)).toEqual(['Bob']);
    } finally {
      await snap.$disconnect();
    }
    // …while the live database has moved on.
    expect(await names()).toEqual([{ callsign: 'KB0BOB', nameAtCheckIn: 'Robert Bobson' }]);
  });

  it('aborts without writing anything when the snapshot cannot be taken', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Bob', count: 3 }]);

    // A regular file where the backup directory should be: mkdir fails exactly
    // as it would on a full or read-only volume.
    const blocked = path.join(backupDir, 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    process.env.HNA_BACKUP_DIR = blocked;

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/snapshot could not be taken/i);
    expect(res.body.error.message).toMatch(/nothing was changed/i);
    // The whole point: a failed snapshot leaves the log exactly as it was.
    expect(await names()).toEqual([
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
      { callsign: 'KB0BOB', nameAtCheckIn: 'Bob' },
    ]);
  });

  it('does not snapshot a run that has nothing to write', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);
    const s = await makeSession();
    await planted(s, [{ callsign: 'KB0BOB', name: 'Robert Bobson' }]);

    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.body).toMatchObject({ snapshot: null, checkInsUpdated: 0 });
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });
});

describe('name sync — idempotency and batching', () => {
  it('changes nothing on a second run', async () => {
    await seedUls([{ callsign: 'KB0BOB', name: 'Robert Bobson' }, { callsign: 'W1AW' }]);
    const s = await makeSession();
    await planted(s, [
      { callsign: 'KB0BOB', name: 'Bob', count: 3 },
      { callsign: 'W1AW', name: 'Ada' },
      { callsign: 'W1XYZ', name: 'Mystery Op' },
    ]);

    const first = await run(admin, { confirm: 'REPLACE NAMES', includeUsers: true });
    expect(first.body).toMatchObject({ checkInsUpdated: 4, usersUpdated: 2 });
    const after = await names();

    const second = await run(admin, { confirm: 'REPLACE NAMES', includeUsers: true });

    expect(second.body).toMatchObject({
      snapshot: null,
      checkInsUpdated: 0,
      usersUpdated: 0,
      callsignsAffected: 0,
      // Still reported every run: one check-in (W1XYZ) and one account (K1OFF)
      // that the mirror cannot answer for.
      skippedNoUlsName: 2,
    });
    expect(await names()).toEqual(after);
    // Only the first run needed an undo, so only the first run made a file.
    expect(fs.readdirSync(backupDir)).toHaveLength(1);
  });

  it('writes a log larger than one batch in several bounded transactions', async () => {
    const callsigns = Array.from({ length: 600 }, (_, i) => `W9A${String(i).padStart(3, '0')}`);
    await seedUls(callsigns.map((callsign) => ({ callsign })));
    const s = await makeSession();
    await planted(s, callsigns.map((callsign) => ({ callsign, name: 'Typed Wrong', count: 5 })));
    const rows = callsigns.length * 5;
    expect(rows).toBeGreaterThan(NAME_SYNC_BATCH_ROWS);

    const tx = vi.spyOn(prisma, '$transaction');
    const res = await run(admin, { confirm: 'REPLACE NAMES' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checkInsUpdated: rows, callsignsAffected: 600 });
    // Not one giant transaction: SQLite has a single writer and the club's app
    // has to stay answerable while this runs.
    expect(tx.mock.calls.length).toBeGreaterThan(1);
    for (const call of tx.mock.calls) {
      expect((call[0] as unknown[]).length).toBeLessThanOrEqual(250);
    }
    const remaining = await prisma.checkIn.count({ where: { nameAtCheckIn: 'Typed Wrong' } });
    expect(remaining).toBe(0);
  });
});
