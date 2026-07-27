import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  await request(app).post('/api/auth/register').send({
    email: 'sec@x.co', password: 'hunter2hunter2', name: 'Sec', callsign: 'W1AW',
  });
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

describe('security headers', () => {
  it('sends a CSP that still allows everything the built SPA loads', async () => {
    const res = await request(app).get('/api/auth/config');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("connect-src 'self'");
    // React inline style props + the injected theme <style> block.
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    // index.html's Google Fonts stylesheet pulls its font files from gstatic.
    expect(csp).toContain('font-src');
    expect(csp).toContain('https://fonts.gstatic.com');
    // Logo previews before upload are blob:/data: URLs.
    expect(csp).toContain("img-src 'self' data: blob:");
    // Vite emits no inline script, so no escape hatch is granted.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // Would break plain-HTTP LAN access while an operator sets the box up.
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('sets the other baseline helmet headers and hides the framework', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('leaves COEP off so cross-origin fonts and logos still load', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
  });

  it('trusts exactly one proxy hop (the Cloudflare Tunnel)', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});

describe('rate limiting', () => {
  it('advertises the standard RateLimit headers and none of the legacy ones', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.headers['ratelimit']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('does not spend the login budget on successful sign-ins', async () => {
    // 25 > the 20-attempt cap: a club signing in from one campus NAT address
    // must never lock itself out by logging in correctly.
    for (let i = 0; i < 25; i += 1) {
      const res = await request(app).post('/api/auth/login').send({
        email: 'sec@x.co', password: 'hunter2hunter2',
      });
      expect(res.status).toBe(200);
    }
  });

  it('blocks sustained password guessing with a JSON 429', async () => {
    let last = await request(app).post('/api/auth/login').send({
      email: 'sec@x.co', password: 'wrongwrongwrong',
    });
    expect(last.status).toBe(401);
    for (let i = 0; i < 25 && last.status !== 429; i += 1) {
      last = await request(app).post('/api/auth/login').send({
        email: 'sec@x.co', password: 'wrongwrongwrong',
      });
    }
    expect(last.status).toBe(429);
    // The SPA only understands the ApiError envelope; a text/plain body would
    // surface to the user as the bare status line.
    expect(last.headers['content-type']).toMatch(/application\/json/);
    expect(last.body.error.message).toContain('Too many failed sign-in attempts');
  });

  it('does not rate-limit the polling endpoints out of the console', async () => {
    // /api/presence is polled every 45s per user and /api/sessions every 3s;
    // 60 back-to-back calls must not trip anything.
    for (let i = 0; i < 60; i += 1) {
      const res = await request(app).get('/api/sessions');
      expect(res.status).not.toBe(429);
    }
  });
});
