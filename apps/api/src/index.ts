import { buildApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';

const app = buildApp(prisma);
app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Ham-Net-Assistant API listening on :${env.PORT}`);
});
