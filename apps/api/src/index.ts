import { buildApp } from './app.js';
import { prisma, initDb } from './db.js';
import { env } from './env.js';
import {
  reconcileDiscord,
  loadDiscordConfig,
  destroyDiscordClient,
} from './discord/client.js';
import { handleInboundDiscordMessage } from './discord/bridge.js';
import { startReminderScheduler } from './discord/reminders.js';
import { startAutoOpenScheduler } from './lib/autoOpenScheduler.js';
import { startAutoStartScheduler } from './lib/autoStartScheduler.js';
import { startStaleSessionReaper } from './lib/staleSessionReaper.js';
import { startUlsImportScheduler } from './lib/ulsScheduler.js';

/**
 * How long the shutdown sequence gets before we stop being polite. A hung
 * keep-alive socket or a wedged Discord websocket must not outlast Docker's
 * stop grace period (10s by default) — if it does, the container is SIGKILLed
 * mid-write instead of exiting cleanly, which is exactly what WAL recovery is
 * for and exactly what we'd rather not rely on.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

// Apply the SQLite reliability pragmas BEFORE the first request can be served.
// This used to run after app.listen(), so early requests (health checks, an
// impatient browser) could execute against a connection with no WAL and no
// busy timeout.
await initDb();

const app = buildApp(prisma);
const server = app.listen(env.PORT, () => {
  console.log(`Ham-Net-Assistant API listening on :${env.PORT}`);
});

// Always start the reminder scheduler — `postToDiscord` no-ops cleanly when
// Discord isn't connected, and the scheduler is cheap. This way enabling
// Discord later via the admin UI doesn't require a process restart.
const stopReminders = startReminderScheduler(prisma);
// Auto-open scheduler: opens a PREP session ~15 minutes before each weekly
// net's scheduled start. Unconditional — it makes no Discord posts, so it
// doesn't depend on Discord being connected. Kept out of the test app
// (buildApp) so tests drive autoOpenTick with a fixed clock instead.
const stopAutoOpen = startAutoOpenScheduler(prisma);
// Auto-start scheduler: transitions an open PREP session to LIVE when the
// weekly net's scheduled start time arrives (15-min grace window), exactly
// as if START were pressed — including the Discord announcement, which
// no-ops cleanly when Discord isn't connected. Also kept out of buildApp so
// tests drive autoStartTick with a fixed clock instead.
const stopAutoStart = startAutoStartScheduler(prisma);
// Stale-session reaper: nothing else ever writes endedAt except a human
// pressing END, so a forgotten net would stay LIVE forever and pile up on the
// Dashboard. Ends sessions that have been live for more than 4 hours.
const stopReaper = startStaleSessionReaper(prisma);
// Weekly FCC ULS import: refreshes the local amateur-licence mirror so callsign
// lookups during a net are answered from the club's own database instead of
// depending on callook.info being up. Streams ~155 MB once a week (Friday 03:00
// container-local by default) in ~2,000-row transactions that yield between
// batches, so it never locks a live net out of the database. Returns a no-op
// stop function when ULS_IMPORT_ENABLED=false. Kept out of buildApp like its
// siblings so tests drive ulsImportTick with a fixed clock instead.
const stopUlsImport = startUlsImportScheduler(prisma, {
  enabled: env.ULS_IMPORT_ENABLED,
  url: env.ULS_SOURCE_URL,
  day: env.ULS_IMPORT_DAY,
  hour: env.ULS_IMPORT_HOUR,
});

// Kick off the Discord bridge asynchronously so the HTTP server is never
// blocked on Discord's gateway login.
void (async () => {
  try {
    const cfg = await loadDiscordConfig(prisma);
    if (!cfg.enabled) return;
    await reconcileDiscord(prisma, (m) => {
      void handleInboundDiscordMessage(prisma, cfg.channelId, m);
    });
  } catch (e) {
    console.warn('[discord] startup failed', e);
  }
})();

/**
 * Graceful shutdown. The API runs as PID 1 in its container, so nothing else
 * reaps signals for it: with no handler installed, `docker compose up -d`
 * burned the entire stop grace period on every deploy and then SIGKILLed the
 * process — leaving the Discord websocket un-destroyed (the bot lingered
 * "online" for minutes) and the SQLite connection closed by force.
 *
 * Order matters: stop taking new work first (server.close), then quiesce the
 * background timers, then release external handles.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second Ctrl-C shouldn't restart the sequence
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining`);

  // Backstop: if anything below hangs (a keep-alive socket mid-request, a
  // Discord destroy that never resolves), exit anyway rather than waiting for
  // SIGKILL. Non-zero so the failure is visible in `docker ps -a`.
  const hardExit = setTimeout(() => {
    console.warn(`[shutdown] still draining after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // server.close() waits for every connection to end on its own; idle
      // keep-alive sockets would otherwise hold us open for their full
      // timeout even though they have no request in flight.
      server.closeIdleConnections();
    });
    console.log('[shutdown] http server closed');

    stopReminders();
    stopAutoOpen();
    stopAutoStart();
    stopReaper();
    // An import in flight is NOT waited for: it can have minutes of streaming
    // left and the whole shutdown budget is 8s. Stopping the timer means no new
    // one starts; the in-flight run dies with the process and its 'running' row
    // is reconciled to 'failed' on the next boot (markInterruptedRuns), while
    // the table itself is left in a state every lookup still answers correctly
    // — see the interruption notes in lib/ulsImport.ts.
    stopUlsImport();
    console.log('[shutdown] schedulers stopped');

    await destroyDiscordClient();
    console.log('[shutdown] discord client destroyed');

    await prisma.$disconnect();
    console.log('[shutdown] database disconnected');
  } catch (e) {
    console.warn('[shutdown] error while draining', e);
  } finally {
    clearTimeout(hardExit);
  }

  console.log('[shutdown] bye');
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
