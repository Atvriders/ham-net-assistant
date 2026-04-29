import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../middleware/async.js';
import { loadDiscordConfig } from '../discord/client.js';

export function discordRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Public-ish: just whether the bridge is enabled and configured.
  // No token, no channel id. Used by the chat header indicator.
  router.get('/status', asyncHandler(async (_req, res) => {
    const cfg = await loadDiscordConfig(prisma);
    const configured = cfg.enabled && !!cfg.token && !!cfg.channelId;
    res.json({ enabled: configured });
  }));

  return router;
}
