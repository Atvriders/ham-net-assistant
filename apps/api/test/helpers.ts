import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';

process.env.JWT_SECRET = 'test-secret-long-enough-for-validation';
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
  await prisma.$disconnect();
  try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
  try { fs.unlinkSync(`${dbFile}-journal`); } catch { /* ignore */ }
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
