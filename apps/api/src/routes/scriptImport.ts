import { Router } from 'express';
import { z } from 'zod';
import mammoth from 'mammoth';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import dns from 'node:dns/promises';
import net from 'node:net';

const ImportUrlInput = z.object({
  url: z.string().url().max(2000),
});

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB max on imported doc payloads

/**
 * Very rough SSRF guard. Refuses private/loopback/link-local IPs.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'VALIDATION', 'url must be http or https');
  }
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  for (const a of addrs) {
    const ip = a.address;
    if (net.isIP(ip) === 4) {
      if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(ip)) throw new HttpError(400, 'VALIDATION', 'private ip blocked');
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) throw new HttpError(400, 'VALIDATION', 'private ip blocked');
    } else if (net.isIP(ip) === 6) {
      if (ip === '::1' || /^fe80:/i.test(ip) || /^fc/i.test(ip) || /^fd/i.test(ip)) {
        throw new HttpError(400, 'VALIDATION', 'private ip blocked');
      }
    }
  }
  return u;
}

/**
 * If the URL looks like a Google Docs document URL, return the docx export URL.
 * Accepts /edit, /view, /pub, and bare /d/<ID> forms.
 */
function rewriteGoogleDocsUrl(u: URL): URL {
  if (!/\.google\.com$/i.test(u.hostname) && !/^docs\.google\.com$/i.test(u.hostname)) return u;
  const m = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(u.pathname);
  if (!m) return u;
  return new URL(`https://docs.google.com/document/d/${m[1]}/export?format=docx`);
}

const mammothStyleMap = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  'b => strong',
  'i => em',
  'u => u',
];

async function readBoundedBody(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) throw new HttpError(400, 'VALIDATION', 'empty body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) throw new HttpError(413, 'VALIDATION', 'import file too large');
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export function scriptImportRouter(): Router {
  const router = Router();

  router.post('/url', requireAuth, asyncHandler(async (req, res) => {
    const { url } = ImportUrlInput.parse(req.body);
    const parsed = await assertPublicUrl(url);
    const target = rewriteGoogleDocsUrl(parsed);
    const remote = await fetch(target.toString(), {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'HamNetAssistant/1.0 (+https://github.com/Atvriders/ham-net-assistant)',
        'Accept': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain,text/html,*/*;q=0.8',
      },
    });
    if (!remote.ok) {
      throw new HttpError(400, 'VALIDATION', `remote returned ${remote.status}`);
    }
    const contentType = (remote.headers.get('content-type') ?? '').toLowerCase();
    const buffer = await readBoundedBody(remote);

    if (contentType.includes('wordprocessingml.document') || contentType.includes('application/octet-stream') || target.pathname.endsWith('.docx')) {
      const result = await mammoth.convertToHtml(
        { buffer },
        { styleMap: mammothStyleMap, includeDefaultStyleMap: true },
      );
      res.json({
        content: result.value,
        contentType: 'html',
        // Back-compat fields for older clients.
        markdown: result.value,
        source: 'docx',
      });
      return;
    }
    if (contentType.includes('text/markdown') || contentType.includes('text/plain') || target.pathname.endsWith('.md') || target.pathname.endsWith('.txt')) {
      const text = buffer.toString('utf8');
      res.json({ content: text, contentType: 'text', markdown: text, source: 'text' });
      return;
    }
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const html = buffer.toString('utf8');
      res.json({ content: html, contentType: 'html', markdown: html, source: 'html' });
      return;
    }
    throw new HttpError(415, 'VALIDATION', `unsupported content-type: ${contentType || 'unknown'}`);
  }));

  return router;
}
