import type { PrismaClient } from '@prisma/client';
import type {
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User as DiscordUser,
} from 'discord.js';

/**
 * Handle a fresh Discord message: if there's an active session and the
 * message is from the configured channel, store it as a SessionMessage.
 */
export async function handleInboundDiscordMessage(
  prisma: PrismaClient,
  configChannelId: string | null,
  m: Message,
): Promise<void> {
  if (!configChannelId || m.channelId !== configChannelId) return;
  // Already mirrored?
  const existing = await prisma.discordRelay.findUnique({ where: { discordMessageId: m.id } });
  if (existing) return;
  // Find the most recently started, not-yet-ended session.
  const session = await prisma.netSession.findFirst({
    where: { endedAt: null, deletedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (!session) return;
  const display = m.member?.displayName ?? m.author.username ?? 'Discord';
  const cleanedBody = (m.content ?? '').slice(0, 500).trim();
  if (!cleanedBody) return;
  const created = await prisma.sessionMessage.create({
    data: {
      sessionId: session.id,
      userId: null,
      callsign: 'DISCORD',
      nameAtMessage: display,
      body: cleanedBody,
    },
  });
  await prisma.discordRelay.create({
    data: {
      discordMessageId: m.id,
      sessionMessageId: created.id,
      direction: 'in',
    },
  });
}

function emojiKey(reaction: MessageReaction | PartialMessageReaction): string {
  return reaction.emoji.name ?? reaction.emoji.id ?? '?';
}

async function findLocalMessageId(
  prisma: PrismaClient,
  discordMessageId: string,
): Promise<string | null> {
  const relay = await prisma.discordRelay.findUnique({
    where: { discordMessageId },
  });
  return relay?.sessionMessageId ?? null;
}

/**
 * Handle a reaction added on a Discord message that we have a local mirror for.
 * Stores it as a SessionMessageReaction with source='discord'.
 */
export async function handleDiscordReactionAdd(
  prisma: PrismaClient,
  reaction: MessageReaction | PartialMessageReaction,
  user: DiscordUser | PartialUser,
): Promise<void> {
  try {
    if (user.bot) return;
    // Lazily fetch partials so we have the data we need.
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (user.partial) {
      try { await user.fetch(); } catch { /* tolerate */ }
    }
    const messageId = reaction.message.id;
    const localId = await findLocalMessageId(prisma, messageId);
    if (!localId) return;
    const emoji = emojiKey(reaction);
    const authorTag = user.username ?? null;
    // Idempotent insert via the unique constraint
    const existing = await prisma.sessionMessageReaction.findFirst({
      where: { messageId: localId, emoji, source: 'discord', authorTag },
    });
    if (existing) return;
    await prisma.sessionMessageReaction.create({
      data: {
        messageId: localId,
        emoji,
        source: 'discord',
        userId: null,
        authorTag,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] reaction add failed', e);
  }
}

/** Handle a reaction removal on a mirrored Discord message. */
export async function handleDiscordReactionRemove(
  prisma: PrismaClient,
  reaction: MessageReaction | PartialMessageReaction,
  user: DiscordUser | PartialUser,
): Promise<void> {
  try {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (user.partial) {
      try { await user.fetch(); } catch { /* tolerate */ }
    }
    const messageId = reaction.message.id;
    const localId = await findLocalMessageId(prisma, messageId);
    if (!localId) return;
    const emoji = emojiKey(reaction);
    const authorTag = user.username ?? null;
    await prisma.sessionMessageReaction.deleteMany({
      where: { messageId: localId, emoji, source: 'discord', authorTag },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] reaction remove failed', e);
  }
}
