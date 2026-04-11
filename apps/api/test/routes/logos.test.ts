import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let admin: string;
const LOGO_DIR = path.resolve(process.cwd(), 'data/logos-test-' + Date.now());

beforeAll(async () => {
  process.env.LOGO_DIR = LOGO_DIR;
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@x.co',
    password: 'hunter2hunter2',
    name: 'Admin',
    callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
});

afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
  fs.rmSync(LOGO_DIR, { recursive: true, force: true });
});

const tinySvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
);

describe('logo upload', () => {
  it('rejects unauthenticated', async () => {
    const res = await request(app)
      .post('/api/themes/default/logo')
      .attach('logo', tinySvg, 'test.svg');
    expect(res.status).toBe(401);
  });

  it('admin uploads, GETs, deletes', async () => {
    const up = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .attach('logo', tinySvg, 'test.svg');
    expect(up.status).toBe(201);
    expect(up.body.uploadedLogoUrl).toMatch(/^\/api\/themes\/default\/logo\?v=/);

    const get = await request(app).get('/api/themes/default/logo');
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toMatch(/image\/svg/);

    const list = await request(app).get('/api/themes');
    const def = (list.body as Array<{ slug: string; uploadedLogoUrl: string | null }>).find(
      (t) => t.slug === 'default',
    );
    expect(def?.uploadedLogoUrl).not.toBeNull();

    const del = await request(app)
      .delete('/api/themes/default/logo')
      .set('Cookie', admin);
    expect(del.status).toBe(204);
  });

  it('rejects wrong extension', async () => {
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .attach('logo', Buffer.from('evil'), 'payload.exe');
    expect(res.status).toBe(400);
  });

  it('admin uploads via URL (JSON body)', async () => {
    const tinyPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const dnsSpy = vi
      .spyOn(dns.promises, 'lookup')
      // @ts-expect-error overload
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(tinyPng, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'https://example.com/logo.png' });
    expect(res.status).toBe(201);
    expect(res.body.uploadedLogoUrl).toMatch(/\/api\/themes\/default\/logo\?v=/);
    spy.mockRestore();
    dnsSpy.mockRestore();
  });

  it('rejects non-http url', async () => {
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
  });

  it('rejects loopback URL (SSRF)', async () => {
    const dnsSpy = vi
      .spyOn(dns.promises, 'lookup')
      // @ts-expect-error overload
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'http://127.0.0.1/x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    dnsSpy.mockRestore();
  });

  it('rejects link-local metadata URL (SSRF)', async () => {
    const dnsSpy = vi
      .spyOn(dns.promises, 'lookup')
      // @ts-expect-error overload
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'http://169.254.169.254/' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    dnsSpy.mockRestore();
  });
});
