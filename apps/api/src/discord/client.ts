import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import { getSetting } from '../lib/settings.js';
import { handleInboundDiscordMessage } from './bridge.js';
import { HttpError } from '../middleware/error.js';

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

export interface PostResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
}

export async function postToDiscordStrict(
  prisma: PrismaClient,
  content: string,
): Promise<string> {
  if (!activeClient) {
    throw new HttpError(
      503,
      'INTERNAL',
      'Discord client not connected. Save the settings with Enabled checked first.',
    );
  }
  const cfg = await loadDiscordConfig(prisma);
  if (!cfg.channelId) {
    throw new HttpError(400, 'VALIDATION', 'No channel id configured.');
  }
  let channel: any;
  try {
    channel = await activeClient.channels.fetch(cfg.channelId);
  } catch (e) {
    throw new HttpError(
      400,
      'VALIDATION',
      `Could not fetch channel ${cfg.channelId}: ${(e as Error).message}. Verify the channel id is correct and the bot is in that server.`,
    );
  }
  if (!channel) {
    throw new HttpError(
      400,
      'VALIDATION',
      `Channel ${cfg.channelId} not found. Bot may not be a member of that server, or the id is wrong.`,
    );
  }
  if (!channel.isTextBased() || !('send' in channel)) {
    throw new HttpError(
      400,
      'VALIDATION',
      `Channel ${cfg.channelId} is not a text channel.`,
    );
  }
  try {
    const msg = await channel.send(content);
    return msg.id;
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    throw new HttpError(
      400,
      'VALIDATION',
      `Send failed: ${m}. Verify the bot has Send Messages permission on this channel.`,
    );
  }
}

export async function postToDiscord(prisma: PrismaClient, content: string): Promise<PostResult> {
  try {
    const messageId = await postToDiscordStrict(prisma, content);
    return { ok: true, messageId };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] post failed', e);
    return { ok: false, reason: `Discord error: ${(e as Error).message}` };
  }
}

export async function sendDiscordOrThrow(
  prisma: PrismaClient,
  content: string,
): Promise<string> {
  if (!activeClient) {
    throw new Error('Discord bot is not running. Set Enabled + token + channel ID and Save first.');
  }
  const cfg = await loadDiscordConfig(prisma);
  if (!cfg.channelId) {
    throw new Error('No channel ID configured.');
  }
  let channel;
  try {
    channel = await activeClient.channels.fetch(cfg.channelId);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(`Channel fetch failed: ${msg}. Verify the channel ID is correct and the bot has been invited to that server with View Channel permission.`);
  }
  if (!channel) {
    throw new Error(`Channel ${cfg.channelId} not found. The bot may not be in the server, or the ID is wrong.`);
  }
  if (!channel.isTextBased() || !('send' in channel)) {
    throw new Error('Configured channel is not text-based or doesn\'t accept messages.');
  }
  try {
    const msg = await (channel as TextChannel).send(content);
    return msg.id;
  } catch (e) {
    const err = e as Error & { code?: number };
    const code = err.code ? ` (code ${err.code})` : '';
    throw new Error(`Send failed${code}: ${err.message ?? String(e)}. Common causes: bot lacks Send Messages permission on this channel, MESSAGE CONTENT INTENT not enabled in the developer portal, or invalid token.`);
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

export async function postToDiscordOrThrow(
  prisma: PrismaClient,
  content: string,
): Promise<string> {
  if (!activeClient) {
    throw new Error('Discord client is not connected (token or channel missing, or enabled=false)');
  }
  const cfg = await loadDiscordConfig(prisma);
  if (!cfg.enabled) {
    throw new Error('Discord integration is disabled');
  }
  if (!cfg.token) {
    throw new Error('Discord bot token is not set');
  }
  if (!cfg.channelId) {
    throw new Error('Discord channel ID is not set');
  }
  let channel;
  try {
    channel = await activeClient.channels.fetch(cfg.channelId);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(`Could not fetch channel ${cfg.channelId}: ${msg}. Bot may not be in the server, or the channel ID is wrong.`);
  }
  if (!channel) {
    throw new Error(`Channel ${cfg.channelId} not found. Check the channel ID and that the bot is in the server.`);
  }
  if (!channel.isTextBased()) {
    throw new Error(`Channel ${cfg.channelId} is not a text channel`);
  }
  if (!('send' in channel)) {
    throw new Error(`Channel ${cfg.channelId} does not support sending messages`);
  }
  try {
    const msg = await (channel as TextChannel).send(content);
    return msg.id;
  } catch (e) {
    const err = e as Error & { code?: number };
    const msg = err?.message ?? String(e);
    throw new Error(`Send failed: ${msg}. The bot probably lacks Send Messages permission in that channel.`);
  }
}

export async function sendTestMessage(
  prisma: PrismaClient,
  content: string,
): Promise<string> {
  await applyDiscordConfig(prisma);
  return await postToDiscordStrict(prisma, content);
}
