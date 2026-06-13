import { buildApp } from './app.js';
import { prisma, initDb } from './db.js';
import { env } from './env.js';
import { reconcileDiscord, loadDiscordConfig } from './discord/client.js';
import { handleInboundDiscordMessage } from './discord/bridge.js';
import { startReminderScheduler } from './discord/reminders.js';

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
