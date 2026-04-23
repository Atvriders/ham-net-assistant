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
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function authedCookie(email: string, callsign: string): Promise<string> {
  const res = await request(app).post('/api/auth/register').send({
    email,
    password: 'hunter2hunter2',
    name: 'Test User',
    callsign,
  });
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : (cookie as unknown as string);
}

function mockDnsPublic() {
  vi.spyOn(dns, 'lookup').mockResolvedValue(
    [{ address: '8.8.8.8', family: 4 }] as unknown as never,
  );
}

function mockDnsPrivate() {
  vi.spyOn(dns, 'lookup').mockResolvedValue(
    [{ address: '127.0.0.1', family: 4 }] as unknown as never,
  );
}

describe('POST /api/script-import/url', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/script-import/url')
      .send({ url: 'https://example.com/doc.txt' });
    expect(res.status).toBe(401);
  });

  it('rejects private IPs via SSRF guard', async () => {
    const cookie = await authedCookie('ssrf@x.co', 'K0SSRF');
    mockDnsPrivate();
    const res = await request(app)
      .post('/api/script-import/url')
      .set('Cookie', cookie)
      .send({ url: 'http://127.0.0.1/evil' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('fetches a Google Docs URL, runs mammoth, returns HTML', async () => {
    const cookie = await authedCookie('gdocs@x.co', 'K0GDOC');
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
    const cookie = await authedCookie('txt@x.co', 'K0TXT');
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
