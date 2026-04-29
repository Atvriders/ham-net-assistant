import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import { handleInboundDiscordMessage } from '../../src/discord/bridge.js';

let prisma: PrismaClient; let dbFile: string;
let netId: string; let sessionId: string; let repeaterId: string;

beforeAll(async () => {
  ({ prisma, dbFile } = makeTestDb());
  const repeater = await prisma.repeater.create({
    data: { name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
  });
  repeaterId = repeater.id;
  const net = await prisma.net.create({
    data: {
      name: 'Test Net',
      repeaterId: repeater.id,
      dayOfWeek: 3,
      startLocal: '20:00',
      timezone: 'America/Chicago',
    },
  });
  netId = net.id;
});

afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.discordRelay.deleteMany();
  await prisma.sessionMessage.deleteMany();
  await prisma.netSession.deleteMany();
  const session = await prisma.netSession.create({
    data: { netId, startedAt: new Date() },
  });
  sessionId = session.id;
});

interface FakeMessage {
  id: string;
  channelId: string;
  content: string;
  author: { bot: boolean; username: string };
  member: { displayName: string } | null;
}

function makeMessage(overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id: overrides.id ?? 'discord-msg-1',
    channelId: overrides.channelId ?? 'channel-1',
    content: overrides.content ?? 'hello from discord',
    author: overrides.author ?? { bot: false, username: 'jdoe' },
    member: overrides.member === undefined ? { displayName: 'Jane' } : overrides.member,
  };
}

describe('handleInboundDiscordMessage', () => {
  it('writes a SessionMessage when channel matches and session is active', async () => {
    const m = makeMessage();
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].callsign).toBe('DISCORD');
    expect(rows[0].nameAtMessage).toBe('Jane');
    expect(rows[0].body).toBe('hello from discord');
    const relays = await prisma.discordRelay.findMany();
    expect(relays).toHaveLength(1);
    expect(relays[0].direction).toBe('in');
    expect(relays[0].discordMessageId).toBe('discord-msg-1');
  });

  it('falls back to author.username when member is null', async () => {
    const m = makeMessage({ member: null });
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId } });
    expect(rows[0].nameAtMessage).toBe('jdoe');
  });

  it('dedupes by Discord message id', async () => {
    const m = makeMessage();
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
  });

  it('ignores messages from other channels', async () => {
    const m = makeMessage({ channelId: 'other-channel' });
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(0);
  });

  it('ignores when no channel is configured', async () => {
    const m = makeMessage();
    await handleInboundDiscordMessage(prisma, null, m as never);
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(0);
  });

  it('skips when no active session', async () => {
    await prisma.netSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() },
    });
    const m = makeMessage();
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany();
    expect(rows).toHaveLength(0);
  });

  it('skips empty/whitespace-only content', async () => {
    const m = makeMessage({ content: '   ' });
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany();
    expect(rows).toHaveLength(0);
  });

  it('truncates body to 500 chars', async () => {
    const m = makeMessage({ id: 'long-1', content: 'x'.repeat(800) });
    await handleInboundDiscordMessage(prisma, 'channel-1', m as never);
    const rows = await prisma.sessionMessage.findMany();
    expect(rows[0].body.length).toBe(500);
  });

  // Reference unused id to avoid TS warning when type-checking standalone
  it('repeater id is set up', () => {
    expect(repeaterId).toBeTruthy();
  });
});
