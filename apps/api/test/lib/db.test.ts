import { describe, it, expect, vi, afterAll } from 'vitest';
import { makeTestDb, cleanupTestDb } from '../helpers.js';

// Regression test for the silent-pragma-failure bug: `PRAGMA journal_mode=WAL`
// and `PRAGMA busy_timeout=N` RETURN a result row, and Prisma's
// $executeRawUnsafe rejects SQLite statements that return results ("Execute
// returned results, which is not allowed in SQLite."). initDb() caught that
// error and only warned — so production ran without WAL or a busy timeout
// while every test stayed green. initDb must use $queryRawUnsafe and the
// pragmas must ACTUALLY take effect, with no warning logged.
describe('initDb SQLite pragmas', () => {
  it('applies WAL + busy_timeout without warning', async () => {
    // Bind the db.ts singleton to a fresh migrated test DB: makeTestDb sets
    // process.env.DATABASE_URL before we import the module, and the
    // module-level `new PrismaClient()` reads the env at construction.
    const { prisma: helperClient, dbFile } = makeTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { prisma, initDb } = await import('../../src/db.js');
    try {
      await initDb();

      // The catch-and-warn path firing means the pragmas did NOT apply.
      const pragmaWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes('failed to apply SQLite pragmas'),
      );
      expect(pragmaWarnings).toEqual([]);

      const mode = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(
        'PRAGMA journal_mode',
      );
      expect(mode[0]?.journal_mode).toBe('wal');

      const timeout = await prisma.$queryRawUnsafe<{ timeout: number | bigint }[]>(
        'PRAGMA busy_timeout',
      );
      expect(Number(timeout[0]?.timeout)).toBe(5000);
    } finally {
      warn.mockRestore();
      await prisma.$disconnect().catch(() => {});
      await cleanupTestDb(helperClient, dbFile);
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });
});
