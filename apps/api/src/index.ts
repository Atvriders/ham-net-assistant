import { buildApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';
import { reconcileDiscord, loadDiscordConfig } from './discord/client.js';
import { handleInboundDiscordMessage } from './discord/bridge.js';
import { startReminderScheduler } from './discord/reminders.js';

const app = buildApp(prisma);
app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Ham-Net-Assistant API listening on :${env.PORT}`);
});

// Kick off the Discord bridge + reminder scheduler asynchronously so the
// HTTP server is never blocked on Discord's gateway login.
void (async () => {
  try {
    const cfg = await loadDiscordConfig(prisma);
    if (!cfg.enabled) return;
    await reconcileDiscord(prisma, (m) => {
      void handleInboundDiscordMessage(prisma, cfg.channelId, m);
    });
    startReminderScheduler(prisma);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[discord] startup failed', e);
  }
})();
