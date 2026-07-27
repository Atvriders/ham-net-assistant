import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import dns from 'node:dns/promises';
import mammothBase from 'mammoth';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

const mammoth = mammothBase;

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  // The first account registered is ADMIN; burn it here so every account the
  // tests below create is a plain MEMBER and the role gating is real.
  await register('root@x.co', 'W1AW');
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function register(email: string, callsign: string): Promise<string> {
  const res = await request(app).post('/api/auth/register').send({
    email,
    password: 'hunter2hunter2',
    name: 'Test User',
    callsign,
  });
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : (cookie as unknown as string);
}

/**
 * The route is OFFICER-gated, and only the first registered account is ADMIN,
 * so promote + re-login to get a token carrying the OFFICER role.
 */
async function officerCookie(email: string, callsign: string): Promise<string> {
  await register(email, callsign);
  const user = await prisma.user.findFirst({ where: { callsign } });
  await prisma.user.update({ where: { id: user!.id }, data: { role: 'OFFICER' } });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'hunter2hunter2' });
  return login.headers['set-cookie'][0];
}

function mockDnsPublic() {
  vi.spyOn(dns, 'lookup').mockResolvedValue(
    [{ address: '8.8.8.8', family: 4 }] as unknown as never,
  );
}

function mockDnsResolvingTo(address: string, family = 4) {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address, family }] as unknown as never);
}

describe('POST /api/script-import/url', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/script-import/url')
      .send({ url: 'https://example.com/doc.txt' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a plain MEMBER', async () => {
    // Self-registration is open, so "any logged-in user" is "anyone at all";
    // fetching arbitrary URLs is an officer-level capability.
    const cookie = await register('member@x.co', 'K0MEM');
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://example.com/doc.txt' });
    expect(res.status).toBe(403);
  });

  it('rejects private IPs via SSRF guard', async () => {
    const cookie = await officerCookie('ssrf@x.co', 'K0SSRF');
    mockDnsResolvingTo('127.0.0.1');
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'http://127.0.0.1/evil' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects a host that resolves to link-local metadata', async () => {
    const cookie = await officerCookie('meta@x.co', 'K0META');
    mockDnsResolvingTo('169.254.169.254');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://rebind.example/doc.txt' });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a host that resolves to CGNAT space', async () => {
    const cookie = await officerCookie('cgnat@x.co', 'K0CGN');
    mockDnsResolvingTo('100.64.7.7');
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://cgnat.example/doc.txt' });
    expect(res.status).toBe(400);
  });

  it('rejects a host that resolves to an IPv4-mapped IPv6 metadata address', async () => {
    const cookie = await officerCookie('mapped@x.co', 'K0MAP');
    mockDnsResolvingTo('::ffff:169.254.169.254', 6);
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://mapped.example/doc.txt' });
    expect(res.status).toBe(400);
  });

  it('rejects when DNS resolution fails instead of fetching anyway', async () => {
    const cookie = await officerCookie('dnsfail@x.co', 'K0DNS');
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://broken.example/doc.txt' });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a redirect that points at an internal address', async () => {
    const cookie = await officerCookie('redir@x.co', 'K0RED');
    mockDnsPublic();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://example.com/doc.txt' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    // Only the public first hop was ever requested — the body of the metadata
    // service must never reach the caller.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('follows a public redirect and classifies by the FINAL url', async () => {
    const cookie = await officerCookie('redirok@x.co', 'K0ROK');
    mockDnsPublic();
    let hop = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      hop += 1;
      return hop === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/final.txt' } })
        : new Response('hello from the cdn', { status: 200 });
    });
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://example.com/doc' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hello from the cdn');
    expect(res.body.contentType).toBe('text');
  });

  it('fetches a Google Docs URL, runs mammoth, returns HTML', async () => {
    const cookie = await officerCookie('gdocs@x.co', 'K0GDOC');
    mockDnsPublic();

    const fakeDocxBuffer = Buffer.from('PK-fake-docx');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(fakeDocxBuffer, {
        status: 200,
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      }),
    );
    const mammothSpy = vi
      .spyOn(mammoth, 'convertToHtml')
      .mockResolvedValue({
        value: '<p><span style="color:#ff0000">Hi</span></p>',
        messages: [],
      } as never);

    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({
        url: 'https://docs.google.com/document/d/ABCDEF123/edit',
      });

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('html');
    expect(res.body.content).toContain('<span style="color:#ff0000">Hi</span>');
    expect(res.body.source).toBe('docx');
    expect(mammothSpy).toHaveBeenCalled();
    const call = mammothSpy.mock.calls[0]?.[0] as { buffer: Buffer };
    expect(Buffer.isBuffer(call.buffer)).toBe(true);
    expect(call.buffer.toString()).toBe('PK-fake-docx');

    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.spyOn>;
    const fetchedUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(fetchedUrl)).toContain('/export?format=docx');
  });

  it('returns content === body for text/plain responses', async () => {
    const cookie = await officerCookie('txt@x.co', 'K0TXT');
    mockDnsPublic();
    const body = '# Hello\n\nPlain markdown body.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'https://example.com/script.md' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(body);
    expect(res.body.contentType).toBe('text');
  });
});
