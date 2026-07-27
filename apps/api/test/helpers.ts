import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';

// Must satisfy the same rules the real deploy does (>= 32 chars, no
// placeholder words like "secret"/"change-me"), otherwise importing src/env.ts
// throws before a single test runs. Fixed value: tokens signed in one test
// file are meaningless in another anyway, and a random one would make failures
// unreproducible.
process.env.JWT_SECRET = '9f3b7c1d5e8a24609bd4f7a1c3e5079b2d6481fa0c7e39b5d2a814f60c9e73b1';
process.env.NODE_ENV = 'test';

export function makeTestDb(): { prisma: PrismaClient; dbFile: string } {
  const dbFile = path.join(
    process.cwd(),
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_URL = `file:${dbFile}`;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbFile}` } },
  });
  return { prisma, dbFile };
}

export async function cleanupTestDb(prisma: PrismaClient, dbFile: string): Promise<void> {
  // try/finally so a $disconnect failure (e.g. better-sqlite3 native handle
  // already closed by a sibling fork) still removes the tempfile + WAL/SHM
  // sidecars. The previous best-effort ordering left handles open long enough
  // for Node 22's GC to race a libuv close, producing a SIGABRT (exit 134).
  try {
    await prisma.$disconnect();
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
  }
}

export async function makeTestApp(): Promise<{
  app: Express;
  prisma: PrismaClient;
  dbFile: string;
}> {
  const { prisma, dbFile } = makeTestDb();
  const { buildApp } = await import('../src/app.js');
  const app = buildApp(prisma);
  return { app, prisma, dbFile };
}
