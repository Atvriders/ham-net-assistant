import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { hashPassword } from '../../src/lib/password.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

describe('GET /api/auth/config', () => {
  it('returns inviteCodeRequired=false when REGISTRATION_CODE unset', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inviteCodeRequired: false });
  });
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

  it('all unlicensed users share callsign N0CALL', async () => {
    const r1 = await request(app).post('/api/auth/register').send({
      email: 'n0a@example.com', password: 'hunter2hunter2',
      name: 'Nobody', callsign: 'N0CALL',
    });
    expect(r1.status).toBe(201);
    expect(r1.body.callsign).toBe('N0CALL');
    const r2 = await request(app).post('/api/auth/register').send({
      email: 'n0b@example.com', password: 'hunter2hunter2',
      name: 'Nobody2', callsign: 'N0CALL',
    });
    expect(r2.status).toBe(201);
    expect(r2.body.callsign).toBe('N0CALL');
    const r3 = await request(app).post('/api/auth/register').send({
      email: 'n0c@example.com', password: 'hunter2hunter2',
      name: 'Nobody3', callsign: 'N0CALL',
    });
    expect(r3.status).toBe(201);
    expect(r3.body.callsign).toBe('N0CALL');
  });

  it('rejects duplicate non-N0CALL callsign with 409', async () => {
    const r1 = await request(app).post('/api/auth/register').send({
      email: 'dupcall1@example.com', password: 'hunter2hunter2',
      name: 'Dup1', callsign: 'KD0DUP',
    });
    expect(r1.status).toBe(201);
    const r2 = await request(app).post('/api/auth/register').send({
      email: 'dupcall2@example.com', password: 'hunter2hunter2',
      name: 'Dup2', callsign: 'KD0DUP',
    });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid callsign', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'charlie@example.com', password: 'hunter2hunter2',
      name: 'Chuck', callsign: 'X',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects a password under 12 characters', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'shortpw@example.com', password: 'hunter22',
      name: 'Shorty', callsign: 'KE0PW',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects an oversized email instead of persisting it', async () => {
    // A 1MB body used to be stored verbatim in the email column.
    const res = await request(app).post('/api/auth/register').send({
      email: `${'a'.repeat(300)}@example.com`, password: 'hunter2hunter2',
      name: 'Huge', callsign: 'KE0BIG',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('normalizes email case and whitespace', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: '  Mixed@Example.COM ', password: 'hunter2hunter2',
      name: 'Mixed', callsign: 'KE0MIX',
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('mixed@example.com');
  });

  it('refuses a second account that differs only in email casing', async () => {
    // SQLite's unique index is BINARY, so without normalization this created
    // a second account that shadowed the first member's history.
    const res = await request(app).post('/api/auth/register').send({
      email: 'MIXED@example.com', password: 'hunter2hunter2',
      name: 'Mixed Again', callsign: 'KE0MX2',
    });
    expect(res.status).toBe(409);
  });

  it('does not disclose which field is already taken', async () => {
    const dupeEmail = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
      name: 'Not Alice', callsign: 'KE0UNQ',
    });
    const dupeCallsign = await request(app).post('/api/auth/register').send({
      email: 'brand-new@example.com', password: 'hunter2hunter2',
      name: 'Not Bob', callsign: 'KB0BOB',
    });
    expect(dupeEmail.status).toBe(409);
    expect(dupeCallsign.status).toBe(409);
    // Identical wording either way: the public sign-up form must not work as
    // a "is this callsign/email a club member?" oracle.
    expect(dupeEmail.body.error.message).toBe(dupeCallsign.body.error.message);
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

  it('accepts any casing of a registered email at login', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: '  ALICE@Example.com ', password: 'hunter2hunter2',
    });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('alice@example.com');
  });

  it('still authenticates a legacy account stored with mixed-case email', async () => {
    // Rows created before email normalization: the binary unique index means
    // findUnique('legacy@x.co') misses them entirely.
    await prisma.user.create({
      data: {
        email: 'Legacy@X.Co',
        name: 'Legacy',
        callsign: 'KL0GCY',
        passwordHash: await hashPassword('hunter2hunter2'),
        role: 'MEMBER',
      },
    });
    const res = await request(app).post('/api/auth/login').send({
      email: 'legacy@x.co', password: 'hunter2hunter2',
    });
    expect(res.status).toBe(200);
    expect(res.body.callsign).toBe('KL0GCY');
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
