import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
beforeAll(async () => { ({ app, prisma, dbFile } = await makeTestApp()); });
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('GET /api/themes', () => {
  it('returns default theme at minimum, no auth required', async () => {
    const res = await request(app).get('/api/themes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const slugs = (res.body as Array<{ slug: string }>).map((t) => t.slug);
    expect(slugs).toContain('default');
  });
});
