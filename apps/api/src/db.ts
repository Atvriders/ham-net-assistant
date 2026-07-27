import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Apply SQLite reliability pragmas once at boot. Must complete BEFORE the
 * HTTP server starts accepting requests (see index.ts) so no query ever runs
 * against an un-tuned connection.
 *
 * What is actually guaranteed, since these statements run on whichever single
 * connection Prisma's pool hands us:
 *  - `journal_mode=WAL` — GUARANTEED database-wide. WAL is persisted in the
 *    database file header, so every connection (and every later boot) uses
 *    it. This is the one that matters: it's what lets readers not block the
 *    writer.
 *  - `busy_timeout=5000` — connection-scoped. Other pooled connections keep
 *    their own timeout, so a busy-lock error is still possible under
 *    contention; it is not the blanket guarantee it looks like.
 *  - `synchronous=NORMAL` — connection-scoped, and therefore NOT in effect
 *    process-wide despite what this comment used to claim. Connections that
 *    never ran it stay at SQLite's default `FULL`, which fsyncs more often:
 *    slower, but strictly MORE durable, so the mismatch is safe. Do not
 *    "fix" it by assuming NORMAL semantics anywhere.
 *
 * Making the connection-scoped pragmas real would mean pinning the pool to a
 * single connection (`?connection_limit=1` on DATABASE_URL) — a deployment
 * decision, not a code one.
 */
let initialized: Promise<void> | null = null;
export function initDb(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    try {
      // Must be $queryRawUnsafe, not $executeRawUnsafe: `PRAGMA
      // journal_mode=WAL` and `PRAGMA busy_timeout=N` RETURN a result row
      // (the new mode / current timeout), and Prisma's execute path rejects
      // SQLite statements that return results ("Execute returned results,
      // which is not allowed in SQLite.") — which silently left prod
      // running without WAL or a busy timeout.
      await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
      await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000');
      await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
    } catch (e) {
      console.warn('[db] failed to apply SQLite pragmas', e);
    }
  })();
  return initialized;
}
