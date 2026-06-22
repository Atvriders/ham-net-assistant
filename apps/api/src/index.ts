import { buildApp } from './app.js';
import { prisma, initDb } from './db.js';
import { env } from './env.js';
import { reconcileDiscord, loadDiscordConfig } from './discord/client.js';
import { handleInboundDiscordMessage } from './discord/bridge.js';
import { startReminderScheduler } from './discord/reminders.js';
import { startAutoOpenScheduler } from './lib/autoOpenScheduler.js';

const app = buildApp(prisma);
app.listen(env.PORT, () => {
  console.log(`Ham-Net-Assistant API listening on :${env.PORT}`);
});

// Kick off the Discord bridge + reminder scheduler asynchronously so the
// HTTP server is never blocked on Discord's gateway login.
void (async () => {
  // Apply SQLite reliability pragmas (WAL, busy_timeout, synchronous) once
  // at boot.
  await initDb();
  // Always start the reminder scheduler — `postToDiscord` no-ops cleanly when
  // Discord isn't connected, and the scheduler is cheap. This way enabling
  // Discord later via the admin UI doesn't require a process restart.
  startReminderScheduler(prisma);
  // Auto-open scheduler: opens a PREP session ~15 minutes before each weekly
  // net's scheduled start. Unconditional — it makes no Discord posts, so it
  // doesn't depend on Discord being connected. Kept out of the test app
  // (buildApp) so tests drive autoOpenTick with a fixed clock instead.
  startAutoOpenScheduler(prisma);
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
