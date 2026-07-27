import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// env.js parses process.env at import time and rejects short or
// placeholder-looking secrets, so supply a realistic random-hex value. This
// file deliberately does not import ../helpers.js — it needs to control the
// module graph itself (see mountWith below).
process.env.JWT_SECRET = '4c1f8e05a9d73b62f0ae14d78c3b95206ea7d41f8b0c2e69a35d17f4b8c60e92';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-static-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STATIC_DIR;
});

/**
 * env.STATIC_DIR is frozen at module-load, so each case needs a fresh module
 * graph — hence resetModules + dynamic import rather than a top-level import.
 */
async function mountWith(staticDir: string): Promise<Express> {
  vi.resetModules();
  process.env.STATIC_DIR = staticDir;
  const { mountStatic } = await import('../src/static.js');
  const app = express();
  mountStatic(app);
  return app;
}

describe('mountStatic', () => {
  it('logs loudly and serves API-only when STATIC_DIR does not exist', async () => {
    // Silent failure here produced a container that 404'd every browser
    // request with nothing in the logs to explain it.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missing = path.join(tmpRoot, 'not-a-real-dir');
    const app = await mountWith(missing);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain(missing);
    expect(logged).toContain('STATIC_DIR');

    const res = await request(app).get('/some/spa/route');
    expect(res.status).toBe(404);
  });

  it('logs loudly when STATIC_DIR exists but holds no index.html', async () => {
    // e.g. STATIC_DIR pointed at apps/web instead of apps/web/dist: the SPA
    // fallback would otherwise answer every deep link with a sendFile 500.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const empty = path.join(tmpRoot, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const app = await mountWith(empty);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('index.html');

    const res = await request(app).get('/some/spa/route');
    expect(res.status).toBe(404);
  });

  it('serves the SPA (and leaves /api/ alone) for a real build directory', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dist = path.join(tmpRoot, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>hna</title>');
    fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1);');
    const app = await mountWith(dist);

    expect(errorSpy).not.toHaveBeenCalled();

    const asset = await request(app).get('/app.js');
    expect(asset.status).toBe(200);

    const deepLink = await request(app).get('/nets/abc');
    expect(deepLink.status).toBe(200);
    expect(deepLink.text).toContain('<title>hna</title>');

    // API paths must fall through to the API routers / 404, never the SPA.
    const api = await request(app).get('/api/nets');
    expect(api.status).toBe(404);
  });

  it('accepts a relative STATIC_DIR by resolving it (sendFile needs absolute)', async () => {
    const dist = path.join(tmpRoot, 'reldist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>rel</title>');
    const relative = path.relative(process.cwd(), dist);
    const app = await mountWith(relative);

    const res = await request(app).get('/deep/link');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>rel</title>');
  });
});
