import type { Prisma, PrismaClient } from '@prisma/client';
import { parseReminderMinutes } from '@hna/shared';
import { postToDiscord } from './client.js';

/**
 * Thrown when a stored net timezone is not something `Intl` understands.
 *
 * A typed error (rather than the raw RangeError Intl throws) so every
 * scheduler can tell "this ONE net is misconfigured — log it and move on"
 * apart from a genuine bug. Before this existed, a single net saved with
 * "CDT" or a pasted trailing space threw out of the per-net loop and killed
 * auto-open, auto-start AND reminders for every other net, silently, across
 * restarts.
 */
export class InvalidTimezoneError extends Error {
  constructor(public readonly timezone: string, cause?: unknown) {
    super(`Invalid IANA timezone ${JSON.stringify(timezone)}`, { cause });
    this.name = 'InvalidTimezoneError';
  }
}

/**
 * Return the wall-clock components (year, month, day, hour, minute, weekday)
 * that a given UTC instant has in the named IANA timezone.
 *
 * Throws {@link InvalidTimezoneError} for a zone `Intl` rejects. It does NOT
 * silently fall back to UTC: a wrong-but-plausible time would announce and
 * auto-start nets hours off, which is worse than skipping the net loudly.
 */
export function wallClockIn(tz: string, when: Date) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'short',
    });
  } catch (e) {
    throw new InvalidTimezoneError(tz, e);
  }
  const parts = Object.fromEntries(
    fmt.formatToParts(when).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // Intl returns "24" at midnight in some locales
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday!] ?? 0,
  };
}

/**
 * Compute the UTC Date that corresponds to a given wall-clock {y,mo,d,h,mi}
 * **as observed in the named timezone**. Adjusts an initial UTC guess until
 * its wall-clock interpretation in the target tz matches the requested
 * components. Robust across DST transitions.
 */
export function instantFromWallClock(
  tz: string, y: number, mo: number, d: number, h: number, mi: number,
): Date {
  // Start with a UTC guess for that wall-clock
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
  for (let i = 0; i < 3; i++) {
    const wall = wallClockIn(tz, guess);
    const guessedUtcMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    const desiredUtcMs = Date.UTC(y, mo - 1, d, h, mi);
    const drift = desiredUtcMs - guessedUtcMs;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}

/**
 * Given a Net's day-of-week and HH:mm wall-clock and IANA timezone, return
 * the next UTC instant that wall-clock is hit, after `fromTime`.
 */
export function nextOccurrence(
  dayOfWeek: number,
  startLocal: string,
  timezone: string,
  fromTime = Date.now(),
): Date {
  const [h, m] = startLocal.split(':').map(Number);
  const fromInTz = wallClockIn(timezone, new Date(fromTime));
  const diff = (dayOfWeek - fromInTz.weekday + 7) % 7;
  // Advance fromInTz's calendar day by `diff` days. Use Date.UTC for safe
  // calendar arithmetic on year/month/day (overflow handling), but DON'T
  // round-trip through wallClockIn — UTC midnight of "today in tz" may be
  // on a different calendar day in the target tz.
  const advanced = new Date(Date.UTC(fromInTz.year, fromInTz.month - 1, fromInTz.day + diff, 12, 0, 0));
  const targetY = advanced.getUTCFullYear();
  const targetMo = advanced.getUTCMonth() + 1;
  const targetD = advanced.getUTCDate();
  let utc = instantFromWallClock(timezone, targetY, targetMo, targetD, h ?? 0, m ?? 0);
  if (utc.getTime() <= fromTime) {
    // Bump 7 days on the calendar and re-anchor to wall clock (handles DST shifts).
    const bumped = new Date(Date.UTC(targetY, targetMo - 1, targetD + 7, 12, 0, 0));
    utc = instantFromWallClock(
      timezone,
      bumped.getUTCFullYear(),
      bumped.getUTCMonth() + 1,
      bumped.getUTCDate(),
      h ?? 0, m ?? 0,
    );
  }
  return utc;
}

/**
 * Format a lead-time-in-minutes for human-readable Discord messages.
 * 60 -> "1 hour", 90 -> "1.5 hours", 30 -> "30 minutes", 240 -> "4 hours".
 */
function formatLeadMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours.toFixed(1)} hours`;
}

function formatStartLocal12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h24 = Number(hStr);
  const m = Number(mStr);
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/**
 * How long after its due instant a reminder may still fire.
 *
 * The window is FORWARD-only ([reminderAt, reminderAt + 5 min)), not the
 * symmetric ±60s it used to be: against a 60s tick, a two-minute Discord
 * outage or a slow tick used to drop that reminder permanently — the next
 * tick was already past the window and the club simply never got pinged.
 * Five minutes of catch-up costs nothing (the NetReminder dedupe row still
 * makes it fire at most once) and a reminder that lands up to 5 minutes late
 * is still useful; one that never lands is not.
 */
export const REMINDER_FIRE_WINDOW_MS = 5 * 60_000;

export function startReminderScheduler(prisma: PrismaClient): () => void {
  // Re-entrancy guard: a tick that runs long (Discord rate-limiting a batch
  // of posts) must not overlap the next interval firing — two overlapping
  // ticks both read "no dedupe row yet" and double-post.
  //
  // NOTE: exactly ONE replica may run this scheduler. The dedupe row is the
  // only cross-process guard and it is staked after a read, so a second
  // replica ticking in parallel can double-post. The app is deliberately not
  // designed for multi-replica scheduling — scale vertically, not out.
  let inFlight = false;
  const run = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tick(prisma);
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => { void run(); }, 60 * 1000);
  // tick once immediately at startup
  void run();
  return () => clearInterval(handle);
}

async function tick(prisma: PrismaClient): Promise<void> {
  try {
    // Impromptu nets have no meaningful schedule, so the reminder scheduler
    // must skip them — only weekly nets get reminder pings.
    const nets = await prisma.net.findMany({
      where: { active: true, kind: 'weekly' },
      include: { repeater: true },
    });
    const now = Date.now();
    for (const net of nets) {
      // One misconfigured net must never cost every OTHER net its reminders:
      // nextOccurrence throws InvalidTimezoneError on a zone Intl rejects
      // (and any Prisma hiccup would escape here too), so each net gets its
      // own failure boundary and the loop keeps going.
      try {
        await remindForNet(prisma, net, now);
      } catch (e) {
        const reason = e instanceof InvalidTimezoneError
          ? `invalid timezone ${JSON.stringify(net.timezone)}`
          : 'reminder failed';
        console.warn(`[discord] skipping net ${net.id} (${net.name}): ${reason}`, e);
      }
    }
  } catch (e) {
    console.warn('[discord] reminder tick failed', e);
  }
}

type ReminderNet = Prisma.NetGetPayload<{ include: { repeater: true } }>;

/** Fire whichever of one net's reminders are due at `now`. */
async function remindForNet(
  prisma: PrismaClient,
  net: ReminderNet,
  now: number,
): Promise<void> {
  // Per-net reminder lead times, in minutes-before-net-start.
  // `null` / `[]` means "no reminders for this net".
  const leadMinutes = parseReminderMinutes(net.reminderMinutes);
  if (leadMinutes.length === 0) return;

  const tz = net.timezone || 'UTC';
  if (!net.timezone) {
    console.warn(`[discord] net ${net.id} has no timezone; defaulting to UTC`);
  }
  const occurs = nextOccurrence(net.dayOfWeek, net.startLocal, tz, now);

  for (const minutes of leadMinutes) {
    const reminderAt = new Date(occurs.getTime() - minutes * 60_000);
    // Skip if reminder is at or after the net's actual start. (positive
    // lead times always satisfy this, but guard defensively.)
    if (reminderAt.getTime() >= occurs.getTime()) continue;
    // Fire window: [reminderAt, reminderAt + REMINDER_FIRE_WINDOW_MS).
    if (now < reminderAt.getTime()) continue;
    if (now - reminderAt.getTime() >= REMINDER_FIRE_WINDOW_MS) continue;
    const occurrenceKey = new Date(occurs);
    occurrenceKey.setSeconds(0, 0);
    const kind = `m${minutes}`;
    const key = { netId: net.id, occursAt: occurrenceKey, kind };
    const dedupe = await prisma.netReminder.findUnique({
      where: { netId_occursAt_kind: key },
    }).catch(() => null);
    if (dedupe) continue;
    const freq = net.repeater?.frequency != null ? ` on ${net.repeater.frequency.toFixed(3)} MHz` : '';
    const repeaterName = net.repeater?.name ? ` (${net.repeater.name})` : '';
    const lead = minutes <= 60 ? 'Heads up' : 'Reminder';
    const human = formatLeadMinutes(minutes);
    const content = `**${lead}:** *${net.name}* starts at ${formatStartLocal12h(net.startLocal)}${freq}${repeaterName}. (${human} reminder)`;

    // Stake the dedupe row BEFORE posting. The old order (post, then insert)
    // meant a crash — or a container stop — in between re-posted the same
    // reminder to the whole club on the next tick. Staking first makes the
    // crash window fail toward "missed reminder" instead of "duplicate ping",
    // and the unique constraint also settles a race with a concurrent tick.
    const staked = await prisma.netReminder.create({ data: key })
      .then(() => true)
      .catch(() => false);
    if (!staked) continue;
    const result = await postToDiscord(prisma, content);
    if (!result.ok) {
      // Clean failure (Discord down / misconfigured): release the stake so a
      // later tick inside the 5-minute window can retry. Only an unclean
      // crash leaves the row behind, which is the safe direction.
      await prisma.netReminder.delete({
        where: { netId_occursAt_kind: key },
      }).catch(() => {/* already gone — nothing to release */});
    }
  }
}
