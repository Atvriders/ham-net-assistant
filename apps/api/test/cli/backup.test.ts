import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import { snapshotDatabase, snapshotName, BACKUP_PREFIX } from '../../src/cli/backup.js';

// The entrypoint runs `prisma migrate deploy` unattended against the club's
// only copy of its net logs. These tests cover the pre-migration snapshot that
// makes that survivable: it must capture data still sitting in the WAL, must
// land next to the database (i.e. inside the mounted volume), must prune to a
// bounded number of copies, and must NEVER throw — a failed backup may not be
// able to stop the container from booting.

let prisma: PrismaClient;
let dbFile: string;
let backupDir: string;

// One migrated database for the whole file: `prisma migrate deploy` costs
// several seconds per call, and none of these cases need a pristine schema.
beforeAll(async () => {
  ({ prisma, dbFile } = makeTestDb());
  // Production runs in WAL mode; reproduce it so the snapshot is exercised
  // against the journal mode where a plain file copy would lose data.
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

beforeEach(() => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-backup-'));
});
afterEach(() => {
  fs.rmSync(backupDir, { recursive: true, force: true });
});

function opts(overrides: Partial<Parameters<typeof snapshotDatabase>[0]> = {}) {
  return {
    databaseUrl: `file:${dbFile}`,
    baseDir: process.cwd(),
    backupDir,
    log: () => {},
    ...overrides,
  };
}

describe('pre-migration snapshot', () => {
  it('writes a snapshot that contains rows still in the WAL', async () => {
    await prisma.setting.deleteMany();
    await prisma.setting.create({ data: { key: 'defaultThemeSlug', value: 'kstate' } });

    const result = await snapshotDatabase(opts());

    expect(result.status).toBe('created');
    expect(result.file).toBeDefined();
    expect(fs.existsSync(result.file!)).toBe(true);

    // Open the snapshot itself: proof the data survived, not just the file.
    const snap = new PrismaClient({ datasourceUrl: `file:${result.file}` });
    try {
      const rows = await snap.setting.findMany();
      expect(rows.map((r) => r.value)).toEqual(['kstate']);
    } finally {
      await snap.$disconnect();
    }
  });

  it('defaults the backup directory to a sibling of the database file', async () => {
    // WHY: /data/ham.db -> /data/backups keeps snapshots inside the mounted
    // volume. Anywhere else and they die with the container.
    const result = await snapshotDatabase(opts({ backupDir: undefined }));
    try {
      expect(result.status).toBe('created');
      expect(path.dirname(result.file!)).toBe(path.join(path.dirname(dbFile), 'backups'));
    } finally {
      fs.rmSync(path.join(path.dirname(dbFile), 'backups'), { recursive: true, force: true });
    }
  });

  it('skips (does not fail) when the database does not exist yet', async () => {
    const result = await snapshotDatabase(
      opts({ databaseUrl: `file:${path.join(backupDir, 'nope.db')}` }),
    );
    expect(result.status).toBe('skipped');
    expect(result.message).toMatch(/first boot/);
    // A "first boot" must not leave a phantom empty database behind.
    expect(fs.existsSync(path.join(backupDir, 'nope.db'))).toBe(false);
  });

  it('skips a non-file DATABASE_URL', async () => {
    const result = await snapshotDatabase(opts({ databaseUrl: 'postgres://localhost/hna' }));
    expect(result.status).toBe('skipped');
  });

  it('keeps only the newest N snapshots', async () => {
    for (let i = 0; i < 7; i += 1) {
      const now = new Date(Date.UTC(2026, 6, 26, 12, 0, i));
      const r = await snapshotDatabase(opts({ now, keep: 3 }));
      expect(r.status).toBe('created');
    }
    const kept = fs.readdirSync(backupDir).sort();
    expect(kept).toEqual([
      snapshotName(new Date(Date.UTC(2026, 6, 26, 12, 0, 4))),
      snapshotName(new Date(Date.UTC(2026, 6, 26, 12, 0, 5))),
      snapshotName(new Date(Date.UTC(2026, 6, 26, 12, 0, 6))),
    ]);
  });

  it('does not collide when two boots land in the same second', async () => {
    // A docker restart loop can re-run the entrypoint inside one second, and
    // SQLite refuses to VACUUM INTO an existing path.
    const now = new Date(Date.UTC(2026, 6, 26, 12, 0, 0));
    const first = await snapshotDatabase(opts({ now }));
    const second = await snapshotDatabase(opts({ now }));
    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    expect(second.file).not.toBe(first.file);
    expect(fs.readdirSync(backupDir).filter((f) => f.startsWith(BACKUP_PREFIX))).toHaveLength(2);
    // The collision suffix must sort AFTER the unsuffixed name, or retention
    // (a plain name sort) would prune the newer of the two.
    expect([...fs.readdirSync(backupDir)].sort()).toEqual([
      path.basename(first.file!),
      path.basename(second.file!),
    ]);
  });

  it('prunes the oldest copy when a second collides', async () => {
    const now = new Date(Date.UTC(2026, 6, 26, 12, 0, 0));
    const first = await snapshotDatabase(opts({ now, keep: 1 }));
    const second = await snapshotDatabase(opts({ now, keep: 1 }));
    expect(second.pruned).toEqual([first.file]);
    expect(fs.readdirSync(backupDir)).toEqual([path.basename(second.file!)]);
  });

  it('reports failure loudly instead of throwing, and leaves no partial file', async () => {
    // A regular file where the backup directory should be: mkdir fails the
    // same way a full or read-only volume would.
    const blocked = path.join(backupDir, 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    const lines: string[] = [];

    const result = await snapshotDatabase(opts({ backupDir: blocked, log: (l) => lines.push(l) }));

    expect(result.status).toBe('failed');
    expect(lines.join('\n')).toMatch(/SNAPSHOT FAILED/);
    expect(lines.join('\n')).toMatch(/has NOT been backed up/);
    expect(fs.statSync(blocked).isFile()).toBe(true);
  });

  it('names snapshots with a sortable UTC timestamp', () => {
    expect(snapshotName(new Date(Date.UTC(2026, 6, 26, 22, 40, 33)))).toBe(
      'pre-migrate-20260726T224033Z.db',
    );
  });
});
