import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { loadUser } from './middleware/auth.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { repeatersRouter } from './routes/repeaters.js';
import { netsRouter } from './routes/nets.js';

export function buildApp(prisma: PrismaClient): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser);

  app.use('/api/auth', authRouter(prisma));
  app.use('/api/repeaters', repeatersRouter(prisma));
  app.use('/api/nets', netsRouter(prisma));

  app.use(errorHandler);
  return app;
}
