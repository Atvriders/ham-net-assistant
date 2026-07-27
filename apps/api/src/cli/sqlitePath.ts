import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path helpers shared by the operator CLIs (pre-migration backup + admin
 * recovery). Both need to answer "where is the club's database, really?"
 * before they touch it — a CLI that silently creates a brand-new empty SQLite
 * file instead of reporting "no database here" is worse than useless during a
 * recovery.
 */

/**
 * Resolve the on-disk SQLite file behind a Prisma `file:` DATABASE_URL, or
 * null when the URL is not a file: URL (nothing to snapshot / no local file to
 * check).
 *
 * `baseDir` is what relative paths resolve against. Prisma resolves relative
 * sqlite paths against the directory holding schema.prisma — NOT the process
 * cwd — so passing anything else here would make the CLI look for the dev
 * database in the wrong place and report a phantom "no database".
 */
export function resolveSqliteFile(databaseUrl: string, baseDir: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  let raw = databaseUrl.slice('file:'.length);
  // Prisma allows connection params on the URL (`file:/data/ham.db?socket_timeout=5`);
  // they are not part of the filename.
  const query = raw.indexOf('?');
  if (query !== -1) raw = raw.slice(0, query);
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDir, raw);
}

/**
 * Directory containing schema.prisma, derived from the calling module's own
 * location rather than cwd. `src/cli/x.ts` (tsx, dev) and `dist/cli/x.js`
 * (built, in the image) both sit two levels below `apps/api`, so the same
 * relative hop works in development and inside the container — where the CLI
 * is launched from /app, not from apps/api.
 */
export function prismaDirFrom(moduleUrl: string): string {
  return fileURLToPath(new URL('../../prisma/', moduleUrl));
}

/**
 * True when this module was launched directly (`node dist/cli/admin.js`)
 * rather than imported. Without this guard, importing a CLI from a test would
 * run its `main()` — and `set-password` would sit there waiting on stdin
 * forever.
 */
export function isDirectRun(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  return path.resolve(argv1) === fileURLToPath(moduleUrl);
}
