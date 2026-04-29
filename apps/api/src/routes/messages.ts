import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { MessageInput } from '@hna/shared';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { postToDiscord } from '../discord/client.js';

export function messagesRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  // GET /api/sessions/:sessionId/messages
  nested.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const rows = await prisma.sessionMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    res.json(rows);
  }));

  // POST /api/sessions/:sessionId/messages
  nested.post('/', requireAuth, validateBody(MessageInput), asyncHandler(async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await prisma.netSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
    const body = req.body as typeof MessageInput._type;
    const created = await prisma.sessionMessage.create({
      data: {
        sessionId,
        userId: user.id,
        callsign: user.callsign,
        nameAtMessage: user.name,
        body: body.body,
      },
    });
    res.status(201).json(created);
    // Fire-and-forget mirror to Discord; never blocks or throws back to client.
    void (async () => {
      try {
        const liveSession = await prisma.netSession.findUnique({ where: { id: sessionId } });
        if (!liveSession || liveSession.endedAt) return;
        const id = await postToDiscord(
          prisma,
          `**${user.callsign}** (${user.name}): ${created.body}`,
        );
        if (id) {
          await prisma.discordRelay.create({
            data: { discordMessageId: id, sessionMessageId: created.id, direction: 'out' },
          });
        }
      } catch { /* ignore */ }
    })();
  }));

  // DELETE /api/messages/:id  (own within 5min, or officer/admin)
  flat.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    const msg = await prisma.sessionMessage.findUnique({ where: { id: req.params.id } });
    if (!msg) throw new HttpError(404, 'NOT_FOUND', 'Message not found');
    const me = req.user!;
    const isOfficer = me.role === 'OFFICER' || me.role === 'ADMIN';
    const ownRecent = msg.userId === me.id
      && Date.now() - msg.createdAt.getTime() < 5 * 60 * 1000;
    if (!isOfficer && !ownRecent) {
      throw new HttpError(403, 'FORBIDDEN', 'Cannot delete this message');
    }
    await prisma.sessionMessage.delete({ where: { id: msg.id } });
    res.status(204).end();
  }));

  return { nested, flat };
}
