import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { loadUser } from './middleware/auth.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { repeatersRouter } from './routes/repeaters.js';
import { netsRouter } from './routes/nets.js';
import { sessionsRouter } from './routes/sessions.js';
import { checkinsRouter } from './routes/checkins.js';
import { statsRouter } from './routes/stats.js';
import { themesRouter } from './routes/themes.js';
import { logosRouter } from './routes/logos.js';
import { usersRouter } from './routes/users.js';
import { callsignLookupRouter } from './routes/callsignLookup.js';
import { topicsRouter } from './routes/topics.js';
import { messagesRouter } from './routes/messages.js';
import { scriptImportRouter } from './routes/scriptImport.js';
import { adminRouter } from './routes/admin.js';
import { mountStatic } from './static.js';

export function buildApp(prisma: PrismaClient): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser);

  app.use('/api/auth', authRouter(prisma));
  app.use('/api/callsign-lookup', callsignLookupRouter());
  app.use('/api/repeaters', repeatersRouter(prisma));
  app.use('/api/nets', netsRouter(prisma));
  const sessions = sessionsRouter(prisma);
  app.use('/api/nets/:netId/sessions', sessions.nested);
  app.use('/api/sessions', sessions.flat);
  const checkins = checkinsRouter(prisma);
  app.use('/api/sessions/:sessionId/checkins', checkins.nested);
  app.use('/api/checkins', checkins.flat);
  app.use('/api/stats', statsRouter(prisma));
  app.use('/api/themes', themesRouter(prisma));
  app.use('/api/themes', logosRouter());
  app.use('/api/users', usersRouter(prisma));
  app.use('/api/topics', topicsRouter(prisma));
  const messages = messagesRouter(prisma);
  app.use('/api/sessions/:sessionId/messages', messages.nested);
  app.use('/api/messages', messages.flat);
  app.use('/api/script-import', scriptImportRouter());
  app.use('/api/admin', adminRouter(prisma));

  mountStatic(app);
  app.use(errorHandler);
  return app;
}
