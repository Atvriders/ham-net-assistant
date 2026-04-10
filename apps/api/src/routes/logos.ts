import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';

const ALLOWED_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg']);
const MAX_BYTES = 512 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function logoDir(): string {
  return (
    process.env.LOGO_DIR ||
    (process.env.NODE_ENV === 'production' ? '/data/logos' : './data/logos')
  );
}

function ensureDir(): string {
  const dir = logoDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findExisting(slug: string): { abs: string; ext: string } | null {
  const dir = ensureDir();
  for (const ext of ALLOWED_EXT) {
    const abs = path.join(dir, `${slug}${ext}`);
    if (fs.existsSync(abs)) return { abs, ext };
  }
  return null;
}

export function uploadedLogoUrl(slug: string): string | null {
  const hit = findExisting(slug);
  if (!hit) return null;
  const stat = fs.statSync(hit.abs);
  return `/api/themes/${slug}/logo?v=${stat.mtimeMs.toFixed(0)}`;
}

export function logosRouter(): Router {
  const router = Router();

  router.get(
    '/:slug/logo',
    asyncHandler(async (req, res) => {
      const { slug } = req.params as { slug: string };
      const hit = findExisting(slug);
      if (!hit) throw new HttpError(404, 'NOT_FOUND', 'No uploaded logo for this theme');
      res.setHeader('Content-Type', MIME_BY_EXT[hit.ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=300');
      fs.createReadStream(hit.abs).pipe(res);
    }),
  );

  router.post(
    '/:slug/logo',
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      const { slug } = req.params as { slug: string };
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(slug)) {
        throw new HttpError(400, 'VALIDATION', 'Invalid theme slug');
      }

      if (req.is('application/json')) {
        const body = req.body as { url?: unknown };
        const url = typeof body.url === 'string' ? body.url : '';
        if (!/^https?:\/\//i.test(url)) {
          throw new HttpError(400, 'VALIDATION', 'url must start with http:// or https://');
        }
        let remote: Response;
        try {
          remote = await fetch(url, { signal: AbortSignal.timeout(5000) });
        } catch (e) {
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
        const arrayBuf = await remote.arrayBuffer();
        const fileBytes = Buffer.from(arrayBuf);
        if (fileBytes.length > MAX_BYTES) {
          throw new HttpError(413, 'VALIDATION', `File too large (max ${MAX_BYTES} bytes)`);
        }
        const dir = ensureDir();
        for (const e of ALLOWED_EXT) {
          if (e === jext) continue;
          const other = path.join(dir, `${slug}${e}`);
          if (fs.existsSync(other)) fs.unlinkSync(other);
        }
        const abs = path.join(dir, `${slug}${jext}`);
        fs.writeFileSync(abs, fileBytes);
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

      const dir = ensureDir();
      for (const e of ALLOWED_EXT) {
        if (e === ext) continue;
        const other = path.join(dir, `${slug}${e}`);
        if (fs.existsSync(other)) fs.unlinkSync(other);
      }
      const abs = path.join(dir, `${slug}${ext}`);
      fs.writeFileSync(abs, fileBytes);
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
