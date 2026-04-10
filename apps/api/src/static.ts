import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

export function mountStatic(app: Express): void {
  const dir = env.STATIC_DIR || path.resolve(process.cwd(), '../web/dist');
  if (!fs.existsSync(dir)) return;
  app.use(express.static(dir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });
}
