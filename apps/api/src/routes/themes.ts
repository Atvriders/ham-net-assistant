import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { uploadedLogoUrl } from './logos.js';
import { asyncHandler } from '../middleware/async.js';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { getSetting, setSetting } from '../lib/settings.js';

interface ThemeJson {
  slug: string;
  name: string;
  shortName: string;
  colors: Record<string, string>;
  font: { display: string; body: string };
  logo: { file: string; alt: string; maxHeightPx: number };
  attribution?: string;
}

export const DEFAULT_THEME_SETTING_KEY = 'defaultThemeSlug';

function loadThemes(): ThemeJson[] {
  const candidates = [
    path.resolve(process.cwd(), '../../themes'),
    path.resolve(process.cwd(), 'themes'),
  ];
  const dir = candidates.find((p) => fs.existsSync(p));
  if (!dir) return [];
  const out: ThemeJson[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name, 'theme.json');
    if (!fs.existsSync(full)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(full, 'utf8')) as ThemeJson);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

const DefaultThemeBody = z.object({ slug: z.string().min(1).max(64) });

export function themesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const themes = loadThemes();

  router.get('/', (_req, res) =>
    res.json(themes.map((t) => ({ ...t, uploadedLogoUrl: uploadedLogoUrl(t.slug) }))),
  );

  router.get(
    '/default',
    asyncHandler(async (_req, res) => {
      const slug = (await getSetting(prisma, DEFAULT_THEME_SETTING_KEY)) ?? 'default';
      res.json({ slug });
    }),
  );

  router.patch(
    '/default',
    requireRole('ADMIN'),
    validateBody(DefaultThemeBody),
    asyncHandler(async (req, res) => {
      const { slug } = req.body as z.infer<typeof DefaultThemeBody>;
      const known = themes.some((t) => t.slug === slug) || slug === 'default';
      if (!known) {
        throw new HttpError(400, 'VALIDATION', `Unknown theme slug: ${slug}`);
      }
      await setSetting(prisma, DEFAULT_THEME_SETTING_KEY, slug);
      res.json({ slug });
    }),
  );

  return router;
}
