import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

describe('POST /api/auth/register', () => {
  it('creates first user as ADMIN and sets cookie', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
      name: 'Alice', callsign: 'w1aw',
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('ADMIN');
    expect(res.body.callsign).toBe('W1AW');
    expect(res.headers['set-cookie']?.[0]).toMatch(/hna_session=/);
  });

  it('makes second user MEMBER', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'bob@example.com', password: 'hunter2hunter2',
      name: 'Bob', callsign: 'KB0BOB',
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('MEMBER');
  });

  it('rejects duplicate email', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
      name: 'Alice2', callsign: 'KC0XYZ',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid callsign', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'charlie@example.com', password: 'hunter2hunter2',
      name: 'Chuck', callsign: 'X',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});

describe('POST /api/auth/login + /me + /logout', () => {
  it('logs in, returns user from /me, logs out', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
    });
    expect(login.status).toBe(200);
    expect(login.body.email).toBe('alice@example.com');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.callsign).toBe('W1AW');

    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);

    const me2 = await agent.get('/api/auth/me');
    expect(me2.status).toBe(401);
  });

  it('rejects bad password', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com', password: 'wrongwrongwrong',
    });
    expect(res.status).toBe(401);
  });

  it('rejects token with bogus role claim', async () => {
    const forged = jwt.sign(
      { sub: 'someid', role: 'SUPERUSER' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `hna_session=${forged}`);
    expect(res.status).toBe(401);
  });
});
