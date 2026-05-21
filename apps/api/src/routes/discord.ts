import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../middleware/async.js';
import { requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  loadDiscordConfig,
  applyDiscordConfig,
  sendTestMessage,
} from '../discord/client.js';
import { setSetting } from '../lib/settings.js';

const ConfigUpdateInput = z
  .object({
    enabled: z.boolean().optional(),
    channelId: z.string().max(64).optional(),
    // Token: sending null clears it. Sending a non-empty string sets it.
    // Omitting the field leaves it unchanged.
    token: z.string().max(200).nullable().optional(),
  })
  .strict();

export function discordRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Public-ish: chat header indicator only knows on/off. No token, no channel.
  router.get('/status', asyncHandler(async (_req, res) => {
    const cfg = await loadDiscordConfig(prisma);
    const configured = cfg.enabled && !!cfg.token && !!cfg.channelId;
    res.json({ enabled: configured });
  }));

  // Admin-only: read full config (token redacted to a marker if set).
  router.get('/config', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    const cfg = await loadDiscordConfig(prisma);
    res.json({
      enabled: cfg.enabled,
      channelId: cfg.channelId ?? '',
      tokenSet: !!cfg.token,
      tokenFromEnv: !!process.env.DISCORD_BOT_TOKEN,
      channelIdFromEnv: !!process.env.DISCORD_CHANNEL_ID,
      enabledFromEnv:
        process.env.DISCORD_ENABLED === 'true' ||
        process.env.DISCORD_ENABLED === 'false',
    });
  }));

  router.patch(
    '/config',
    requireRole('ADMIN'),
    validateBody(ConfigUpdateInput),
    asyncHandler(async (req, res) => {
      const body = req.body as typeof ConfigUpdateInput._type;
      if (body.enabled !== undefined) {
        await setSetting(prisma, 'discord.enabled', String(body.enabled));
      }
      if (body.channelId !== undefined) {
        await setSetting(prisma, 'discord.channelId', body.channelId);
      }
      if (body.token !== undefined) {
        if (body.token === null || body.token === '') {
          await setSetting(prisma, 'discord.token', '');
        } else {
          await setSetting(prisma, 'discord.token', body.token);
        }
      }
      // Re-apply config so token/channel changes take effect immediately.
      await applyDiscordConfig(prisma).catch(() => {
        /* ignore — admin will see effect via /status or test send */
      });
      res.status(204).end();
    }),
  );

  router.post('/test', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
    const id = await sendTestMessage(
      prisma,
      '✅ Ham-Net-Assistant test message — Discord bridge working.',
    );
    res.json({ ok: true, messageId: id });
  }));

  return router;
}
