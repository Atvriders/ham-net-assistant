import type { PrismaClient } from '@prisma/client';
import { postToDiscord } from './client.js';

const REMINDER_KINDS = [
  { kind: '4h', leadMs: 4 * 60 * 60 * 1000 },
  { kind: '30m', leadMs: 30 * 60 * 1000 },
];

/**
 * Compute the next occurrence Date for a Net given dayOfWeek + HH:mm + IANA tz.
 * Approximate implementation that interprets HH:mm as wall clock in the
 * server's local timezone — same approach used elsewhere in the app for
 * dashboard countdowns. Refine to true tz support if/when needed.
 */
export function nextOccurrence(dayOfWeek: number, startLocal: string, fromTime = Date.now()): Date {
  const [h, m] = startLocal.split(':').map(Number);
  const now = new Date(fromTime);
  const target = new Date(now);
  const diff = (dayOfWeek - now.getDay() + 7) % 7;
  target.setDate(now.getDate() + diff);
  target.setHours(h ?? 0, m ?? 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 7);
  return target;
}

export function startReminderScheduler(prisma: PrismaClient): () => void {
  const handle = setInterval(() => { void tick(prisma); }, 60 * 1000);
  // tick once immediately at startup
  void tick(prisma);
  return () => clearInterval(handle);
}

async function tick(prisma: PrismaClient): Promise<void> {
  try {
    const nets = await prisma.net.findMany({
      where: { active: true },
      include: { repeater: true },
    });
    const now = Date.now();
    for (const net of nets) {
      const occurs = nextOccurrence(net.dayOfWeek, net.startLocal, now);
      // Normalize to the minute (zero seconds/ms) for the unique constraint
      const occurrenceKey = new Date(occurs);
      occurrenceKey.setSeconds(0, 0);
      for (const { kind, leadMs } of REMINDER_KINDS) {
        const fireAt = occurs.getTime() - leadMs;
        // Window: fire if within the next 60s and we haven't fired yet
        if (fireAt < now - 60_000 || fireAt > now + 60_000) continue;
        const dedupe = await prisma.netReminder.findUnique({
          where: {
            netId_occursAt_kind: {
              netId: net.id,
              occursAt: occurrenceKey,
              kind,
            },
          },
        }).catch(() => null);
        if (dedupe) continue;
        const human = kind === '4h' ? '4 hours' : '30 minutes';
        const lead = kind === '4h' ? 'Reminder' : 'Heads up';
        const freq = net.repeater?.frequency != null ? ` on ${net.repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = net.repeater?.name ? ` (${net.repeater.name})` : '';
        const content = `**${lead}:** *${net.name}* starts in ${human}${freq}${repeaterName}.`;
        const messageId = await postToDiscord(prisma, content);
        if (messageId) {
          await prisma.netReminder.create({
            data: {
              netId: net.id,
              occursAt: occurrenceKey,
              kind,
            },
          }).catch(() => {/* ignore unique conflicts */});
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] reminder tick failed', e);
  }
}
