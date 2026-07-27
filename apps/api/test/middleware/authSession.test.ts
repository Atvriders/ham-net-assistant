import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';
import { COOKIE_NAME, TOKEN_TTL_SECONDS, signToken } from '../../src/lib/jwt.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const admin = await request(app).post('/api/auth/register').send({
    email: 'admin@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  adminCookie = admin.headers['set-cookie'][0];
  const member = await request(app).post('/api/auth/register').send({
    email: 'member@x.co', password: 'hunter2hunter2', name: 'Member', callsign: 'KB0MEM',
  });
  memberCookie = member.headers['set-cookie'][0];
  memberId = member.body.id;
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

describe('session revocation (role comes from the DB, not the token)', () => {
  it('grants access as soon as the DB role is raised, with the same old cookie', async () => {
    // GET /api/users is ADMIN-only.
    const before = await request(app).get('/api/users').set('Cookie', memberCookie);
    expect(before.status).toBe(403);

    await prisma.user.update({ where: { id: memberId }, data: { role: 'ADMIN' } });

    const after = await request(app).get('/api/users').set('Cookie', memberCookie);
    expect(after.status).toBe(200);
  });

  it('revokes access as soon as the DB role is lowered, with the same old cookie', async () => {
    await prisma.user.update({ where: { id: memberId }, data: { role: 'ADMIN' } });
    expect((await request(app).get('/api/users').set('Cookie', memberCookie)).status).toBe(200);

    // The demotion an officer performs in the admin screen. Previously the
    // already-issued cookie kept ADMIN rights for the rest of its lifetime.
    await prisma.user.update({ where: { id: memberId }, data: { role: 'MEMBER' } });

    const after = await request(app).get('/api/users').set('Cookie', memberCookie);
    expect(after.status).toBe(403);
  });

  it('ignores an elevated role claim inside an otherwise valid token', async () => {
    // Correctly signed token, real user id, but a role the DB does not agree
    // with — the exact shape of a replayed pre-demotion cookie.
    const forged = signToken({ sub: memberId, role: 'ADMIN' });
    const res = await request(app)
      .get('/api/users')
      .set('Cookie', `${COOKIE_NAME}=${forged}`);
    expect(res.status).toBe(403);
  });

  it('treats a cookie for a deleted user as anonymous', async () => {
    const doomed = await request(app).post('/api/auth/register').send({
      email: 'doomed@x.co', password: 'hunter2hunter2', name: 'Doomed', callsign: 'KC0GON',
    });
    const cookie = doomed.headers['set-cookie'][0];
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    await request(app).delete(`/api/users/${doomed.body.id}`).set('Cookie', adminCookie);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
    const directory = await request(app).get('/api/users/directory').set('Cookie', cookie);
    expect(directory.status).toBe(401);
  });

  it('rejects a role string the DB holds but the contract does not know', async () => {
    // Free-form role column: a hand-edited row must fail closed, not rank as
    // "at least MEMBER" because the string is non-empty.
    await prisma.user.update({ where: { id: memberId }, data: { role: 'SUPERUSER' } });
    const res = await request(app).get('/api/users/directory').set('Cookie', memberCookie);
    expect(res.status).toBe(401);
    await prisma.user.update({ where: { id: memberId }, data: { role: 'MEMBER' } });
  });
});

describe('token lifetime', () => {
  it('expires 12 hours after issue, not 7 days', () => {
    expect(TOKEN_TTL_SECONDS).toBe(12 * 60 * 60);
    const token = signToken({ sub: memberId, role: 'MEMBER' });
    const claims = jwt.decode(token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(12 * 60 * 60);
  });

  it('sets a session cookie that dies with the token', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'admin@x.co', password: 'hunter2hunter2',
    });
    expect(res.status).toBe(200);
    const cookie: string = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/Max-Age=43200/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});
