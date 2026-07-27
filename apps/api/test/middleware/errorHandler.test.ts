import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express, Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { errorHandler } from '../../src/middleware/error.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

describe('errors raised by body-parser', () => {
  it('answers malformed JSON with 400 VALIDATION, not 500', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.co", "password":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('never echoes the submitted body back to the caller', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2hunter2--leaked",');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('leaked');
  });

  it('answers an over-limit body with 413, not 500', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      // Body parser limit is 1mb; 1.5MB of padding trips it before any route runs.
      .send(JSON.stringify({ name: 'x'.repeat(1_500_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.message).toBe('Request body too large');
  });
});

describe('unknown /api routes', () => {
  it('returns the ApiError envelope instead of Express HTML', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('covers non-GET methods too', async () => {
    const res = await request(app).post('/api/nets/not-a-real-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('does not reflect the requested path back into the response', async () => {
    const res = await request(app).get('/api/%3Cscript%3Ealert(1)%3C/script%3E');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('script');
  });
});

describe('errorHandler unit behavior', () => {
  function fakeRes(headersSent: boolean) {
    const res = {
      headersSent,
      status: vi.fn(() => res),
      json: vi.fn(() => res),
    };
    return res;
  }
  const req = { method: 'GET', path: '/api/x' } as unknown as Request;

  it('delegates to next() once the response has started streaming', () => {
    // A CSV/PDF export that dies mid-write has already sent 200 + headers;
    // touching res here is the ERR_HTTP_HEADERS_SENT crash + truncated file.
    const res = fakeRes(true);
    const next = vi.fn();
    const err = new Error('stream died');
    errorHandler(err, req, res as unknown as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('honors a 5xx status carried on the error but keeps the message generic', () => {
    const res = fakeRes(false);
    const next = vi.fn();
    const err = Object.assign(new Error('upstream down'), { status: 503 });
    errorHandler(err, req, res as unknown as Response, next as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL', message: 'Internal error' },
    });
  });

  it('ignores a nonsense status and falls back to 500', () => {
    const res = fakeRes(false);
    const next = vi.fn();
    // Prisma errors carry a *string* `code` (e.g. "P2025") and no status.
    const err = Object.assign(new Error('boom'), { code: 'P2025', status: 0 });
    errorHandler(err, req, res as unknown as Response, next as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
