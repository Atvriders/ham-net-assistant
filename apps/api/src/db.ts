import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Apply SQLite reliability pragmas: WAL journaling for better concurrent
 * read/write behavior, a 5s busy timeout so transient lock contention waits
 * instead of erroring, and `synchronous=NORMAL` which is the recommended
 * trade-off when WAL is enabled. Runs once at boot.
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
