import type { PrismaClient } from '@prisma/client';
import {
  isUlsImportRunning,
  markInterruptedRuns,
  runUlsImport,
  type UlsImportSummary,
} from './ulsImport.js';

/**
 * Weekly scheduler for the FCC ULS mirror, in the same idiom as
 * autoOpenScheduler / autoStartScheduler / staleSessionReaper: a pure
 * `ulsImportTick(prisma, now, …)` driven by an injectable clock, plus a
 * `startUlsImportScheduler` that returns a stop function and is started from
 * index.ts (never from buildApp).
 */

/**
 * How recently a SUCCESSFUL import blocks another.
 *
 * Six days, not seven: the window has to be shorter than the gap between two
 * Fridays or a clock that drifts a few minutes, or a job that ran at 03:05 last
 * week and 03:00 this week, would skip a whole week. Six days is comfortably
 * past "the same Friday" (which is what it must block, since the tick fires
 * every half hour all day) and comfortably short of "next Friday".
 */
export const ULS_SUCCESS_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * How long any run — success or failure — blocks the next attempt.
 *
 * This is the crash-loop guard. A run row is created the moment an import
 * starts, so a container that dies mid-download and restarts finds a run that
 * began minutes ago and waits instead of pulling another 155 MB. Six hours
 * still allows two or three genuine retries within the Friday window.
 */
export const ULS_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Tick interval. A weekly job does not need a fine-grained clock; this only has
 * to be short enough that a container which boots at, say, 04:10 on Friday
 * still catches that day's window. Each tick is one indexed read when it
 * decides to do nothing, which is almost always.
 */
export const ULS_TICK_INTERVAL_MS = 30 * 60 * 1000;

/** Why a tick did or did not import. Returned for tests and observability. */
export type UlsTickOutcome =
  | 'disabled'
  | 'not-due-day'
  | 'not-due-hour'
  | 'net-live'
  | 'busy'
  | 'recent-success'
  | 'retry-cooldown'
  | 'imported';

export interface UlsSchedulerConfig {
  enabled: boolean;
  url: string;
  /** 0 = Sunday … 6 = Saturday. Container-local time. */
  day: number;
  /** 0-23, container-local time. */
  hour: number;
}

export interface UlsTickDeps {
  /** Injected by tests so a tick never touches the network. */
  runImport?: (prisma: PrismaClient, url: string) => Promise<UlsImportSummary>;
  log?: (message: string) => void;
}

/**
 * One pass of the weekly scheduler.
 *
 * Pure with respect to the injected clock, so a test can drive it across a
 * whole week without waiting. The gates, in order:
 *
 *  1. the club has switched the importer off;
 *  2. it is not the configured day;
 *  3. it is the right day but before the configured hour;
 *  4. an import is already running (a manual admin trigger, or a previous tick
 *     on a slow link — this job legitimately takes minutes);
 *  5. an import already succeeded inside {@link ULS_SUCCESS_INTERVAL_MS}, which
 *     is what stops the every-30-minutes tick re-running all Friday;
 *  6. any run at all started inside {@link ULS_RETRY_COOLDOWN_MS}, which is what
 *     stops a restart loop re-downloading the archive over and over.
 *
 * Returns what it decided; never throws for an import failure (the failure is
 * recorded on the run row by runUlsImport).
 */
export async function ulsImportTick(
  prisma: PrismaClient,
  now: Date,
  config: UlsSchedulerConfig,
  deps: UlsTickDeps = {},
): Promise<UlsTickOutcome> {
  if (!config.enabled) return 'disabled';
  if (now.getDay() !== config.day) return 'not-due-day';
  if (now.getHours() < config.hour) return 'not-due-hour';
  if (isUlsImportRunning()) return 'busy';

  // Never start a 150 MB download and four minutes of sustained writes while a
  // net is actually on the air.
  //
  // The day/hour gate alone does not prevent this: its window runs from
  // `hour` to 23:59, so a container restarted on a Friday evening fires the
  // catch-up tick immediately, and a failed 03:00 run retries on its cooldown
  // at 09:00, 15:00 and 21:00 — and 21:00 is the middle of most club nets.
  // Checking for a live session tests the thing actually worth protecting
  // rather than guessing at clock windows, and costs one indexed query per
  // tick. The import simply waits for the next tick; it has all week.
  const liveSession = await prisma.netSession.findFirst({
    where: { liveAt: { not: null }, endedAt: null, deletedAt: null },
    select: { id: true },
  });
  if (liveSession) return 'net-live';

  const lastSuccess = await prisma.ulsImportRun.findFirst({
    where: { outcome: 'success' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  if (
    lastSuccess &&
    now.getTime() - lastSuccess.startedAt.getTime() < ULS_SUCCESS_INTERVAL_MS
  ) {
    return 'recent-success';
  }

  const lastAttempt = await prisma.ulsImportRun.findFirst({
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  if (
    lastAttempt &&
    now.getTime() - lastAttempt.startedAt.getTime() < ULS_RETRY_COOLDOWN_MS
  ) {
    return 'retry-cooldown';
  }

  const log = deps.log ?? ((m: string): void => console.log(`[uls] ${m}`));
  const runImport =
    deps.runImport ??
    ((client: PrismaClient, url: string): Promise<UlsImportSummary> =>
      runUlsImport(client, { url, trigger: 'schedule' }));

  const summary = await runImport(prisma, config.url);
  if (summary.outcome === 'success') {
    log(
      `weekly import ok: ${summary.callsigns} callsigns from ${summary.sourceFileDate ?? 'unknown dump'}`,
    );
  } else {
    log(`weekly import FAILED: ${summary.error ?? 'unknown error'}`);
  }
  return 'imported';
}

/**
 * Start the weekly ULS import on a 30-minute interval using the real clock.
 * Runs one tick immediately at startup so a container that was down over its
 * window catches up. Returns a stop function; index.ts calls it from the
 * SIGTERM path.
 *
 * NOTE: exactly ONE replica may run this scheduler, exactly as for the other
 * three. Two replicas would both import into the same SQLite file.
 */
export function startUlsImportScheduler(
  prisma: PrismaClient,
  config: UlsSchedulerConfig,
  /**
   * Injected only by tests. The catch-up tick below fires the moment this is
   * called, so without it a test that starts an ENABLED scheduler reaches for
   * the network — and does so only on the configured weekday, which is the
   * worst kind of test: green six days a week.
   */
  deps: UlsTickDeps = {},
): () => void {
  if (!config.enabled) {
    console.log('[uls] weekly FCC import disabled (ULS_IMPORT_ENABLED=false)');
    // Still return a stop function so the caller's shutdown path is uniform.
    return () => {};
  }
  console.log(
    `[uls] weekly FCC import enabled — day ${config.day} (0=Sun) at ${String(config.hour).padStart(2, '0')}:00 local, from ${config.url}`,
  );

  // A run row left in 'running' by a killed process would otherwise show as an
  // import in progress forever on the admin status endpoint.
  void markInterruptedRuns(prisma, new Date()).catch((e: unknown) => {
    console.warn('[uls] could not reconcile interrupted runs', e);
  });

  // Re-entrancy guard, matching the sibling schedulers: an import takes minutes
  // and must never overlap the next interval.
  let inFlight = false;
  const run = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await ulsImportTick(prisma, new Date(), config, deps);
    } catch (e) {
      console.warn('[uls] tick failed', e);
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => {
    void run();
  }, ULS_TICK_INTERVAL_MS);
  void run();
  return () => clearInterval(handle);
}
