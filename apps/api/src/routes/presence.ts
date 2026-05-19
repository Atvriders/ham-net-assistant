import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { PRESENCE_ONLINE_WINDOW_MS } from '@hna/shared';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Lightweight presence: the web client pings `POST /heartbeat` every ~45s while
 * the user is authenticated and the tab is open. A user is "online" if their
 * `lastSeenAt` is within PRESENCE_ONLINE_WINDOW_MS.
 */
export function presenceRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post('/heartbeat', requireAuth, asyncHandler(async (req, res) => {
    const now = new Date();
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { lastSeenAt: now },
    });
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
