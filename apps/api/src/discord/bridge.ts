import type { PrismaClient } from '@prisma/client';
import type { Message } from 'discord.js';

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
