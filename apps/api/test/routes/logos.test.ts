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
    // An uploaded SVG is active content served from the app's own origin.
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

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

  it('rejects a host resolving to CGNAT space (SSRF)', async () => {
    const dnsSpy = vi
      .spyOn(dns.promises, 'lookup')
      // @ts-expect-error overload
      .mockResolvedValue([{ address: '100.64.9.9', family: 4 }]);
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'https://cgnat.example/logo.png' });
    expect(res.status).toBe(400);
    dnsSpy.mockRestore();
  });

  it('rejects a host resolving to an IPv4-mapped IPv6 metadata address (SSRF)', async () => {
    const dnsSpy = vi
      .spyOn(dns.promises, 'lookup')
      // @ts-expect-error overload
      .mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }]);
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'https://mapped.example/logo.png' });
    expect(res.status).toBe(400);
    dnsSpy.mockRestore();
  });

  it('rejects a redirecting logo URL instead of following it', async () => {
    const dnsSpy = vi
      .spyOn(dns.promises, 'lookup')
      // @ts-expect-error overload
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/logo.png' } }),
    );
    const res = await request(app)
      .post('/api/themes/default/logo')
      .set('Cookie', admin)
      .set('Content-Type', 'application/json')
      .send({ url: 'https://example.com/logo.png' });
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    dnsSpy.mockRestore();
  });
});

describe('theme slug validation', () => {
  // Express percent-decodes route params, so '..%2Fx' arrives as '../x'. Before
  // router.param(), only the POST handler checked the shape: the anonymous GET
  // was a filesystem existence oracle and the ADMIN DELETE could unlink any
  // image on the box.
  const traversals = ['..%2F..%2Fetc%2Fpasswd', '..%2Fdefault', '%2Fetc%2Fhosts', 'UPPER', 'has space'];

  for (const slug of traversals) {
    it(`GET rejects slug "${slug}"`, async () => {
      const res = await request(app).get(`/api/themes/${slug}/logo`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it(`DELETE rejects slug "${slug}"`, async () => {
      const res = await request(app).delete(`/api/themes/${slug}/logo`).set('Cookie', admin);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });
  }

  it('a valid but unused slug still 404s (no information leak difference)', async () => {
    const res = await request(app).get('/api/themes/no-such-theme/logo');
    expect(res.status).toBe(404);
  });

  it('does not read a file outside the logo dir even if one exists there', async () => {
    // Prove the traversal target really is present: without the guard, the
    // handler would have found and streamed it.
    const outside = path.join(path.dirname(LOGO_DIR), 'outside-logo.png');
    fs.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const res = await request(app).get('/api/themes/..%2Foutside-logo/logo');
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
