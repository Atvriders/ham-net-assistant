import type { PrismaClient } from '@prisma/client';
import { postToDiscord } from './client.js';
import { getSetting } from '../lib/settings.js';

function defaultTimes(): string[] {
  return ['16:00', '19:30'];
}

async function getReminderTimes(prisma: PrismaClient): Promise<string[]> {
  try {
    const raw = await getSetting(prisma, 'discord.reminderTimesOfDay');
    if (!raw) return defaultTimes();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultTimes();
    const valid = parsed
      .map((s: unknown) => String(s))
      .filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
    return valid.length > 0 ? valid : defaultTimes();
  } catch {
    return defaultTimes();
  }
}

function format12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h24 = Number(hStr);
  const m = Number(mStr);
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
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
    const times = await getReminderTimes(prisma);
    if (times.length === 0) return;
    const nets = await prisma.net.findMany({
      where: { active: true },
      include: { repeater: true },
    });
    const now = Date.now();
    for (const net of nets) {
      const occurs = nextOccurrence(net.dayOfWeek, net.startLocal, now);
      // The base "day-of" the occurrence (midnight local of that calendar day)
      const dayBase = new Date(occurs);
      dayBase.setHours(0, 0, 0, 0);
      for (const t of times) {
        const [hh, mm] = t.split(':').map(Number);
        const reminderAt = new Date(dayBase);
        reminderAt.setHours(hh!, mm!, 0, 0);
        // Skip if reminder is at or after the net's actual start
        if (reminderAt.getTime() >= occurs.getTime()) continue;
        // Fire window: ±60s of reminderAt
        if (reminderAt.getTime() < now - 60_000 || reminderAt.getTime() > now + 60_000) continue;
        const occurrenceKey = new Date(occurs);
        occurrenceKey.setSeconds(0, 0);
        const dedupe = await prisma.netReminder.findUnique({
          where: { netId_occursAt_kind: { netId: net.id, occursAt: occurrenceKey, kind: t } },
        }).catch(() => null);
        if (dedupe) continue;
        const human = format12h(t);
        const freq = net.repeater?.frequency != null ? ` on ${net.repeater.frequency.toFixed(3)} MHz` : '';
        const repeaterName = net.repeater?.name ? ` (${net.repeater.name})` : '';
        const minutesUntil = Math.round((occurs.getTime() - reminderAt.getTime()) / 60000);
        const lead = minutesUntil <= 60 ? 'Heads up' : 'Reminder';
        const content = `**${lead}:** *${net.name}* starts at ${format12h(net.startLocal)}${freq}${repeaterName}. (${human} reminder)`;
        const result = await postToDiscord(prisma, content);
        if (result.ok) {
          await prisma.netReminder.create({
            data: { netId: net.id, occursAt: occurrenceKey, kind: t },
          }).catch(() => {/* ignore unique conflicts */});
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] reminder tick failed', e);
  }
}
