import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { CheckInInput, roleAtLeast } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { withCheckInMode } from '../lib/checkinMode.js';

export function checkinsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  nested.post('/', requireAuth, validateBody(CheckInInput), asyncHandler(async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await prisma.netSession.findFirst({
      where: { id: sessionId, deletedAt: null },
    });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    if (session.endedAt) throw new HttpError(409, 'CONFLICT', 'Session already ended');
    // PREP gate: the net has been opened but not yet started — check-ins must
    // wait for the control op to press START NET.
    if (!session.liveAt) {
      throw new HttpError(
        409,
        'CONFLICT',
        'Net is preparing — wait for the control op to start it',
      );
    }
    const body = req.body as typeof CheckInInput._type;
    const matched = await prisma.user.findFirst({
      where: { callsign: body.callsign },
      orderBy: { createdAt: 'asc' },
    });
    const created = await prisma.checkIn.create({
      data: {
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

  flat.patch('/:id', requireAuth, validateBody(CheckInInput), asyncHandler(async (req, res) => {
    const ci = await prisma.checkIn.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    const me = req.user!;
    // Net Control (and above) can edit any check-in while running the net;
    // everyone else is limited to their own entry within a 5-minute window.
    const canManage = roleAtLeast(me.role, 'NET_CONTROL');
    const ownRecent =
      ci.createdById === me.id && Date.now() - ci.checkedInAt.getTime() < 5 * 60 * 1000;
    if (!canManage && !ownRecent) {
      throw new HttpError(403, 'FORBIDDEN', 'Cannot edit this check-in');
    }
    const body = req.body as typeof CheckInInput._type;
    // If the new callsign maps to a registered member, relink userId;
    // otherwise clear userId (it's now a visitor entry).
    const matched = await prisma.user.findFirst({
      where: { callsign: body.callsign },
      orderBy: { createdAt: 'asc' },
    });
    const updated = await prisma.checkIn.update({
      where: { id: ci.id },
      data: {
        callsign: body.callsign,
        nameAtCheckIn: body.nameAtCheckIn,
        comment: body.comment === undefined ? undefined : body.comment,
        userId: matched?.id ?? null,
        // Preserve-on-omit: undefined leaves the existing mode unchanged so
        // officers fixing a name don't accidentally clobber the participation
        // method recorded at check-in time.
        mode: body.mode === undefined ? undefined : body.mode,
      },
    });
    res.json(withCheckInMode(updated));
  }));

  flat.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    const ci = await prisma.checkIn.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    const me = req.user!;
    // Net Control (and above) can delete any check-in while running the net;
    // everyone else is limited to their own entry within a 5-minute window.
    const canManage = roleAtLeast(me.role, 'NET_CONTROL');
    const ownRecent =
      ci.createdById === me.id && Date.now() - ci.checkedInAt.getTime() < 5 * 60 * 1000;
    if (!canManage && !ownRecent) {
      throw new HttpError(403, 'FORBIDDEN', 'Cannot delete this check-in');
    }
    await prisma.checkIn.update({
      where: { id: ci.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  }));

  return { nested, flat };
}
