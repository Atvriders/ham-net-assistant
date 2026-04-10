import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { uploadedLogoUrl } from './logos.js';

interface ThemeJson {
  slug: string;
  name: string;
  shortName: string;
  colors: Record<string, string>;
  font: { display: string; body: string };
  logo: { file: string; alt: string; maxHeightPx: number };
  attribution?: string;
}

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

export function themesRouter(): Router {
  const router = Router();
  const themes = loadThemes();
  router.get('/', (_req, res) =>
    res.json(themes.map((t) => ({ ...t, uploadedLogoUrl: uploadedLogoUrl(t.slug) }))),
  );
  return router;
}
