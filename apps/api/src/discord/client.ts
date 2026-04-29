import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import { getSetting } from '../lib/settings.js';
import { handleInboundDiscordMessage } from './bridge.js';

let activeClient: Client | null = null;
let activeToken: string | null = null;
let messageHandler: ((m: Message) => void) | null = null;

export interface DiscordConfig {
  enabled: boolean;
  token: string | null;
  channelId: string | null;
}

/** Read a setting under the new key, falling back to the legacy key. */
async function readSetting(
  prisma: PrismaClient,
  newKey: string,
  legacyKey: string,
): Promise<string | null> {
  const v = await getSetting(prisma, newKey);
  if (v !== null && v !== undefined && v !== '') return v;
  return await getSetting(prisma, legacyKey);
}

export async function loadDiscordConfig(prisma: PrismaClient): Promise<DiscordConfig> {
  const envEnabled = (process.env.DISCORD_ENABLED ?? '').toLowerCase();
  const enabledFromEnv = envEnabled === 'true' ? true : envEnabled === 'false' ? false : null;
  const enabledSetting = await readSetting(prisma, 'discord.enabled', 'discordEnabled');
  const enabledFromSetting = enabledSetting === 'true';
  const enabled = enabledFromEnv ?? enabledFromSetting;
  const token =
    process.env.DISCORD_BOT_TOKEN ||
    (await readSetting(prisma, 'discord.token', 'discordBotToken')) ||
    null;
  const channelId =
    process.env.DISCORD_CHANNEL_ID ||
    (await readSetting(prisma, 'discord.channelId', 'discordChannelId')) ||
    null;
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

/**
 * Reload configuration and (re)connect the Discord client to match it. If the
 * config is disabled or missing token/channel, disconnects any active client.
 * Wraps reconcileDiscord with a default inbound-message handler so callers
 * (e.g. the admin route after a config change) don't need to wire one in.
 */
export async function applyDiscordConfig(prisma: PrismaClient): Promise<void> {
  const cfg = await loadDiscordConfig(prisma);
  if (!cfg.enabled || !cfg.token || !cfg.channelId) {
    if (activeClient) {
      try { await activeClient.destroy(); } catch { /* ignore */ }
      activeClient = null;
      activeToken = null;
      messageHandler = null;
    }
    return;
  }
  await reconcileDiscord(prisma, (m) => {
    void handleInboundDiscordMessage(prisma, cfg.channelId, m);
  });
}

/** Post a one-off test message via the active client. Returns id or null. */
export async function sendTestMessage(
  prisma: PrismaClient,
  content: string,
): Promise<string | null> {
  // Make sure the client is up-to-date with current settings before sending.
  await applyDiscordConfig(prisma);
  return await postToDiscord(prisma, content);
}
