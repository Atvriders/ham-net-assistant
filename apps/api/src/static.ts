import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

/**
 * Mount the built SPA in front of the API.
 *
 * Everything here is best-effort by design — the API must still boot and serve
 * /api/* when no web build is present (that is how the dev server and the test
 * suite run). What it must NOT do is fail silently: a typo in STATIC_DIR used
 * to produce a container that answered every browser request with a 404 and
 * wrote nothing to the log to explain why.
 */
export function mountStatic(app: Express): void {
  const configured = env.STATIC_DIR.trim();
  const dir = configured ? path.resolve(configured) : path.resolve(process.cwd(), '../web/dist');

  if (!fs.existsSync(dir)) {
    if (configured) {
      // Explicitly configured and wrong: an operator asked for this directory,
      // so this is a misconfiguration, not a dev-mode default.
      console.error(
        `[static] STATIC_DIR="${env.STATIC_DIR}" does not exist (resolved to ${dir}). ` +
          'Serving API routes only — every non-/api request will 404.',
      );
    } else {
      console.warn(`[static] No web build at ${dir}; serving API routes only.`);
    }
    return;
  }

  const indexHtml = path.join(dir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    // The directory exists but isn't a Vite build (e.g. STATIC_DIR points at
    // apps/web instead of apps/web/dist). Without index.html the SPA fallback
    // below would answer every deep link with a 500 from sendFile.
    console.error(
      `[static] ${dir} has no index.html — that is not a web build. Serving API routes only.`,
    );
    return;
  }

  app.use(express.static(dir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(indexHtml);
  });
}
