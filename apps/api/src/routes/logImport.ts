import { Router } from 'express';
import { z } from 'zod';
import mammoth from 'mammoth';
import { PrismaClient } from '@prisma/client';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { validateBody } from '../middleware/validate.js';
import { parseLogText, type ParsedSession } from '../lib/parseLog.js';
import dns from 'node:dns/promises';
import net from 'node:net';

const TextImportInput = z.object({
  text: z.string().min(1).max(200_000),
  netId: z.string().min(1),
  dryRun: z.boolean().optional(),
});

const UrlImportInput = z.object({
  url: z.string().url().max(2000),
  netId: z.string().min(1),
  dryRun: z.boolean().optional(),
});

const MAX_DOC_BYTES = 4 * 1024 * 1024;

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

/** Rewrite Google Docs URLs to txt export so we get plain text, easy to parse. */
function rewriteGoogleDocsToTxt(u: URL): URL {
  if (!/^docs\.google\.com$/i.test(u.hostname)) return u;
  const m = u.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return u;
  return new URL(`https://docs.google.com/document/d/${m[1]}/export?format=txt`);
}

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
      if (total > MAX_DOC_BYTES) throw new HttpError(413, 'VALIDATION', 'doc too large');
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export function logImportRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post('/text', requireRole('ADMIN'), validateBody(TextImportInput), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof TextImportInput>;
    const result = await runImport(prisma, body.text, body.netId, body.dryRun ?? false);
    res.json(result);
  }));

  router.post('/url', requireRole('ADMIN'), validateBody(UrlImportInput), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof UrlImportInput>;
    const parsed = await assertPublicUrl(body.url);
    const target = rewriteGoogleDocsToTxt(parsed);
    const remote = await fetch(target.toString(), {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'HamNetAssistant/1.0',
        'Accept': 'text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.6',
      },
    });
    if (!remote.ok) throw new HttpError(400, 'VALIDATION', `remote returned ${remote.status}`);
    const ct = (remote.headers.get('content-type') ?? '').toLowerCase();
    const buf = await readBoundedBody(remote);
    let text: string;
    if (ct.includes('text/plain') || ct.includes('text/markdown') || target.pathname.endsWith('.txt') || target.pathname.endsWith('.md')) {
      text = buf.toString('utf8');
    } else if (ct.includes('wordprocessingml.document') || target.pathname.endsWith('.docx')) {
      const html = await mammoth.extractRawText({ buffer: buf });
      text = html.value;
    } else if (ct.includes('text/html')) {
      // Strip tags for HTML responses (Google Docs published-to-web returns HTML)
      text = buf.toString('utf8')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n');
    } else {
      throw new HttpError(415, 'VALIDATION', `unsupported content-type: ${ct || 'unknown'}`);
    }
    const result = await runImport(prisma, text, body.netId, body.dryRun ?? false);
    res.json(result);
  }));

  return router;
}

interface ImportSummary {
  parsed: ParsedSession[];
  errors: Array<{ block: string; reason: string }>;
  created: number;
  skipped: Array<{ rawDateLine: string; reason: string }>;
  sessionIds: string[];
}

async function runImport(
  prisma: PrismaClient,
  text: string,
  netId: string,
  dryRun: boolean,
): Promise<ImportSummary> {
  const netRow = await prisma.net.findUnique({ where: { id: netId } });
  if (!netRow) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
  const { sessions, errors } = parseLogText(text);
  if (dryRun) {
    return { parsed: sessions, errors, created: 0, skipped: [], sessionIds: [] };
  }
  const skipped: ImportSummary['skipped'] = [];
  const sessionIds: string[] = [];
  const seenInBatch = new Set<string>();

  for (const s of sessions) {
    // Check for duplicate within this import batch
    const dayKey = `${netId}|${s.date.getFullYear()}-${String(s.date.getMonth() + 1).padStart(2, '0')}-${String(s.date.getDate()).padStart(2, '0')}`;
    if (seenInBatch.has(dayKey)) {
      skipped.push({ rawDateLine: s.rawDateLine, reason: 'duplicate within import (same date)' });
      continue;
    }
    seenInBatch.add(dayKey);

    // Skip duplicates: a session for this net on the same calendar date already exists.
    const dayStart = new Date(s.date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(s.date); dayEnd.setHours(23, 59, 59, 999);
    const existing = await prisma.netSession.findFirst({
      where: {
        netId,
        deletedAt: null,
        startedAt: { gte: dayStart, lte: dayEnd },
      },
    });
    if (existing) {
      skipped.push({ rawDateLine: s.rawDateLine, reason: 'session already exists for this date' });
      continue;
    }
    // Resolve control op
    let controlOpId: string | null = null;
    if (s.controlOp) {
      const ctrl = await prisma.user.findFirst({
        where: { callsign: s.controlOp.callsign },
        orderBy: { createdAt: 'asc' },
      });
      controlOpId = ctrl?.id ?? null;
    }
    const ended = new Date(s.date.getTime() + 60 * 60 * 1000); // +1h placeholder
    // Compose session notes from trailing date prose + any backup operators.
    let notesSuffix = '';
    if (s.notes) notesSuffix += s.notes;
    if (s.backups.length) {
      const list = s.backups
        .map((b) => (b.name && b.name.trim() ? `${b.name.trim()} ${b.callsign}` : b.callsign))
        .join(', ');
      notesSuffix += (notesSuffix ? ' | ' : '') + `Backups: ${list}`;
    }
    const finalNotes = notesSuffix || 'Imported from log';
    const created = await prisma.netSession.create({
      data: {
        netId,
        startedAt: s.date,
        endedAt: ended,
        controlOpId,
        topicTitle: s.topic,
        notes: finalNotes,
      },
    });
    // CheckIns
    for (let i = 0; i < s.checkIns.length; i++) {
      const ci = s.checkIns[i]!;
      const userMatch = await prisma.user.findFirst({
        where: { callsign: ci.callsign },
        orderBy: { createdAt: 'asc' },
      });
      const checkedInAt = new Date(s.date.getTime() + (i + 1) * 1000);
      // `nameAtCheckIn` is non-null in the schema; fall back to the callsign
      // when the doc didn't record a name for this check-in.
      const nameAtCheckIn = ci.name && ci.name.trim() ? ci.name.trim() : ci.callsign;
      await prisma.checkIn.create({
        data: {
          sessionId: created.id,
          callsign: ci.callsign,
          nameAtCheckIn,
          checkedInAt,
          userId: userMatch?.id ?? null,
          createdById: null,
        },
      });
    }
    sessionIds.push(created.id);
  }
  return {
    parsed: sessions,
    errors,
    created: sessionIds.length,
    skipped,
    sessionIds,
  };
}
