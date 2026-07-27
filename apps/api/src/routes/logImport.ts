import { Router } from 'express';
import { z } from 'zod';
import mammoth from 'mammoth';
import { PrismaClient } from '@prisma/client';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { validateBody } from '../middleware/validate.js';
import { parseLogText, type ParsedSession } from '../lib/parseLog.js';
import { enrichEmptyNames } from '../lib/callsignNameLookup.js';
import { safeFetch } from '../lib/safeFetch.js';

const TextImportInput = z.object({
  text: z.string().min(1).max(200_000),
  netId: z.string().min(1),
  dryRun: z.boolean().optional(),
  enrichNames: z.boolean().optional(),
});

const UrlImportInput = z.object({
  url: z.string().url().max(2000),
  netId: z.string().min(1),
  dryRun: z.boolean().optional(),
  enrichNames: z.boolean().optional(),
});

const MAX_DOC_BYTES = 4 * 1024 * 1024;

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
    const result = await runImport(prisma, body.text, body.netId, body.dryRun ?? false, body.enrichNames ?? true);
    res.json(result);
  }));

  router.post('/url', requireRole('ADMIN'), validateBody(UrlImportInput), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof UrlImportInput>;
    let submitted: URL;
    try {
      submitted = new URL(body.url);
    } catch {
      throw new HttpError(400, 'VALIDATION', 'Invalid URL');
    }
    const target = rewriteGoogleDocsToTxt(submitted);
    // safeFetch owns the SSRF guard (this route used to carry a weaker private
    // copy of it) and re-validates every redirect hop.
    const { response: remote, finalUrl } = await safeFetch(target, {
      timeoutMs: 10000,
      headers: {
        'User-Agent': 'HamNetAssistant/1.0',
        'Accept': 'text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.6',
      },
    });
    if (!remote.ok) throw new HttpError(400, 'VALIDATION', `remote returned ${remote.status}`);
    const ct = (remote.headers.get('content-type') ?? '').toLowerCase();
    const buf = await readBoundedBody(remote);
    let text: string;
    if (ct.includes('text/plain') || ct.includes('text/markdown') || finalUrl.pathname.endsWith('.txt') || finalUrl.pathname.endsWith('.md')) {
      text = buf.toString('utf8');
    } else if (ct.includes('wordprocessingml.document') || finalUrl.pathname.endsWith('.docx')) {
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
    const result = await runImport(prisma, text, body.netId, body.dryRun ?? false, body.enrichNames ?? true);
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
  enriched: number;
}

async function runImport(
  prisma: PrismaClient,
  text: string,
  netId: string,
  dryRun: boolean,
  enrichNames: boolean,
): Promise<ImportSummary> {
  const netRow = await prisma.net.findUnique({ where: { id: netId } });
  if (!netRow) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
  const { sessions, errors } = parseLogText(text);
  // Shared lookup cache across all sessions for this import.
  const nameCache = new Map<string, string | null>();
  let totalEnriched = 0;
  if (enrichNames) {
    for (const s of sessions) {
      const r = await enrichEmptyNames(prisma, s.checkIns, { cache: nameCache });
      totalEnriched += r.lookedUp;
      if (s.controlOp && (!s.controlOp.name || !s.controlOp.name.trim())) {
        const r2 = await enrichEmptyNames(
          prisma,
          [{ callsign: s.controlOp.callsign, name: '' }],
          { cache: nameCache },
        );
        const co = r2.items[0]!;
        if (co.name) {
          s.controlOp.name = co.name;
          totalEnriched += r2.lookedUp;
        }
      }
      if (s.backups.length) {
        const r3 = await enrichEmptyNames(prisma, s.backups, { cache: nameCache });
        totalEnriched += r3.lookedUp;
      }
    }
  }
  if (dryRun) {
    return { parsed: sessions, errors, created: 0, skipped: [], sessionIds: [], enriched: totalEnriched };
  }
  // Resolve every callsign -> local user once, up front. Doing this inside the
  // write transaction would multiply the time the SQLite write lock is held by
  // the number of check-ins in the file, for reads that cannot change while we
  // are importing.
  const userIdByCallsign = await resolveUsersByCallsign(prisma, sessions);

  // All-or-nothing. Without the transaction, a process death partway through
  // (OOM kill, container restart) left a NetSession row with only some of its
  // check-ins — and because the dedupe check below matches on "a session for
  // this net already exists on this date", re-running the import skipped the
  // torn session forever instead of repairing it.
  const { skipped, sessionIds } = await prisma.$transaction(
    async (tx) => {
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
        const existing = await tx.netSession.findFirst({
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
        const controlOpId = s.controlOp
          ? (userIdByCallsign.get(s.controlOp.callsign) ?? null)
          : null;
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
        const created = await tx.netSession.create({
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
          const checkedInAt = new Date(s.date.getTime() + (i + 1) * 1000);
          // `nameAtCheckIn` is non-null in the schema; fall back to the callsign
          // when the doc didn't record a name for this check-in.
          const nameAtCheckIn = ci.name && ci.name.trim() ? ci.name.trim() : ci.callsign;
          await tx.checkIn.create({
            data: {
              sessionId: created.id,
              callsign: ci.callsign,
              nameAtCheckIn,
              checkedInAt,
              userId: userIdByCallsign.get(ci.callsign) ?? null,
              createdById: null,
            },
          });
        }
        sessionIds.push(created.id);
      }
      return { skipped, sessionIds };
    },
    {
      // Explicit budget: the 5s Prisma default is a club-year-sized log away
      // from aborting a legitimate import (each check-in is its own INSERT).
      // maxWait covers a concurrent writer holding the SQLite lock at start.
      maxWait: 10_000,
      timeout: 120_000,
    },
  );

  return {
    parsed: sessions,
    errors,
    created: sessionIds.length,
    skipped,
    sessionIds,
    enriched: totalEnriched,
  };
}

/**
 * Map every callsign mentioned in the parsed log to the local user account that
 * owns it. Callsigns are not unique in the User table (see the
 * drop_user_callsign_unique migration), so oldest-account-wins — the same rule
 * the per-row findFirst({ orderBy: createdAt asc }) used to apply.
 */
async function resolveUsersByCallsign(
  prisma: PrismaClient,
  sessions: ParsedSession[],
): Promise<Map<string, string>> {
  const callsigns = new Set<string>();
  for (const s of sessions) {
    if (s.controlOp) callsigns.add(s.controlOp.callsign);
    for (const ci of s.checkIns) callsigns.add(ci.callsign);
  }
  if (callsigns.size === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { callsign: { in: [...callsigns] } },
    select: { id: true, callsign: true },
    orderBy: { createdAt: 'asc' },
  });
  const map = new Map<string, string>();
  for (const u of users) {
    if (!map.has(u.callsign)) map.set(u.callsign, u.id);
  }
  return map;
}
