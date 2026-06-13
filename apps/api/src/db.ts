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
      await prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL');
      await prisma.$executeRawUnsafe('PRAGMA busy_timeout=5000');
      await prisma.$executeRawUnsafe('PRAGMA synchronous=NORMAL');
    } catch (e) {
      console.warn('[db] failed to apply SQLite pragmas', e);
    }
  })();
  return initialized;
}
