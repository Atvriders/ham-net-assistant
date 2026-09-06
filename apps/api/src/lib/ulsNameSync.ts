import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { findUlsNames, normalizeCallsign } from './ulsLookup.js';
import { isUlsImportRunning, yieldToEventLoop } from './ulsImport.js';
import { NAME_SYNC_PREFIX, snapshotDatabase, snapshotOptionsFromEnv } from '../cli/backup.js';

/**
 * "Replace every stored name with the name on the FCC licence."
 *
 * WHAT THIS IS FOR: a club's log accumulates names typed over the air —
 * nicknames, misspellings, an operator's name from before they got married,
 * the callsign itself where nobody knew the name. `CheckIn.nameAtCheckIn` is
 * denormalised on purpose (it records what was logged AT THE TIME), which is
 * exactly why nothing else in the app ever repairs it in bulk. This tool does,
 * against the local FCC ULS mirror, because the FCC's own name is the one an
 * FCC-facing log should carry.
 *
 * WHY IT IS BUILT THE WAY IT IS: this is a bulk rewrite of the club's only
 * record of years of net activity, and no button undoes it. So:
 *
 *  - It is preview-first. {@link previewUlsNameSync} answers exactly what
 *    {@link applyUlsNameSync} would do, from the same planner, so the number an
 *    admin approves is the number that happens.
 *  - It never blanks a name. A callsign the mirror cannot answer for — absent,
 *    unpublished, nameless, blank-named, a portable or prefixed form like
 *    `W1AW/M` or `VE3/KB0BOB`, or the `N0CALL` placeholder — is SKIPPED and
 *    counted, never written. An out-of-date name in a log is a blemish; a
 *    missing one, or a stranger's, is a hole in the record.
 *  - It never writes a name it cannot prove belongs to the row. See
 *    {@link isPlaceholderCallsign}: the FCC's answer for a sentinel callsign is
 *    an answer about somebody else.
 *  - It refuses to run against an empty mirror, so "nobody has imported the ULS
 *    data yet" cannot present itself as "the FCC has no name for anybody".
 *  - It refuses to run while a net is live, because it holds the single SQLite
 *    writer in bursts and the operator logging check-ins needs it more.
 *  - It snapshots the database first, through the same `VACUUM INTO` the
 *    container entrypoint uses, and ABORTS if that snapshot cannot be taken.
 *    The boot-time backup is deliberately non-fatal because refusing to boot is
 *    worse than booting unprotected; here the opposite is true — the snapshot
 *    IS the undo, and there is no reason to proceed without one.
 */

/** The exact phrase a caller must echo back to run the destructive half. */
export const NAME_SYNC_CONFIRM = 'REPLACE NAMES';

/**
 * `N0CALL` (and the legacy `N0CALL<n>` rows that predate the fold in
 * routes/auth.ts) is this app's SENTINEL for "no callsign" — the shared
 * placeholder every unlicensed member registers under, explicitly allowed to
 * repeat, explicitly whitelisted in the shared `Callsign` schema, and
 * explicitly distrusted by lookupCallsignName.
 *
 * It is not a station identifier, so the FCC's answer for it — whoever holds
 * or is later granted that call — is never the person the row is about. Left
 * unguarded, one weekly import that picks up an active N0CALL licence turns
 * `includeUsers: true` into "rename every unlicensed member to a stranger",
 * across accounts that have no other record of what they used to be called.
 * Counted as skipped, exactly like the portable suffixes below.
 */
function isPlaceholderCallsign(key: string): boolean {
  return key === 'N0CALL' || /^N0CALL\d+$/.test(key);
}

/**
 * The name the FCC mirror offers for a stored callsign, or undefined when this
 * tool must leave the stored name alone.
 *
 * Undefined covers every "we cannot prove a name for this row" case in one
 * place: absent from the mirror, unpublished, nameless or blank-named (see
 * ulsLookup.findUlsNames), a portable/prefixed form such as `W1AW/M` or
 * `VE3/KB0BOB` that is not a key the FCC issues, and the N0CALL placeholder.
 */
function ulsNameFor(names: ReadonlyMap<string, string>, key: string): string | undefined {
  if (isPlaceholderCallsign(key)) return undefined;
  return names.get(key);
}

/**
 * Rows per write transaction — the same 2,000 the ULS importer uses, for the
 * same reason (see ULS_BATCH_ROWS): big enough that per-commit fsync cost
 * doesn't dominate, small enough that the writer is never held long enough for
 * a concurrent request to notice, and the event loop is handed back between
 * every batch.
 */
export const NAME_SYNC_BATCH_ROWS = 2000;

/**
 * Statements per transaction. One statement can cover thousands of rows (a
 * callsign with a long check-in history), so the row budget alone does not
 * bound the array handed to `$transaction`; this does.
 */
const MAX_STATEMENTS_PER_BATCH = 250;

/** How many `from → to` examples the preview returns. */
export const NAME_SYNC_SAMPLE_LIMIT = 25;

export interface NameSyncCounts {
  /** Rows considered. */
  scanned: number;
  /** Rows whose stored name differs from the FCC name. */
  changing: number;
  /** Rows that already carry the FCC name. */
  unchanged: number;
  /**
   * Rows left alone because no FCC name could be proven for the callsign AS
   * STORED — absent from the mirror, unpublished, blank-named, a portable or
   * prefixed form, or the N0CALL placeholder. Never written, always counted.
   */
  noUlsName: number;
}

export interface CheckInSample {
  callsign: string;
  from: string;
  to: string;
  /** Check-in rows carrying this exact `from` for this callsign. */
  rows: number;
}

export interface UserSample {
  callsign: string;
  from: string;
  to: string;
}

export interface NameSyncPreview {
  /** Rows in the mirror, published or not. 0 means nobody has ever imported. */
  ulsRows: number;
  checkIns: NameSyncCounts & { samples: CheckInSample[] };
  users: NameSyncCounts & { samples: UserSample[] };
}

export interface NameSyncResult {
  /** Absolute path of the pre-write snapshot; null when nothing needed writing. */
  snapshot: string | null;
  checkInsUpdated: number;
  usersUpdated: number;
  /** Distinct callsigns for which at least one row actually changed. */
  callsignsAffected: number;
  /** Rows (check-in + user) left alone because the mirror had no name. */
  skippedNoUlsName: number;
  durationMs: number;
}

const EMPTY_COUNTS: NameSyncCounts = { scanned: 0, changing: 0, unchanged: 0, noUlsName: 0 };

interface CheckInChange {
  /** The stored callsign, verbatim — this is what the UPDATE matches on. */
  callsign: string;
  /** Normalised key, for `callsignsAffected`. */
  key: string;
  from: string;
  to: string;
  rows: number;
}

interface UserChange {
  id: string;
  callsign: string;
  key: string;
  from: string;
  to: string;
}

interface NameSyncPlan {
  checkIns: NameSyncCounts & { changes: CheckInChange[] };
  users: NameSyncCounts & { changes: UserChange[] };
}

/**
 * Build the complete before/after plan.
 *
 * Both the preview and the write go through here, so they cannot disagree.
 *
 * The check-in side is one `groupBy` on (callsign, nameAtCheckIn) rather than a
 * scan of the rows: a club's log is thousands of rows but only hundreds of
 * distinct (callsign, name) pairs, and a pair is exactly the unit of work — one
 * `UPDATE ... WHERE callsign = ? AND nameAtCheckIn = ?` repairs every row that
 * shares it. Counts stay exact because the group carries its own row count, and
 * nothing has to be held in memory per row.
 *
 * Only live check-ins (`deletedAt: null`) are in scope, matching the existing
 * backfill-names tool: rows in the 30-day trash are not part of the log, and
 * rewriting them would edit records an admin has already removed.
 */
async function buildPlan(prisma: PrismaClient, includeUsers: boolean): Promise<NameSyncPlan> {
  const groups = await prisma.checkIn.groupBy({
    by: ['callsign', 'nameAtCheckIn'],
    where: { deletedAt: null },
    _count: { _all: true },
  });

  const users = includeUsers
    ? await prisma.user.findMany({ select: { id: true, callsign: true, name: true } })
    : [];

  // One bulk read for every callsign either side needs, through the same
  // matching rule as a single lookup (see ulsLookup.normalizeCallsign).
  const names = await findUlsNames(prisma, [
    ...groups.map((g) => g.callsign),
    ...users.map((u) => u.callsign),
  ]);

  const checkIns = { ...EMPTY_COUNTS, changes: [] as CheckInChange[] };
  for (const group of groups) {
    const rows = group._count._all;
    checkIns.scanned += rows;
    const key = normalizeCallsign(group.callsign);
    const to = ulsNameFor(names, key);
    if (to === undefined) {
      checkIns.noUlsName += rows;
      continue;
    }
    if (to === group.nameAtCheckIn) {
      checkIns.unchanged += rows;
      continue;
    }
    checkIns.changing += rows;
    checkIns.changes.push({ callsign: group.callsign, key, from: group.nameAtCheckIn, to, rows });
  }

  const userPlan = { ...EMPTY_COUNTS, changes: [] as UserChange[] };
  for (const user of users) {
    userPlan.scanned += 1;
    const key = normalizeCallsign(user.callsign);
    const to = ulsNameFor(names, key);
    if (to === undefined) {
      userPlan.noUlsName += 1;
      continue;
    }
    if (to === user.name) {
      userPlan.unchanged += 1;
      continue;
    }
    userPlan.changing += 1;
    userPlan.changes.push({ id: user.id, callsign: user.callsign, key, from: user.name, to });
  }

  return { checkIns, users: userPlan };
}

/**
 * Read-only. Deliberately does NOT 409 on an empty mirror: `ulsRows: 0` is a
 * documented part of this response, and it is how the admin screen explains
 * why the action is unavailable. Refusing to answer would leave the screen
 * with nothing to show.
 */
export async function previewUlsNameSync(
  prisma: PrismaClient,
  includeUsers: boolean,
): Promise<NameSyncPreview> {
  const [ulsRows, plan] = await Promise.all([
    prisma.ulsLicense.count(),
    buildPlan(prisma, includeUsers),
  ]);

  // Biggest blast radius first: the pairs worth eyeballing before approving are
  // the ones that rewrite the most rows. Ties break on callsign then old name so
  // the sample is stable across runs.
  const checkInSamples = [...plan.checkIns.changes]
    .sort((a, b) => b.rows - a.rows || a.callsign.localeCompare(b.callsign) || a.from.localeCompare(b.from))
    .slice(0, NAME_SYNC_SAMPLE_LIMIT)
    .map(({ callsign, from, to, rows }) => ({ callsign, from, to, rows }));

  const userSamples = [...plan.users.changes]
    .sort((a, b) => a.callsign.localeCompare(b.callsign) || a.from.localeCompare(b.from))
    .slice(0, NAME_SYNC_SAMPLE_LIMIT)
    .map(({ callsign, from, to }) => ({ callsign, from, to }));

  return {
    ulsRows,
    checkIns: {
      scanned: plan.checkIns.scanned,
      changing: plan.checkIns.changing,
      unchanged: plan.checkIns.unchanged,
      noUlsName: plan.checkIns.noUlsName,
      samples: checkInSamples,
    },
    users: {
      scanned: plan.users.scanned,
      changing: plan.users.changing,
      unchanged: plan.users.unchanged,
      noUlsName: plan.users.noUlsName,
      samples: userSamples,
    },
  };
}

interface PlannedWrite {
  key: string;
  rows: number;
  make: () => Prisma.PrismaPromise<Prisma.BatchPayload>;
}

/**
 * Run the planned updates in bounded transactions, yielding the event loop
 * between them.
 *
 * `$transaction(array)` rather than an interactive transaction, exactly as the
 * ULS importer does: every statement is known up front, so there is no round
 * trip holding the single SQLite writer open between them.
 */
async function applyWrites(
  prisma: PrismaClient,
  writes: readonly PlannedWrite[],
  affected: Set<string>,
): Promise<number> {
  let rowsUpdated = 0;
  let i = 0;
  while (i < writes.length) {
    const start = i;
    const statements: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [];
    let rows = 0;
    // `statements.length === 0 ||` so a single callsign with more history than
    // one batch still gets written, in a batch of its own.
    while (
      i < writes.length &&
      (statements.length === 0 ||
        (rows + writes[i]!.rows <= NAME_SYNC_BATCH_ROWS &&
          statements.length < MAX_STATEMENTS_PER_BATCH))
    ) {
      statements.push(writes[i]!.make());
      rows += writes[i]!.rows;
      i += 1;
    }
    const results = await prisma.$transaction(statements);
    results.forEach((result, offset) => {
      rowsUpdated += result.count;
      if (result.count > 0) affected.add(writes[start + offset]!.key);
    });
    await yieldToEventLoop();
  }
  return rowsUpdated;
}

/**
 * In-flight guard. Two concurrent runs would each snapshot a database the other
 * is half-way through rewriting, so neither snapshot is the "before" state
 * either of them promised.
 */
let running = false;

export function isNameSyncRunning(): boolean {
  return running;
}

async function assertSafeToRun(prisma: PrismaClient, ulsRows: number): Promise<void> {
  if (ulsRows === 0) {
    throw new HttpError(
      409,
      'CONFLICT',
      'The FCC ULS mirror is empty — load the ULS data first (Admin → FCC ULS mirror → Import now), then run this again. With no mirror there is no FCC name for anybody and this would do nothing but risk the log.',
    );
  }
  if (isUlsImportRunning()) {
    throw new HttpError(
      409,
      'CONFLICT',
      'A ULS import is running — the mirror is being rewritten right now. Wait for it to finish, then run this again.',
    );
  }
  const live = await prisma.netSession.findFirst({
    where: { liveAt: { not: null }, endedAt: null, deletedAt: null },
    select: { id: true, net: { select: { name: true } } },
  });
  if (live) {
    throw new HttpError(
      409,
      'CONFLICT',
      `A net is live right now (${live.net.name}). Replacing names rewrites the whole check-in log and must not run while an operator is logging check-ins — end the net first.`,
    );
  }
}

/**
 * Run the write phase, and make sure the path to the undo survives a failure.
 *
 * A batch that throws part-way — SQLITE_BUSY, a full disk, the container being
 * stopped under us — leaves the log HALF rewritten, which is the one moment an
 * admin actually needs the snapshot. Without this the failure reaches the error
 * middleware as an unrecognised error and is answered with the canned
 * "Internal error": the filename of the only copy of the log as it was is
 * generated inside this request, returned nowhere, and printed only to a
 * container log the admin may never read.
 */
async function guardWrites(snapshotFile: string, write: () => Promise<number>): Promise<number> {
  try {
    return await write();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new HttpError(
      500,
      'INTERNAL',
      `The name replacement failed part-way through (${reason}). Some names have been replaced and some have not. `
        + `The database as it was before this run is saved at ${snapshotFile} — restore that file to undo it.`,
    );
  }
}

/**
 * Replace stored names with the FCC name. Destructive; see the file header.
 *
 * `confirm` is checked by the caller (the route) so a bad phrase is a 400
 * rather than a 409, but everything that protects the DATA is enforced here so
 * it cannot be skipped by a future second caller.
 */
export async function applyUlsNameSync(
  prisma: PrismaClient,
  includeUsers: boolean,
): Promise<NameSyncResult> {
  if (running) {
    throw new HttpError(409, 'CONFLICT', 'A name replacement is already running.');
  }
  running = true;
  const startedAt = Date.now();
  try {
    // Guards BEFORE the plan: an empty mirror or a live net has to be a fast,
    // cheap refusal, not one paid for with a full scan of the log.
    await assertSafeToRun(prisma, await prisma.ulsLicense.count());
    const plan = await buildPlan(prisma, includeUsers);

    const skippedNoUlsName = plan.checkIns.noUlsName + plan.users.noUlsName;
    const nothingToDo = plan.checkIns.changes.length === 0 && plan.users.changes.length === 0;

    // Nothing to write means nothing to undo, so no snapshot. This is also what
    // makes the action cheap to re-run: a second run finds every name already
    // matching and does not VACUUM the whole database to prove it.
    if (nothingToDo) {
      return {
        snapshot: null,
        checkInsUpdated: 0,
        usersUpdated: 0,
        callsignsAffected: 0,
        skippedNoUlsName,
        durationMs: Date.now() - startedAt,
      };
    }

    // Guards AGAIN, now that the plan is built. The first call is the cheap
    // refusal; this one is the honest one. Building the plan is the slow part
    // of the run (a groupBy over the whole log plus the mirror reads), and a
    // control operator pressing START during it would otherwise find the
    // single SQLite writer taken away mid-net by a rewrite that had already
    // decided it was safe. Re-running it here shrinks the window from "however
    // long the plan took" to one indexed query, and costs one.
    await assertSafeToRun(prisma, await prisma.ulsLicense.count());

    // Same VACUUM INTO, same directory and the same HNA_BACKUP_* overrides as
    // the entrypoint backup — just its own filename prefix.
    const snapshot = await snapshotDatabase(
      snapshotOptionsFromEnv({ prefix: NAME_SYNC_PREFIX }),
    );
    if (snapshot.status !== 'created' || !snapshot.file) {
      // Hard stop, unlike the boot-time backup. Without this file the club has
      // no way back to the log as it was thirty seconds ago.
      throw new HttpError(
        500,
        'INTERNAL',
        `Refusing to replace names: the safety snapshot could not be taken (${snapshot.message ?? snapshot.status}). That snapshot is the only undo for this action, so nothing was changed.`,
      );
    }

    const affected = new Set<string>();

    const checkInWrites: PlannedWrite[] = plan.checkIns.changes.map((change) => ({
      key: change.key,
      rows: change.rows,
      // Matched on the exact (callsign, old name) pair the plan counted, so a
      // re-run is a no-op and a row edited by hand in between is left alone.
      make: () =>
        prisma.checkIn.updateMany({
          where: { callsign: change.callsign, nameAtCheckIn: change.from, deletedAt: null },
          data: { nameAtCheckIn: change.to },
        }),
    }));
    const checkInsUpdated = await guardWrites(
      snapshot.file,
      () => applyWrites(prisma, checkInWrites, affected),
    );

    // `updateMany` on the primary key rather than `update`: an account deleted
    // between the plan and the write is then a zero-row no-op instead of a
    // thrown error that aborts a run already part-way through the log.
    const userWrites: PlannedWrite[] = plan.users.changes.map((change) => ({
      key: change.key,
      rows: 1,
      make: () =>
        prisma.user.updateMany({
          where: { id: change.id, name: change.from },
          data: { name: change.to },
        }),
    }));
    const usersUpdated = await guardWrites(
      snapshot.file,
      () => applyWrites(prisma, userWrites, affected),
    );

    return {
      snapshot: snapshot.file,
      checkInsUpdated,
      usersUpdated,
      callsignsAffected: affected.size,
      skippedNoUlsName,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    running = false;
  }
}
