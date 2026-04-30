import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { MessageInput } from '@hna/shared';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { postToDiscord, getActiveClient, loadDiscordConfig } from '../discord/client.js';

const ReactionInput = z.object({ emoji: z.string().min(1).max(64) });

/** Add a reaction on the bot's mirror of a chat message in Discord. Best effort. */
async function forwardReactionToDiscord(
  prisma: PrismaClient,
  discordMessageId: string,
  emoji: string,
  mode: 'add' | 'remove',
): Promise<void> {
  try {
    const client = getActiveClient();
    if (!client) return;
    const cfg = await loadDiscordConfig(prisma);
    if (!cfg.channelId) return;
    const channel = await client.channels.fetch(cfg.channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = await (channel as any).messages.fetch(discordMessageId);
    if (!msg) return;
    if (mode === 'add') {
      await msg.react(emoji);
    } else {
      // Remove the bot's own reaction (we can't remove other users' reactions)
      const r = msg.reactions?.cache?.get(emoji);
      if (r) {
        try { await r.users.remove(client.user?.id ?? '@me'); } catch { /* ignore */ }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] forward reaction failed', e);
  }
}

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
      include: {
        reactions: {
          select: {
            id: true,
            emoji: true,
            source: true,
            userId: true,
            authorTag: true,
            createdAt: true,
          },
        },
      },
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
        const result = await postToDiscord(
          prisma,
          `**${user.callsign}** (${user.name}): ${created.body}`,
        );
        if (result.ok && result.messageId) {
          await prisma.discordRelay.create({
            data: { discordMessageId: result.messageId, sessionMessageId: created.id, direction: 'out' },
          });
        }
      } catch { /* ignore */ }
    })();
  }));

  // POST /api/messages/:messageId/reactions  body: { emoji }
  flat.post(
    '/:messageId/reactions',
    requireAuth,
    validateBody(ReactionInput),
    asyncHandler(async (req, res) => {
      const { messageId } = req.params as { messageId: string };
      const { emoji } = req.body as { emoji: string };
      const message = await prisma.sessionMessage.findUnique({ where: { id: messageId } });
      if (!message) throw new HttpError(404, 'NOT_FOUND', 'Message not found');
      const me = req.user!;
      // Idempotent: if the user already has this emoji, return existing.
      const existing = await prisma.sessionMessageReaction.findFirst({
        where: { messageId, emoji, userId: me.id },
      });
      if (existing) {
        res.status(201).json(existing);
        return;
      }
      const created = await prisma.sessionMessageReaction.create({
        data: {
          messageId,
          emoji,
          source: 'web',
          userId: me.id,
          authorTag: null,
        },
      });
      res.status(201).json(created);
      // Forward to Discord if this message is mirrored there.
      void (async () => {
        try {
          const relay = await prisma.discordRelay.findFirst({
            where: { sessionMessageId: messageId, direction: 'out' },
          });
          if (relay?.discordMessageId) {
            await forwardReactionToDiscord(prisma, relay.discordMessageId, emoji, 'add');
          }
        } catch { /* ignore */ }
      })();
    }),
  );

  // DELETE /api/messages/:messageId/reactions/:emoji  (current user only)
  flat.delete(
    '/:messageId/reactions/:emoji',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { messageId, emoji: emojiRaw } = req.params as { messageId: string; emoji: string };
      const emoji = decodeURIComponent(emojiRaw);
      const me = req.user!;
      const existing = await prisma.sessionMessageReaction.findFirst({
        where: { messageId, emoji, userId: me.id },
      });
      if (!existing) {
        // Either nothing to remove, or the row belongs to someone else.
        const otherOwned = await prisma.sessionMessageReaction.findFirst({
          where: { messageId, emoji, NOT: { userId: me.id } },
        });
        if (otherOwned) {
          throw new HttpError(403, 'FORBIDDEN', 'Cannot remove another user\'s reaction');
        }
        throw new HttpError(404, 'NOT_FOUND', 'Reaction not found');
      }
      await prisma.sessionMessageReaction.delete({ where: { id: existing.id } });
      res.status(204).end();
      // Forward removal to Discord (removes the bot's own reaction)
      void (async () => {
        try {
          const relay = await prisma.discordRelay.findFirst({
            where: { sessionMessageId: messageId, direction: 'out' },
          });
          if (relay?.discordMessageId) {
            await forwardReactionToDiscord(prisma, relay.discordMessageId, emoji, 'remove');
          }
        } catch { /* ignore */ }
      })();
    }),
  );

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
