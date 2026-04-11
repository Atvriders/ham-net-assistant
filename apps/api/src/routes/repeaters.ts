import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { Callsign, RepeaterInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/async.js';
import { fetchCallookLookup } from './callsignLookup.js';

const SuggestQuery = z.union([
  z.object({ callsign: z.string() }),
  z.object({
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
    dist: z.coerce.number().int().min(1).max(100).default(30),
  }),
]);

type RepeaterSuggestion = typeof RepeaterInput._type;

interface RepeaterbookRow {
  Callsign?: string;
  Frequency?: string | number;
  'Input Freq'?: string | number;
  PL?: string | number;
  'Nearest City'?: string;
  County?: string;
  State?: string;
  Lat?: string | number;
  Long?: string | number;
}

interface RepeaterbookResponse {
  count?: number;
  results?: RepeaterbookRow[];
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return NaN;
}

async function fetchRepeaterbook(
  lat: number,
  lon: number,
  dist = 30,
): Promise<RepeaterSuggestion[] | null> {
  try {
    const url = `https://www.repeaterbook.com/api/export.php?qtype=prox&lat=${lat}&long=${lon}&dist=${dist}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'HamNetAssistant/1.0' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RepeaterbookResponse;
    const rows = Array.isArray(data.results) ? data.results : [];
    const mapped: RepeaterSuggestion[] = [];
    for (const row of rows) {
      const frequency = num(row.Frequency);
      if (!Number.isFinite(frequency)) continue;
      const inputFreq = num(row['Input Freq']);
      const offsetKhz = Number.isFinite(inputFreq)
        ? Math.round((inputFreq - frequency) * 1000)
        : 0;
      const tone = num(row.PL);
      const lat2 = num(row.Lat);
      const lon2 = num(row.Long);
      const coverage = [row['Nearest City'], row.County, row.State]
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .join(', ');
      const cs = (row.Callsign ?? '').toString().trim() || 'UNKNOWN';
      mapped.push({
        name: `${cs} ${frequency}`,
        frequency,
        offsetKhz,
        toneHz: Number.isFinite(tone) && tone > 0 ? tone : null,
        mode: 'FM',
        coverage: coverage || null,
        latitude: Number.isFinite(lat2) ? lat2 : null,
        longitude: Number.isFinite(lon2) ? lon2 : null,
      });
      if (mapped.length >= 20) break;
    }
    return mapped;
  } catch {
    return null;
  }
}

export function repeatersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const list = await prisma.repeater.findMany({ orderBy: { name: 'asc' } });
    res.json(list);
  }));

  // NOTE: must be registered BEFORE '/:id' routes so the literal
  // '/suggestions' path isn't swallowed by the id param matcher.
  router.get(
    '/suggestions',
    requireRole('OFFICER'),
    asyncHandler(async (req, res) => {
      const parsed = SuggestQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpError(400, 'VALIDATION', 'Invalid suggestion query');
      }
      let lat: number;
      let lon: number;
      let dist = 30;
      if ('callsign' in parsed.data) {
        const csParsed = Callsign.safeParse(parsed.data.callsign);
        if (!csParsed.success) {
          throw new HttpError(400, 'VALIDATION', 'Invalid callsign');
        }
        const lookup = await fetchCallookLookup(csParsed.data);
        if (!lookup.found || lookup.latitude == null || lookup.longitude == null) {
          res.json({ suggestions: [], reason: 'no-location' });
          return;
        }
        lat = lookup.latitude;
        lon = lookup.longitude;
      } else {
        lat = parsed.data.lat;
        lon = parsed.data.lon;
        dist = parsed.data.dist;
      }
      const suggestions = await fetchRepeaterbook(lat, lon, dist);
      if (suggestions == null) {
        res.json({ suggestions: [], reason: 'upstream-error' });
        return;
      }
      res.json({ suggestions });
    }),
  );

  router.post('/', requireRole('OFFICER'), validateBody(RepeaterInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof RepeaterInput._type;
    const created = await prisma.repeater.create({
      data: {
        name: body.name,
        frequency: body.frequency,
        offsetKhz: body.offsetKhz,
        toneHz: body.toneHz ?? null,
        mode: body.mode,
        coverage: body.coverage ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
      },
    });
    res.status(201).json(created);
  }));

  router.patch('/:id', requireRole('OFFICER'), validateBody(RepeaterInput), asyncHandler(async (req, res) => {
    const body = req.body as typeof RepeaterInput._type;
    try {
      const updated = await prisma.repeater.update({
        where: { id: req.params.id },
        data: {
          name: body.name,
          frequency: body.frequency,
          offsetKhz: body.offsetKhz,
          toneHz: body.toneHz ?? null,
          mode: body.mode,
          coverage: body.coverage ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
        },
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Repeater not found');
    }
  }));

  router.delete('/:id', requireRole('OFFICER'), asyncHandler(async (req, res) => {
    try {
      await prisma.repeater.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Repeater not found');
    }
  }));

  return router;
}
