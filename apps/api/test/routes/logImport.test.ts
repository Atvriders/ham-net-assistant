import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import dns from 'node:dns/promises';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;
let admin: string;
let member: string;
let netId: string;

const SAMPLE = [
  '4/25/26',
  'Topic: Ham Radio Emergency Preparedness: how could you help?',
  'NET control: AB0ZW James',
  'KC5QBT Jeff',
  'KF0WBD Bret',
  '',
  '5/2/26',
  'Topic: Antennas 101',
  'NET control: AB0ZW James',
  'W0XYZ Sam',
  'KD0AZG Tina',
].join('\n');

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // First user is ADMIN.
  const a = await request(app).post('/api/auth/register').send({
    email: 'admin@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'mem@x.co', password: 'hunter2hunter2', name: 'Mem', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', admin)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', admin).send({
    name: 'Log Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('POST /api/log-import/text', () => {
  it('MEMBER receives 403', async () => {
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', member)
      .send({ text: SAMPLE, netId });
    expect(res.status).toBe(403);
  });

  it('ADMIN imports two sessions with checkIns', async () => {
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: SAMPLE, netId });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.sessionIds).toHaveLength(2);
    expect(res.body.errors).toEqual([]);
    const sessions = await prisma.netSession.findMany({
      where: { netId }, orderBy: { startedAt: 'asc' }, include: { checkIns: true },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.topicTitle).toBe('Ham Radio Emergency Preparedness: how could you help?');
    expect(sessions[0]!.checkIns.map((c) => c.callsign).sort()).toEqual(['KC5QBT', 'KF0WBD']);
    expect(sessions[1]!.checkIns.map((c) => c.callsign).sort()).toEqual(['KD0AZG', 'W0XYZ']);
  });

  it('re-running same text skips duplicates', async () => {
    const first = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: SAMPLE, netId });
    expect(first.body.created).toBe(2);
    const second = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: SAMPLE, netId });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toHaveLength(2);
    const total = await prisma.netSession.count({ where: { netId } });
    expect(total).toBe(2);
  });

  it('dryRun returns parsed shape but does not insert', async () => {
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: SAMPLE, netId, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.parsed).toHaveLength(2);
    const total = await prisma.netSession.count({ where: { netId } });
    expect(total).toBe(0);
  });

  it('returns 404 when netId not found', async () => {
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: SAMPLE, netId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/log-import/url', () => {
  function mockDnsPublic() {
    vi.spyOn(dns, 'lookup').mockResolvedValue(
      [{ address: '8.8.8.8', family: 4 }] as unknown as never,
    );
  }

  it('fetches plain text URL and imports', async () => {
    mockDnsPublic();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(SAMPLE, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    const res = await request(app)
      .post('/api/log-import/url')
      .set('Cookie', admin)
      .send({ url: 'https://example.com/log.txt', netId });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
  });

  it('rewrites Google Docs URL to txt export', async () => {
    mockDnsPublic();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(SAMPLE, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    const res = await request(app)
      .post('/api/log-import/url')
      .set('Cookie', admin)
      .send({
        url: 'https://docs.google.com/document/d/ABC123/edit',
        netId,
        dryRun: true,
      });
    expect(res.status).toBe(200);
    const fetchedUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(fetchedUrl).toContain('/export?format=txt');
  });

  it('MEMBER receives 403', async () => {
    const res = await request(app)
      .post('/api/log-import/url')
      .set('Cookie', member)
      .send({ url: 'https://example.com/log.txt', netId });
    expect(res.status).toBe(403);
  });
});

describe('name enrichment from FCC / local users', () => {
  const BARE = [
    '6/13/26',
    'Topic: Bare callsigns',
    'NET control: AB0ZW James',
    'KE0VUM',
    'AA1BB',
    'ZZ9NOPE',
  ].join('\n');

  function mockCallook(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('callook.info/AA1BB/')) {
        return new Response(JSON.stringify({ status: 'VALID', name: 'JANE Q PUBLIC' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('callook.info/ZZ9NOPE/')) {
        return new Response(JSON.stringify({ status: 'INVALID' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // Default: 404
      return new Response('not found', { status: 404 });
    });
  }

  it('enrichNames=true fills names from local users without hitting FCC', async () => {
    // Pre-create a local user whose callsign maps to a name.
    await prisma.user.create({
      data: {
        email: 'tom@example.com',
        passwordHash: 'x',
        name: 'Tom Theis',
        callsign: 'KE0VUM',
        role: 'MEMBER',
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    const text = [
      '6/14/26',
      'Topic: Local lookup',
      'NET control: AB0ZW James',
      'KE0VUM',
    ].join('\n');
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text, netId, enrichNames: true });
    expect(res.status).toBe(200);
    expect(res.body.enriched).toBeGreaterThanOrEqual(1);
    const ke0 = fetchSpy.mock.calls.find((c) => String(c[0]).includes('KE0VUM'));
    expect(ke0).toBeUndefined();
    const sessions = await prisma.netSession.findMany({
      where: { netId }, include: { checkIns: true }, orderBy: { startedAt: 'desc' },
    });
    const ci = sessions[0]!.checkIns.find((c) => c.callsign === 'KE0VUM');
    expect(ci?.nameAtCheckIn).toBe('Tom Theis');
    // Cleanup user so other tests are unaffected.
    await prisma.user.deleteMany({ where: { callsign: 'KE0VUM' } });
  });

  it('enrichNames=true falls back to callook.info; valid names applied, invalid fall back to callsign', async () => {
    mockCallook();
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: BARE, netId, enrichNames: true });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.enriched).toBe(1);
    const sessions = await prisma.netSession.findMany({
      where: { netId }, include: { checkIns: true },
    });
    const cis = sessions[0]!.checkIns;
    const aa = cis.find((c) => c.callsign === 'AA1BB');
    const zz = cis.find((c) => c.callsign === 'ZZ9NOPE');
    expect(aa?.nameAtCheckIn).toBe('Jane Public');
    // Invalid call falls back to using the callsign as the display name.
    expect(zz?.nameAtCheckIn).toBe('ZZ9NOPE');
  });

  it('enrichNames=false skips lookups entirely (no FCC fetches, names remain callsign)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('should not be called', { status: 500 }),
    );
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: BARE, netId, enrichNames: false });
    expect(res.status).toBe(200);
    expect(res.body.enriched).toBe(0);
    const callookCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('callook.info'));
    expect(callookCalls).toHaveLength(0);
    const sessions = await prisma.netSession.findMany({
      where: { netId }, include: { checkIns: true },
    });
    for (const ci of sessions[0]!.checkIns) {
      expect(ci.nameAtCheckIn).toBe(ci.callsign);
    }
  });
});

describe('log import in-batch deduplication', () => {
  it('same date twice in one batch is skipped on second occurrence', async () => {
    const sameDateTwice = [
      '4/25/26',
      'Topic: First session',
      'NET control: AB0ZW James',
      'KC5QBT Jeff',
      '',
      '4/25/26',
      'Topic: Duplicate session same date',
      'NET control: AB0ZW James',
      'KF0WBD Bret',
    ].join('\n');
    const res = await request(app)
      .post('/api/log-import/text')
      .set('Cookie', admin)
      .send({ text: sameDateTwice, netId });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    const skipped = res.body.skipped[0];
    expect(skipped.reason).toContain('duplicate within import');
  });
});
