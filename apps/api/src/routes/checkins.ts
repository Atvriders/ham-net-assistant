import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { CheckInInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';

export function checkinsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  nested.post('/', requireAuth, validateBody(CheckInInput), asyncHandler(async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await prisma.netSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    if (session.endedAt) throw new HttpError(409, 'CONFLICT', 'Session already ended');
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
      },
    });
    res.status(201).json(created);
  }));

  flat.get('/callsign-history/:callsign', requireAuth, asyncHandler(async (req, res) => {
    const callsign = String(req.params.callsign ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9/]{3,10}$/.test(callsign)) {
      throw new HttpError(400, 'VALIDATION', 'Invalid callsign');
    }
    const last = await prisma.checkIn.findFirst({
      where: { callsign },
      orderBy: { checkedInAt: 'desc' },
      select: { nameAtCheckIn: true },
    });
    res.json({ callsign, name: last?.nameAtCheckIn ?? null });
  }));

  flat.patch('/:id', requireAuth, validateBody(CheckInInput), asyncHandler(async (req, res) => {
    const ci = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
    if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    const me = req.user!;
    const isOfficer = me.role === 'OFFICER' || me.role === 'ADMIN';
    const ownRecent =
      ci.createdById === me.id && Date.now() - ci.checkedInAt.getTime() < 5 * 60 * 1000;
    if (!isOfficer && !ownRecent) {
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
        comment: body.comment ?? null,
        userId: matched?.id ?? null,
      },
    });
    res.json(updated);
  }));

  flat.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    const ci = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
    if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    const me = req.user!;
    const isOfficer = me.role === 'OFFICER' || me.role === 'ADMIN';
    const ownRecent =
      ci.createdById === me.id && Date.now() - ci.checkedInAt.getTime() < 5 * 60 * 1000;
    if (!isOfficer && !ownRecent) {
      throw new HttpError(403, 'FORBIDDEN', 'Cannot delete this check-in');
    }
    await prisma.checkIn.delete({ where: { id: ci.id } });
    res.status(204).end();
  }));

  return { nested, flat };
}
