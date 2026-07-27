import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { PRESENCE_ONLINE_WINDOW_MS } from '@hna/shared';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';

/**
 * Lightweight presence: the web client pings `POST /heartbeat` every ~45s while
 * the user is authenticated and the tab is open. A user is "online" if their
 * `lastSeenAt` is within PRESENCE_ONLINE_WINDOW_MS.
 */
export function presenceRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post('/heartbeat', requireAuth, asyncHandler(async (req, res) => {
    const now = new Date();
    try {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { lastSeenAt: now },
      });
    } catch (e) {
      // The account was deleted between loadUser's lookup and this write.
      // Prisma raises P2025 ("record not found"), which used to surface as a
      // 500 every 45 seconds for as long as the tab stayed open — an endless
      // error log and no signal to the client. Answer like /auth/me does so
      // the SPA can drop its stale session.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
      }
      throw e;
    }
    res.json({ ok: true, lastSeenAt: now.toISOString() });
  }));

  // The set of users currently considered online.
  router.get('/online', requireAuth, asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - PRESENCE_ONLINE_WINDOW_MS);
    const users = await prisma.user.findMany({
      where: { lastSeenAt: { gte: since } },
      select: { id: true, callsign: true, name: true, lastSeenAt: true },
      orderBy: { callsign: 'asc' },
    });
    res.json(
      users.map((u) => ({
        ...u,
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
      })),
    );
  }));

  return router;
}
