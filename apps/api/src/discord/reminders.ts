import type { PrismaClient } from '@prisma/client';
import { postToDiscord } from './client.js';
import { getSetting } from '../lib/settings.js';

function defaultLeads(): Array<{ kind: string; leadMs: number }> {
  return [
    { kind: '4h', leadMs: 4 * 60 * 60 * 1000 },
    { kind: '30m', leadMs: 30 * 60 * 1000 },
  ];
}

function minutesToKind(m: number): string {
  if (m % (24 * 60) === 0) return `${m / (24 * 60)}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function humanLead(m: number): string {
  if (m === 60) return '1 hour';
  if (m % 60 === 0) return `${m / 60} hours`;
  if (m === 1) return '1 minute';
  return `${m} minutes`;
}

async function getReminderLeads(
  prisma: PrismaClient,
): Promise<Array<{ kind: string; leadMs: number }>> {
  try {
    const raw = await getSetting(prisma, 'discord.reminderLeadsMinutes');
    if (!raw) return defaultLeads();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultLeads();
    const minutes = parsed
      .map((n: unknown) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 43200);
    if (minutes.length === 0) return defaultLeads();
    return minutes.map((m) => ({
      kind: minutesToKind(m),
      leadMs: m * 60_000,
    }));
  } catch {
    return defaultLeads();
  }
}

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
    const leads = await getReminderLeads(prisma);
    if (leads.length === 0) return;
    const maxLead = Math.max(...leads.map((l) => l.leadMs));
    const minLead = Math.min(...leads.map((l) => l.leadMs));
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
      for (const { kind, leadMs } of leads) {
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
        const human = humanLead(leadMs / 60_000);
        // Largest lead = "Reminder", smallest = "Heads up", middle = "Reminder".
        const label =
          leads.length > 1 && leadMs === minLead && leadMs !== maxLead
            ? 'Heads up'
            : 'Reminder';
        const freq = net.repeater?.frequency != null ? ` on ${net.repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = net.repeater?.name ? ` (${net.repeater.name})` : '';
        const content = `**${label}:** *${net.name}* starts in ${human}${freq}${repeaterName}.`;
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
