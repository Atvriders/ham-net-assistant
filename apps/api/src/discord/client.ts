import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import { getSetting } from '../lib/settings.js';

let activeClient: Client | null = null;
let activeToken: string | null = null;
let messageHandler: ((m: Message) => void) | null = null;

export interface DiscordConfig {
  enabled: boolean;
  token: string | null;
  channelId: string | null;
}

export async function loadDiscordConfig(prisma: PrismaClient): Promise<DiscordConfig> {
  const envEnabled = (process.env.DISCORD_ENABLED ?? '').toLowerCase();
  const enabledFromEnv = envEnabled === 'true' ? true : envEnabled === 'false' ? false : null;
  const enabledFromSetting = (await getSetting(prisma, 'discordEnabled')) === 'true';
  const enabled = enabledFromEnv ?? enabledFromSetting;
  const token = process.env.DISCORD_BOT_TOKEN || (await getSetting(prisma, 'discordBotToken')) || null;
  const channelId = process.env.DISCORD_CHANNEL_ID || (await getSetting(prisma, 'discordChannelId')) || null;
  return { enabled: !!enabled, token, channelId };
}

/** Idempotently start/stop the discord client to match the desired config. */
export async function reconcileDiscord(
  prisma: PrismaClient,
  onMessage: (m: Message) => void,
): Promise<void> {
  const cfg = await loadDiscordConfig(prisma);
  if (!cfg.enabled || !cfg.token) {
    if (activeClient) {
      try { await activeClient.destroy(); } catch { /* ignore */ }
      activeClient = null;
      activeToken = null;
      messageHandler = null;
    }
    return;
  }
  if (activeClient && activeToken === cfg.token) {
    // already running with the right token; just update the handler reference
    messageHandler = onMessage;
    return;
  }
  // (re)start
  if (activeClient) {
    try { await activeClient.destroy(); } catch { /* ignore */ }
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.on(Events.MessageCreate, (m) => {
    if (m.author.bot) return; // ignore other bots, including ourselves
    if (!messageHandler) return;
    messageHandler(m);
  });
  client.on(Events.Error, (e) => {
    // eslint-disable-next-line no-console
    console.warn('[discord] error', e);
  });
  await client.login(cfg.token);
  activeClient = client;
  activeToken = cfg.token;
  messageHandler = onMessage;
}

export async function postToDiscord(prisma: PrismaClient, content: string): Promise<string | null> {
  if (!activeClient) return null;
  const cfg = await loadDiscordConfig(prisma);
  if (!cfg.channelId) return null;
  try {
    const channel = await activeClient.channels.fetch(cfg.channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return null;
    const msg = await (channel as TextChannel).send(content);
    return msg.id;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] post failed', e);
    return null;
  }
}

export function discordChannelMatches(prisma: PrismaClient, channelId: string): Promise<boolean> {
  return loadDiscordConfig(prisma).then((c) => !!c.channelId && c.channelId === channelId);
}

export function getActiveClient(): Client | null {
  return activeClient;
}
