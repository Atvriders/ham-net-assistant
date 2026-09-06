import { Router } from 'express';
import type { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { CheckInInput, roleAtLeast } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, type AuthUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { withCheckInMode } from '../lib/checkinMode.js';

/**
 * How long a plain member may keep correcting their own check-in. Past this,
 * only NET_CONTROL and above can touch the row — the log is the club's record
 * of who was on the air, not a scratchpad.
 */
const MEMBER_EDIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * PATCH body. `CheckInInput` (used by POST) requires callsign + nameAtCheckIn;
 * PATCH accepts any subset and merges it onto the stored row, matching the
 * partial-update semantics of /nets and /users. Full-body PATCHes from the
 * current web client keep working unchanged.
 */
const CheckInPatch = CheckInInput.partial();

/**
 * Load a live check-in and authorize `me` to change it, or throw.
 *
 * Net Control and above may fix any row, including one on a finished net — the
 * Stats page's log-correction flow depends on that. A plain member gets a
 * deliberately narrow window: their own entry, inside MEMBER_EDIT_WINDOW_MS,
 * and only while the net is still running. Without the ended-session check a
 * member who checked in during the last minutes of a net could still rewrite
 * or delete their line out of a log the control op had already closed.
 */
async function loadEditableCheckIn(
  prisma: PrismaClient,
  id: string,
  me: AuthUser,
  action: 'edit' | 'delete',
) {
  const ci = await prisma.checkIn.findFirst({
    where: { id, deletedAt: null },
    include: { session: { select: { endedAt: true } } },
  });
  if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
  if (roleAtLeast(me.role, 'NET_CONTROL')) return ci;
  const ownRecent =
    ci.createdById === me.id
    && Date.now() - ci.checkedInAt.getTime() < MEMBER_EDIT_WINDOW_MS;
  if (!ownRecent) {
    throw new HttpError(403, 'FORBIDDEN', `Cannot ${action} this check-in`);
  }
  if (ci.session.endedAt) {
    throw new HttpError(
      403,
      'FORBIDDEN',
      `Cannot ${action} a check-in once the net has ended`,
    );
  }
  return ci;
}

export function checkinsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  nested.post('/', requireAuth, validateBody(CheckInInput), asyncHandler(async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await prisma.netSession.findFirst({
      where: { id: sessionId, deletedAt: null },
    });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    if (session.endedAt) {
      // A finished log is still correctable — a station heard on the air but
      // missed at the time has to be enterable afterwards, or the record is
      // simply wrong. Reserved to the people who run nets: an ended session is
      // the club's archived record, not a form anyone may still post to. The
      // entry's checkedInAt is the real time it was typed, so the log always
      // shows that it was added after the net closed.
      if (!req.user || !roleAtLeast(req.user.role, 'NET_CONTROL')) {
        throw new HttpError(
          409,
          'CONFLICT',
          'This net has ended. Ask a net control operator or officer to add a missed station.',
        );
      }
    }
    // PREP gate: the net has been opened but not yet started — check-ins must
    // wait for the control op to press START NET.
    if (!session.liveAt) {
      throw new HttpError(
        409,
        'CONFLICT',
        'Net is preparing — wait for the control op to start it',
      );
    }
    const body = req.body as z.infer<typeof CheckInInput>;
    const matched = await prisma.user.findFirst({
      where: { callsign: body.callsign },
      orderBy: { createdAt: 'asc' },
    });
    // Append to the end of the log. Computed rather than counted so a session
    // whose rows were reordered (or partly soft-deleted) still gets a position
    // after every existing one instead of colliding with a used number.
    const highest = await prisma.checkIn.aggregate({
      where: { sessionId, deletedAt: null },
      _max: { sequence: true },
    });
    const nextSequence = (highest._max.sequence ?? 0) + 1;
    const created = await prisma.checkIn.create({
      data: {
        sequence: nextSequence,
        sessionId, callsign: body.callsign, nameAtCheckIn: body.nameAtCheckIn,
        comment: body.comment ?? null, userId: matched?.id ?? null,
        createdById: req.user!.id,
        // Mode defaults to 'rf' when omitted — keeps existing clients on the
        // FCC-friendly default and only records the variant when supplied.
        mode: body.mode ?? 'rf',
      },
    });
    res.status(201).json(withCheckInMode(created));
  }));

  flat.get('/callsign-history/:callsign', requireAuth, asyncHandler(async (req, res) => {
    const callsign = String(req.params.callsign ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9/]{3,10}$/.test(callsign)) {
      throw new HttpError(400, 'VALIDATION', 'Invalid callsign');
    }
    const last = await prisma.checkIn.findFirst({
      where: { callsign, deletedAt: null },
      orderBy: { checkedInAt: 'desc' },
      select: { nameAtCheckIn: true },
    });
    res.json({ callsign, name: last?.nameAtCheckIn ?? null });
  }));

  flat.patch('/:id', requireAuth, validateBody(CheckInPatch), asyncHandler(async (req, res) => {
    const ci = await loadEditableCheckIn(prisma, req.params.id as string, req.user!, 'edit');
    const body = req.body as z.infer<typeof CheckInPatch>;
    // Resolve the member link from the supplied callsign: if it maps to a
    // registered member, point at them; otherwise clear it (the row is a
    // visitor entry). A partial PATCH that omits callsign leaves the link
    // exactly as it was rather than re-deriving it from a field the caller
    // never mentioned.
    let userId: string | null | undefined;
    if (body.callsign !== undefined) {
      const matched = await prisma.user.findFirst({
        where: { callsign: body.callsign },
        orderBy: { createdAt: 'asc' },
      });
      userId = matched?.id ?? null;
    }
    const updated = await prisma.checkIn.update({
      where: { id: ci.id },
      data: {
        // Preserve-on-omit throughout: undefined leaves the stored value in
        // place, so a caller sending only `mode` doesn't blank the name (and an
        // officer fixing a name doesn't clobber the participation method
        // recorded at check-in time).
        callsign: body.callsign,
        nameAtCheckIn: body.nameAtCheckIn,
        comment: body.comment,
        userId,
        mode: body.mode,
      },
    });
    res.json(withCheckInMode(updated));
  }));

  flat.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    const ci = await loadEditableCheckIn(prisma, req.params.id as string, req.user!, 'delete');
    await prisma.checkIn.update({
      where: { id: ci.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  }));

  return { nested, flat };
}
