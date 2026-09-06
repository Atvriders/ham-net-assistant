import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { resolveSqliteFile, prismaDirFrom, isDirectRun } from './sqlitePath.js';

/**
 * Pre-migration database snapshot.
 *
 * WHY: the container entrypoint runs `prisma migrate deploy` unattended on
 * every boot, against the club's ONLY copy of years of FCC-facing net logs,
 * living in a single named volume. A migration that goes wrong (or a
 * `pull_policy: always` picking up an image whose migrations the operator
 * never reviewed) has no undo — there is no snapshot and no rollback. This
 * takes one before the migration runs.
 *
 * The snapshot is `VACUUM INTO`, not `cp`: the database runs in WAL mode, so
 * copying ham.db alone can capture a torn file that is missing every committed
 * transaction still sitting in ham.db-wal. `VACUUM INTO` reads through the
 * SQLite connection and writes a consistent, fully-checkpointed database file.
 * It is also the only WAL-safe option available here — the runtime image
 * deliberately ships without the sqlite3 CLI, so this goes through the Prisma
 * client that the API already depends on.
 */

/** Snapshot filenames start with this so pruning can never eat a foreign file. */
export const BACKUP_PREFIX = 'pre-migrate-';

/**
 * Prefix for the snapshot the ULS name-sync admin action takes before it
 * rewrites every stored name.
 *
 * A SEPARATE prefix, not a shared one, because retention prunes within a
 * prefix family (see {@link pruneOldSnapshots}). Sharing `pre-migrate-` would
 * let five container restarts prune away the only copy of the log as it was
 * before an admin replaced every name in it — and that snapshot IS the undo
 * button for an action that has no other one.
 */
export const NAME_SYNC_PREFIX = 'pre-name-sync-';

/** How many snapshots to retain. Older ones are pruned after a successful run. */
export const DEFAULT_KEEP = 5;

export interface SnapshotOptions {
  /** Prisma-style URL, e.g. `file:/data/ham.db`. */
  databaseUrl: string;
  /** Directory that relative `file:` URLs resolve against (the schema dir). */
  baseDir: string;
  /** Defaults to `<dir of the db file>/backups` — see below. */
  backupDir?: string;
  /** Retention count; defaults to {@link DEFAULT_KEEP}. */
  keep?: number;
  /** Injectable clock so tests get deterministic filenames. */
  now?: Date;
  /** Line sink; defaults to stdout. */
  log?: (line: string) => void;
  /**
   * Filename prefix, which is also the retention family. Defaults to
   * {@link BACKUP_PREFIX}; the name-sync action passes
   * {@link NAME_SYNC_PREFIX}.
   */
  prefix?: string;
}

export interface SnapshotResult {
  /** `skipped` = nothing to back up (not an error). */
  status: 'created' | 'skipped' | 'failed';
  /** Absolute path of the snapshot that was written. */
  file?: string;
  /** Absolute paths removed by retention pruning. */
  pruned: string[];
  /** Human-readable reason for `skipped` / `failed`. */
  message?: string;
}

/** `pre-migrate-20260726T224033Z.db` — UTC, and lexically sortable by age. */
export function snapshotName(now: Date, prefix: string = BACKUP_PREFIX): string {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${prefix}${iso}.db`;
}

/**
 * SQLite refuses to `VACUUM INTO` a path that already exists, and two boots
 * inside the same second would otherwise collide (a docker restart loop does
 * exactly that). Suffix until the name is free.
 *
 * The suffix is `_NN`, zero-padded: `_` sorts after `.`, so `...Z_01.db`
 * lands after `...Z.db` and retention still prunes oldest-first off a plain
 * name sort. A `-NN` suffix would sort BEFORE the unsuffixed name and make
 * pruning delete the newer copy.
 */
function freeSnapshotPath(dir: string, now: Date, prefix: string): string {
  const base = snapshotName(now, prefix);
  let candidate = path.join(dir, base);
  for (let n = 1; fs.existsSync(candidate) && n < 100; n += 1) {
    candidate = path.join(dir, base.replace(/\.db$/, `_${String(n).padStart(2, '0')}.db`));
  }
  return candidate;
}

/**
 * Retention is per PREFIX. Each kind of snapshot keeps its own N: a run of
 * container restarts must not be able to prune the pre-name-sync copy, and a
 * burst of admin actions must not prune the pre-migration ones.
 */
function pruneOldSnapshots(dir: string, keep: number, prefix: string): string[] {
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    // Names embed a UTC timestamp, so lexicographic order IS chronological.
    .sort();
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  const removed: string[] = [];
  for (const name of doomed) {
    const full = path.join(dir, name);
    try {
      fs.rmSync(full, { force: true });
      removed.push(full);
    } catch {
      // A snapshot we failed to delete is only wasted disk, never a reason to
      // fail the boot that this backup is protecting.
    }
  }
  return removed;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Take a WAL-safe snapshot of the SQLite database, then prune old ones.
 * Never throws: callers run this on the boot path and a failed backup must not
 * be able to take the club's net offline.
 */
export async function snapshotDatabase(opts: SnapshotOptions): Promise<SnapshotResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const keep = opts.keep ?? DEFAULT_KEEP;
  const prefix = opts.prefix ?? BACKUP_PREFIX;

  const dbFile = resolveSqliteFile(opts.databaseUrl, opts.baseDir);
  if (!dbFile) {
    const message = `DATABASE_URL is not a sqlite file: URL — nothing to snapshot`;
    log(`[backup] ${message}`);
    return { status: 'skipped', pruned: [], message };
  }
  if (!fs.existsSync(dbFile)) {
    const message = `no database at ${dbFile} yet (first boot) — nothing to snapshot`;
    log(`[backup] ${message}`);
    return { status: 'skipped', pruned: [], message };
  }

  // Default the backup directory to a sibling of the database file. That is
  // what keeps snapshots INSIDE the mounted volume (/data/ham.db ->
  // /data/backups): a backup written anywhere else lives in the container's
  // writable layer and evaporates on the next `docker compose up` — which is
  // precisely the boot that would need it.
  const backupDir = opts.backupDir ?? path.join(path.dirname(dbFile), 'backups');
  let dest: string | null = null;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    dest = freeSnapshotPath(backupDir, opts.now ?? new Date(), prefix);
    const prisma = new PrismaClient({ datasourceUrl: opts.databaseUrl });
    try {
      // Bound parameter, not string interpolation: a database path containing
      // a quote would otherwise produce a malformed statement.
      await prisma.$executeRawUnsafe('VACUUM INTO ?', dest);
    } finally {
      await prisma.$disconnect();
    }
    const bytes = fs.statSync(dest).size;
    log(`[backup] wrote ${dest} (${Math.round(bytes / 1024)} KiB)`);
    const pruned = pruneOldSnapshots(backupDir, keep, prefix);
    for (const file of pruned) log(`[backup] pruned old snapshot ${file}`);
    return { status: 'created', file: dest, pruned };
  } catch (e) {
    const message = describe(e);
    // A half-written VACUUM output (disk full, killed mid-write) must not be
    // mistaken for a restorable snapshot, and must not count against retention.
    if (dest) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* best effort */
      }
    }
    log(`[backup] *** SNAPSHOT FAILED: ${message}`);
    log(`[backup] *** the database has NOT been backed up`);
    return { status: 'failed', pruned: [], message };
  }
}

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Where this deployment keeps its database and its snapshots, read from the
 * process environment.
 *
 * Exported because the CLI is no longer the only caller: the ADMIN name-sync
 * action snapshots through the same mechanism, and it must land in the same
 * directory, honour the same HNA_BACKUP_* overrides, and resolve the same
 * relative `file:` URL. A second copy of this resolution is exactly how an
 * admin action ends up writing its only undo into the container's writable
 * layer while the operator's real backups sit in /data/backups.
 *
 * DATABASE_URL is read directly instead of through src/env.ts on purpose:
 * env.ts also requires JWT_SECRET, and the backup must still be runnable in a
 * recovery shell where only the database location is known. The default
 * mirrors env.ts so dev behaviour cannot drift. Reading it at call time (not
 * at import time) also keeps the API's test harness — which points
 * DATABASE_URL at a fresh file per suite — working.
 */
export function snapshotOptionsFromEnv(
  overrides: Partial<SnapshotOptions> = {},
): SnapshotOptions {
  return {
    databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
    baseDir: prismaDirFrom(import.meta.url),
    backupDir: process.env.HNA_BACKUP_DIR || undefined,
    keep: positiveIntFromEnv(process.env.HNA_BACKUP_KEEP, DEFAULT_KEEP),
    ...overrides,
  };
}

async function main(): Promise<number> {
  const result = await snapshotDatabase(snapshotOptionsFromEnv());
  // Honest exit codes for interactive use (`... node dist/cli/backup.js` as an
  // ad-hoc backup). The decision to boot anyway lives in the entrypoint, where
  // it is visible to whoever reads the logs.
  return result.status === 'failed' ? 1 : 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`[backup] unexpected failure: ${describe(e)}`);
      process.exitCode = 1;
    },
  );
}
