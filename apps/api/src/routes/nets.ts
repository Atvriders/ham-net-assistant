import { Router } from 'express';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  NetInput,
  NetUpdate,
  DEFAULT_REMINDER_MINUTES,
  parseReminderMinutes,
} from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { redactScriptsForRole } from '../lib/scriptGate.js';
import { withCheckInMode } from '../lib/checkinMode.js';
import { CHECKIN_LOG_ORDER_DESC } from '../lib/checkInOrder.js';

const netInclude = {
  repeater: true,
  links: { include: { repeater: true } },
} as const;

/**
 * Hydrate the JSON-encoded `reminderMinutes` column on a net (or list of
 * nets) into a `number[]` before returning to the client.
 */
function hydrateReminderMinutes<T extends { reminderMinutes?: string | null }>(
  row: T,
): Omit<T, 'reminderMinutes'> & { reminderMinutes: number[] } {
  const { reminderMinutes, ...rest } = row;
  return {
    ...rest,
    reminderMinutes: parseReminderMinutes(reminderMinutes),
  } as Omit<T, 'reminderMinutes'> & { reminderMinutes: number[] };
}

function hydrateMany<T extends { reminderMinutes?: string | null }>(rows: T[]) {
  return rows.map(hydrateReminderMinutes);
}

/**
 * Serialize a parsed/zod-cleaned reminderMinutes value for storage. Returns
 * the canonical JSON string, or `null` if the caller passed nothing (which
 * the API translates to "leave default"; the DB column already has a default
 * for fresh inserts via Prisma).
 */
function serializeReminderMinutes(value: number[] | undefined): string {
  const arr = value ?? [...DEFAULT_REMINDER_MINUTES];
  return JSON.stringify(arr);
}

/**
 * Query for the run-net console's tap-to-fill suggestions. `limit` arrives as
 * a string on the query string, so coerce before range-checking. Out of range
 * is a 400 rather than a silent clamp: a console asking for 500 suggestions is
 * a client bug, and quietly serving it 30 hides the bug while a 400 names it.
 */
const RecentCheckInsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(12),
});

interface RecentCheckIn {
  callsign: string;
  name: string;
  lastCheckedInAt: string;
  count: number;
}

function normalizeLinkedIds(
  linkedRepeaterIds: string[] | undefined,
  primaryRepeaterId: string,
): string[] {
  if (!linkedRepeaterIds) return [];
  const deduped = Array.from(new Set(linkedRepeaterIds));
  return deduped.filter((id) => id !== primaryRepeaterId);
}

async function assertRepeatersExist(prisma: PrismaClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await prisma.repeater.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    throw new HttpError(400, 'VALIDATION', 'Unknown repeater in linkedRepeaterIds');
  }
}

/**
 * Validate the net's PRIMARY repeaterId. Only the linked ids used to be
 * checked, so a bad primary fell through to Prisma: create blew up as a 500
 * INTERNAL, and update surfaced as "Net not found" — a 404 about the wrong
 * object, for a net that plainly exists. Officers hit this whenever a repeater
 * was deleted in another tab.
 */
async function assertPrimaryRepeaterExists(prisma: PrismaClient, id: string): Promise<void> {
  const found = await prisma.repeater.findUnique({ where: { id }, select: { id: true } });
  if (!found) {
    throw new HttpError(400, 'VALIDATION', `Unknown repeater: ${id}`);
  }
}

/** True for the Prisma "record required but not found" error (P2025). */
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';
}

/**
 * Resolve scheduling fields from the create/update payload. Weekly nets use the
 * supplied values; impromptu nets fall back to sentinels since the scheduler
 * never touches them.
 */
function schedulingFields(body: z.infer<typeof NetInput>): {
  kind: string;
  dayOfWeek: number;
  startLocal: string;
  timezone: string;
} {
  const kind = body.kind ?? 'weekly';
  if (kind === 'impromptu') {
    return {
      kind,
      dayOfWeek: body.dayOfWeek ?? 0,
      startLocal: body.startLocal ?? '00:00',
      timezone: body.timezone ?? 'UTC',
    };
  }
  return {
    kind,
    dayOfWeek: body.dayOfWeek as number,
    startLocal: body.startLocal as string,
    timezone: body.timezone as string,
  };
}

export function netsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const list = await prisma.net.findMany({
      orderBy: [{ dayOfWeek: 'asc' }, { startLocal: 'asc' }],
      include: netInclude,
    });
    redactScriptsForRole(list, req.user?.role);
    res.json(hydrateMany(list));
  }));

  // Must be registered before `/:id`-style routes.
  router.get('/active', requireAuth, asyncHandler(async (req, res) => {
    const sessions = await prisma.netSession.findMany({
      where: { endedAt: null, deletedAt: null },
      include: {
        topic: true,
        net: { include: { repeater: true } },
      },
      orderBy: { startedAt: 'desc' },
    });
    redactScriptsForRole(sessions, req.user?.role);
    // Hydrate the embedded net's reminderMinutes for each session.
    const out = sessions.map((s) => ({
      ...s,
      net: hydrateReminderMinutes(s.net),
    }));
    res.json(out);
  }));

  router.get('/:netId/active-session', requireAuth, asyncHandler(async (req, res) => {
    const s = await prisma.netSession.findFirst({
      where: { netId: req.params.netId, endedAt: null, deletedAt: null },
      include: {
        topic: true,
        net: { include: { repeater: true, links: { include: { repeater: true } } } },
        checkIns: { where: { deletedAt: null }, orderBy: CHECKIN_LOG_ORDER_DESC },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'No active session for this net');
    redactScriptsForRole(s, req.user?.role);
    res.json({
      ...s,
      net: hydrateReminderMinutes(s.net),
      checkIns: s.checkIns.map((ci) => withCheckInMode(ci)),
    });
  }));

  /**
   * Tap-to-fill suggestions for the run-net console: the operators who
   * actually check into THIS net, so a control op on a phone picks a callsign
   * instead of thumb-typing one mid-net.
   *
   * NET_CONTROL, deliberately not OFFICER. This is run-the-net data, and
   * OFFICER would lock out the exact role that exists to run nets — the
   * operators who are the only users this endpoint is for.
   */
  router.get('/:netId/recent-checkins', requireRole('NET_CONTROL'), asyncHandler(async (req, res) => {
    const parsed = RecentCheckInsQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION', 'Invalid limit (expected 1-30)');
    }
    const netId = req.params.netId as string;
    // Distinguish "net has no check-ins yet" (200 []) from "no such net"
    // (404), same as the mutating siblings below: an empty list for a typo'd
    // id reads as a working console with a quiet net.
    const net = await prisma.net.findUnique({ where: { id: netId }, select: { id: true } });
    if (!net) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    // One query for the net's whole live check-in history, newest first, then
    // group in memory: the first row seen for a callsign IS its most recent,
    // which is where `name` has to come from (names change; the latest is the
    // best guess) and `count` needs every row anyway. A groupBy would yield
    // count + max(checkedInAt) but not the name attached to that max, and
    // resolving it afterwards is one extra query per suggestion — on a route
    // the console hits on every load.
    const rows = await prisma.checkIn.findMany({
      where: { deletedAt: null, session: { netId, deletedAt: null } },
      select: { callsign: true, nameAtCheckIn: true, checkedInAt: true },
      // id is a tiebreaker so rows written inside the same millisecond keep a
      // stable order across loads (cuid ids are monotonic within a process),
      // which is what makes "the first row wins" a deterministic name pick.
      orderBy: [{ checkedInAt: 'desc' }, { id: 'desc' }],
    });
    const byCallsign = new Map<string, RecentCheckIn>();
    for (const ci of rows) {
      const seen = byCallsign.get(ci.callsign);
      if (seen) {
        seen.count += 1;
        continue;
      }
      byCallsign.set(ci.callsign, {
        callsign: ci.callsign,
        name: ci.nameAtCheckIn,
        lastCheckedInAt: ci.checkedInAt.toISOString(),
        count: 1,
      });
    }
    // Map iteration is insertion order, which is already the most-recent-first
    // order the rows arrived in — no re-sort needed before the take.
    res.json(Array.from(byCallsign.values()).slice(0, parsed.data.limit));
  }));

  router.post('/', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof NetInput>;
    const linkIds = normalizeLinkedIds(body.linkedRepeaterIds, body.repeaterId);
    await assertPrimaryRepeaterExists(prisma, body.repeaterId);
    await assertRepeatersExist(prisma, linkIds);
    const sched = schedulingFields(body);
    const created = await prisma.$transaction(async (tx) => {
      const net = await tx.net.create({
        data: {
          name: body.name, repeaterId: body.repeaterId,
          kind: sched.kind,
          dayOfWeek: sched.dayOfWeek, startLocal: sched.startLocal,
          timezone: sched.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
          scriptCategory: body.scriptCategory ?? 'general',
          reminderMinutes: serializeReminderMinutes(body.reminderMinutes),
          active: body.active ?? true,
        },
      });
      if (linkIds.length) {
        await tx.netLink.createMany({
          data: linkIds.map((repeaterId) => ({ netId: net.id, repeaterId })),
        });
      }
      return tx.net.findUniqueOrThrow({ where: { id: net.id }, include: netInclude });
    });
    res.status(201).json(hydrateReminderMinutes(created));
  }));

  router.patch('/:id', requireRole('OFFICER'), validateBody(NetUpdate), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof NetUpdate>;
    const netId = req.params.id as string;
    const existing = await prisma.net.findUnique({ where: { id: netId } });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    const touchLinks = body.linkedRepeaterIds !== undefined;
    // For link normalization use the new primaryRepeaterId if the caller
    // supplied one, otherwise fall back to the existing row's repeaterId so
    // the primary is correctly excluded from the link set.
    const primaryRepeaterId = body.repeaterId ?? existing.repeaterId;
    const linkIds = touchLinks
      ? normalizeLinkedIds(body.linkedRepeaterIds, primaryRepeaterId)
      : [];
    if (body.repeaterId !== undefined) {
      await assertPrimaryRepeaterExists(prisma, body.repeaterId);
    }
    if (touchLinks) await assertRepeatersExist(prisma, linkIds);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Build a sparse update so columns the caller did not supply are
        // left untouched (matches typical PATCH semantics).
        const data: Record<string, unknown> = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.repeaterId !== undefined ? { repeaterId: body.repeaterId } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.dayOfWeek !== undefined ? { dayOfWeek: body.dayOfWeek } : {}),
          ...(body.startLocal !== undefined ? { startLocal: body.startLocal } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
          ...(body.theme !== undefined ? { theme: body.theme } : {}),
          ...(body.scriptMd !== undefined ? { scriptMd: body.scriptMd } : {}),
          ...(body.scriptCategory !== undefined ? { scriptCategory: body.scriptCategory } : {}),
          ...(body.reminderMinutes !== undefined
            ? { reminderMinutes: JSON.stringify(body.reminderMinutes) }
            : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        };
        if (Object.keys(data).length > 0) {
          await tx.net.update({ where: { id: netId }, data });
        }
        if (touchLinks) {
          await tx.netLink.deleteMany({ where: { netId: netId } });
          if (linkIds.length) {
            await tx.netLink.createMany({
              data: linkIds.map((repeaterId) => ({ netId: netId, repeaterId })),
            });
          }
        }
        return tx.net.findUniqueOrThrow({ where: { id: netId }, include: netInclude });
      });
      res.json(hydrateReminderMinutes(updated));
    } catch (e) {
      // Only a genuinely missing row becomes a 404. The blanket catch that
      // used to live here reported every failure in this transaction — a bad
      // FK, a constraint violation, a dropped DB connection — as "Net not
      // found", which sent officers hunting for a net that was right there.
      if (isRecordNotFound(e)) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
      throw e;
    }
  }));

  router.delete('/:id', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    try {
      await prisma.net.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (e) {
      if (isRecordNotFound(e)) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
      throw e;
    }
  }));

  return router;
}
