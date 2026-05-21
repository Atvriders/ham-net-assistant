import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  NetInput,
  DEFAULT_REMINDER_MINUTES,
  parseReminderMinutes,
} from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { redactScriptsForRole } from '../lib/scriptGate.js';

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
 * Resolve scheduling fields from the create/update payload. Weekly nets use the
 * supplied values; impromptu nets fall back to sentinels since the scheduler
 * never touches them.
 */
function schedulingFields(body: typeof NetInput._type): {
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
        checkIns: { where: { deletedAt: null }, orderBy: { checkedInAt: 'desc' } },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'No active session for this net');
    redactScriptsForRole(s, req.user?.role);
    res.json({ ...s, net: hydrateReminderMinutes(s.net) });
  }));

  router.post('/', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetInput._type;
    const linkIds = normalizeLinkedIds(body.linkedRepeaterIds, body.repeaterId);
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

  router.patch('/:id', requireRole('OFFICER'), validateBody(NetInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof NetInput._type;
    const netId = req.params.id as string;
    const existing = await prisma.net.findUnique({ where: { id: netId } });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    const touchLinks = body.linkedRepeaterIds !== undefined;
    const linkIds = touchLinks
      ? normalizeLinkedIds(body.linkedRepeaterIds, body.repeaterId)
      : [];
    if (touchLinks) await assertRepeatersExist(prisma, linkIds);
    const sched = schedulingFields(body);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Only touch reminderMinutes when the caller actually supplied it,
        // so a PATCH that omits it leaves the stored value alone.
        const reminderUpdate =
          body.reminderMinutes !== undefined
            ? { reminderMinutes: JSON.stringify(body.reminderMinutes) }
            : {};
        await tx.net.update({
          where: { id: netId },
          data: {
            name: body.name, repeaterId: body.repeaterId,
            kind: sched.kind,
            dayOfWeek: sched.dayOfWeek, startLocal: sched.startLocal,
            timezone: sched.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
            scriptCategory: body.scriptCategory ?? 'general',
            ...reminderUpdate,
            active: body.active ?? true,
          },
        });
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
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    }
  }));

  router.delete('/:id', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    try {
      await prisma.net.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    }
  }));

  return router;
}
