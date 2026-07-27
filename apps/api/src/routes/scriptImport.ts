import { Router } from 'express';
import { z } from 'zod';
import mammoth from 'mammoth';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { safeFetch } from '../lib/safeFetch.js';

const ImportUrlInput = z.object({
  url: z.string().url().max(2000),
});

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB max on imported doc payloads

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

  // OFFICER, not merely authenticated: this endpoint fetches an arbitrary URL
  // and hands the body back, and self-registration is open by default, so any
  // visitor could otherwise use the server as an HTTP client. The equivalent
  // log-import route is ADMIN, and the only UI that reaches here (the script
  // editor inside NetEditModal) is already OFFICER-gated in the web client.
  router.post('/url', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    const { url } = ImportUrlInput.parse(req.body ?? {});
    let submitted: URL;
    try {
      submitted = new URL(url);
    } catch {
      // zod's .url() and WHATWG URL don't agree on every edge case; a parse
      // failure here is the client's fault, not a 500.
      throw new HttpError(400, 'VALIDATION', 'Invalid URL');
    }
    const target = rewriteGoogleDocsUrl(submitted);
    // safeFetch re-validates the destination on every redirect hop; the old
    // redirect:'follow' let an attacker-controlled 302 land on internal hosts.
    const { response: remote, finalUrl } = await safeFetch(target, {
      timeoutMs: 10000,
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

    if (contentType.includes('wordprocessingml.document') || contentType.includes('application/octet-stream') || finalUrl.pathname.endsWith('.docx')) {
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
    if (contentType.includes('text/markdown') || contentType.includes('text/plain') || finalUrl.pathname.endsWith('.md') || finalUrl.pathname.endsWith('.txt')) {
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
