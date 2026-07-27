import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { safeFetch } from '../lib/safeFetch.js';

/**
 * SVG stays on the list on purpose: club logos are overwhelmingly vector, the
 * shipped themes ship .svg, and dropping it would break every existing upload.
 * The exposure it creates (SVG is script-capable, served from the app's own
 * origin) is closed at the response instead — see the CSP + nosniff headers on
 * the GET handler. Uploads are ADMIN-only to begin with.
 */
const ALLOWED_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg']);
const MAX_BYTES = 512 * 1024;

/**
 * Theme slugs name a file on disk, so the shape is the security boundary.
 * Express percent-decodes route params before we see them, so a request for
 * `/api/themes/..%2Fx/logo` arrives here as the slug `../x`.
 */
const SLUG_RE = /^[a-z][a-z0-9-]{0,40}$/;

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

let warnedRelativeLogoDir = false;

/**
 * LOGO_DIR is read straight from the environment because it is (still) missing
 * from the zod env schema in env.ts — validate and normalize it here so a bad
 * value cannot quietly do damage. A relative LOGO_DIR in the container is the
 * dangerous case: uploads land next to the code instead of in the /data volume
 * and vanish on the next image pull, so say so loudly once.
 */
function logoDir(): string {
  const configured = process.env.LOGO_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) && !warnedRelativeLogoDir) {
      warnedRelativeLogoDir = true;
      console.warn(
        `[logos] LOGO_DIR="${configured}" is relative; uploads will be written to ` +
          `${path.resolve(configured)} and are NOT on the /data volume.`,
      );
    }
    return path.resolve(configured);
  }
  return process.env.NODE_ENV === 'production'
    ? '/data/logos'
    : path.resolve(process.cwd(), 'data/logos');
}

function ensureDir(): string {
  const dir = logoDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve `<dir>/<slug><ext>` and refuse anything that lands outside the logo
 * directory. Belt and braces with the router.param slug check: this is the last
 * gate before a filesystem call, so a future caller that skips the router (or a
 * slug pattern that gets loosened) still cannot walk the tree.
 */
function safeLogoPath(dir: string, slug: string, ext: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const root = path.resolve(dir);
  const abs = path.resolve(root, `${slug}${ext}`);
  if (abs !== path.join(root, `${slug}${ext}`) || !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function findExisting(slug: string): { abs: string; ext: string } | null {
  // Read path: no mkdir. A GET must not create directories (it runs on the
  // unauthenticated theme list) and must not 500 when the volume is read-only.
  const dir = logoDir();
  for (const ext of ALLOWED_EXT) {
    const abs = safeLogoPath(dir, slug, ext);
    if (abs && fs.existsSync(abs)) return { abs, ext };
  }
  return null;
}

/**
 * Write `<slug><ext>` and drop the same slug's other extensions, so a theme
 * never ends up with two logo files and a find-order-dependent answer.
 */
function writeLogo(slug: string, ext: string, bytes: Buffer): void {
  const dir = ensureDir();
  const abs = safeLogoPath(dir, slug, ext);
  if (!abs) throw new HttpError(400, 'VALIDATION', 'Invalid theme slug');
  for (const other of ALLOWED_EXT) {
    if (other === ext) continue;
    const stale = safeLogoPath(dir, slug, other);
    if (stale && fs.existsSync(stale)) fs.unlinkSync(stale);
  }
  fs.writeFileSync(abs, bytes);
}

export function uploadedLogoUrl(slug: string): string | null {
  const hit = findExisting(slug);
  if (!hit) return null;
  const stat = fs.statSync(hit.abs);
  return `/api/themes/${slug}/logo?v=${stat.mtimeMs.toFixed(0)}`;
}

export function logosRouter(): Router {
  const router = Router();

  // One gate for every :slug handler. The pattern used to live only in the POST
  // handler, so the unauthenticated GET and the ADMIN DELETE both accepted
  // traversal slugs — a filesystem existence oracle and an arbitrary-image
  // unlink. Validating in router.param means a handler added later cannot
  // forget to do it.
  router.param('slug', (_req, _res, next, value) => {
    if (typeof value !== 'string' || !SLUG_RE.test(value)) {
      next(new HttpError(400, 'VALIDATION', 'Invalid theme slug'));
      return;
    }
    next();
  });

  router.get(
    '/:slug/logo',
    asyncHandler(async (req, res) => {
      const { slug } = req.params as { slug: string };
      const hit = findExisting(slug);
      if (!hit) throw new HttpError(404, 'NOT_FOUND', 'No uploaded logo for this theme');
      res.setHeader('Content-Type', MIME_BY_EXT[hit.ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=300');
      // Logos may be SVG, which is active content: an admin-uploaded (or
      // upstream-tampered) file opened at this same-origin URL could otherwise
      // run script against the app. `sandbox` with no allow-scripts kills that,
      // and nosniff stops a mislabelled body being re-typed as HTML.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      fs.createReadStream(hit.abs).pipe(res);
    }),
  );

  router.post(
    '/:slug/logo',
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      const { slug } = req.params as { slug: string };

      if (req.is('application/json')) {
        const body = req.body as { url?: unknown };
        const urlRaw = typeof body.url === 'string' ? body.url : '';
        let remote: Response;
        try {
          // maxRedirects: 0 keeps the previous redirect:'error' strictness —
          // a logo URL that bounces is more likely an SSRF probe than a CDN.
          ({ response: remote } = await safeFetch(urlRaw, {
            timeoutMs: 5000,
            maxRedirects: 0,
          }));
        } catch (e) {
          // Guard rejections already carry the right status/message; only
          // transport failures need wrapping.
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, 'VALIDATION', `Failed to fetch url: ${(e as Error).message}`);
        }
        if (!remote.ok) {
          throw new HttpError(400, 'VALIDATION', `Remote returned ${remote.status}`);
        }
        const ct = (remote.headers.get('content-type') ?? '').toLowerCase();
        let jext: '.svg' | '.png' | '.jpg';
        if (ct.startsWith('image/svg+xml')) jext = '.svg';
        else if (ct.startsWith('image/png')) jext = '.png';
        else if (ct.startsWith('image/jpeg') || ct.startsWith('image/jpg')) jext = '.jpg';
        else throw new HttpError(400, 'VALIDATION', `Unsupported remote content-type: ${ct || 'unknown'}`);
        const clHeader = remote.headers.get('content-length');
        if (clHeader) {
          const cl = parseInt(clHeader, 10);
          if (!Number.isNaN(cl) && cl > MAX_BYTES) {
            throw new HttpError(413, 'VALIDATION', `File too large (max ${MAX_BYTES} bytes)`);
          }
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = remote.body?.getReader();
        if (!reader) {
          throw new HttpError(400, 'VALIDATION', 'Remote returned empty body');
        }
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.byteLength;
            if (received > MAX_BYTES) {
              try { await reader.cancel(); } catch { /* ignore */ }
              throw new HttpError(413, 'VALIDATION', `File too large (max ${MAX_BYTES} bytes)`);
            }
            chunks.push(value);
          }
        }
        const fileBytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        if (fileBytes.length > MAX_BYTES) {
          throw new HttpError(413, 'VALIDATION', `File too large (max ${MAX_BYTES} bytes)`);
        }
        writeLogo(slug, jext, fileBytes);
        res.status(201).json({
          uploadedLogoUrl: uploadedLogoUrl(slug),
          uploadedAt: new Date().toISOString(),
          bytes: fileBytes.length,
        });
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      const m = /boundary=([^;]+)/.exec(contentType);
      if (!m) throw new HttpError(400, 'VALIDATION', 'Expected multipart/form-data');
      const boundary = `--${m[1]}`;

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > MAX_BYTES + 8192) {
          throw new HttpError(413, 'VALIDATION', `File too large (max ${MAX_BYTES} bytes)`);
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(boundary);

      let start = body.indexOf(boundaryBuf);
      if (start < 0) throw new HttpError(400, 'VALIDATION', 'Malformed multipart');
      start += boundaryBuf.length;
      if (body[start] === 0x0d) start += 2;

      const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
      if (headersEnd < 0) throw new HttpError(400, 'VALIDATION', 'Malformed multipart headers');
      const partHeaders = body.slice(start, headersEnd).toString('utf8');

      const fnMatch = /filename="([^"]+)"/.exec(partHeaders);
      if (!fnMatch || !fnMatch[1]) throw new HttpError(400, 'VALIDATION', 'Missing filename in multipart field');
      const filename = fnMatch[1];
      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        throw new HttpError(400, 'VALIDATION', `Extension ${ext} not allowed (svg/png/jpg only)`);
      }

      const fileStart = headersEnd + 4;
      const closing = Buffer.from(`\r\n${boundary}`);
      const fileEnd = body.indexOf(closing, fileStart);
      if (fileEnd < 0) throw new HttpError(400, 'VALIDATION', 'Malformed multipart body');
      const fileBytes = body.slice(fileStart, fileEnd);
      if (fileBytes.length > MAX_BYTES) {
        throw new HttpError(413, 'VALIDATION', `File too large (max ${MAX_BYTES} bytes)`);
      }

      writeLogo(slug, ext, fileBytes);
      res.status(201).json({
        uploadedLogoUrl: uploadedLogoUrl(slug),
        uploadedAt: new Date().toISOString(),
        bytes: fileBytes.length,
      });
    }),
  );

  router.delete(
    '/:slug/logo',
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      const { slug } = req.params as { slug: string };
      const hit = findExisting(slug);
      if (!hit) throw new HttpError(404, 'NOT_FOUND', 'No uploaded logo to delete');
      fs.unlinkSync(hit.abs);
      res.status(204).end();
    }),
  );

  return router;
}
