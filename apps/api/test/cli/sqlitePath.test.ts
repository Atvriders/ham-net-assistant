import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveSqliteFile, prismaDirFrom, isDirectRun } from '../../src/cli/sqlitePath.js';

// Both operator CLIs refuse to run against a database that isn't there. That
// guard is only as good as this resolution: get it wrong and the admin CLI
// reports "no database" for a perfectly healthy deployment — or worse, lets
// Prisma create an empty one and report "no ADMIN accounts exist".
describe('resolveSqliteFile', () => {
  it('resolves the absolute production URL', () => {
    expect(resolveSqliteFile('file:/data/ham.db', '/app/apps/api/prisma')).toBe('/data/ham.db');
  });

  it('resolves relative URLs against the prisma schema dir, not cwd', () => {
    // Prisma's own rule — the CLI is launched from /app, not from apps/api.
    expect(resolveSqliteFile('file:./dev.db', '/app/apps/api/prisma')).toBe(
      '/app/apps/api/prisma/dev.db',
    );
  });

  it('drops connection parameters from the filename', () => {
    expect(resolveSqliteFile('file:/data/ham.db?socket_timeout=5', '/x')).toBe('/data/ham.db');
  });

  it('returns null for non-file URLs', () => {
    expect(resolveSqliteFile('postgresql://localhost/hna', '/x')).toBeNull();
    expect(resolveSqliteFile('file:', '/x')).toBeNull();
  });
});

describe('prismaDirFrom', () => {
  it('points at apps/api/prisma from a module two levels below apps/api', () => {
    // Holds for both src/cli/*.ts (dev, tsx) and dist/cli/*.js (image).
    expect(prismaDirFrom('file:///app/apps/api/dist/cli/backup.js')).toBe(
      `${path.join('/app/apps/api/prisma')}${path.sep}`,
    );
  });
});

describe('isDirectRun', () => {
  it('is true only for the module that was launched', () => {
    const url = 'file:///app/apps/api/dist/cli/admin.js';
    expect(isDirectRun(url, '/app/apps/api/dist/cli/admin.js')).toBe(true);
    expect(isDirectRun(url, '/app/apps/api/dist/index.js')).toBe(false);
    // Importing the module (e.g. from a test) must not start main().
    expect(isDirectRun(url, undefined)).toBe(false);
  });
});
