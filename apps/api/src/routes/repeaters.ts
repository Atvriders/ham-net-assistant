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

// Many upstream databases 403 requests that arrive without a recognizable
// User-Agent. Node 20's native fetch sends no UA header at all by default.
// Set an explicit, identifiable UA on every upstream call.
const UPSTREAM_UA =
  'Mozilla/5.0 (compatible; HamNetAssistant/1.0; +https://github.com/Atvriders/ham-net-assistant)';
const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent': UPSTREAM_UA,
  Accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
};

// HearHam schema (from https://hearham.com/api/repeaters/v1 — an open JSON
// dump maintained by the Repeater-START community). frequency/offset are
// integer Hz, encode/decode are PL tones as strings.
interface HearHamRow {
  id?: number;
  callsign?: string;
  latitude?: number | string;
  longitude?: number | string;
  city?: string;
  group?: string;
  mode?: string;
  encode?: string | number;
  decode?: string | number;
  frequency?: number | string;
  offset?: number | string;
  description?: string;
  operational?: number;
  restriction?: string;
}

// ARD (Amateur Repeater Directory) schema — CC0-licensed community dataset
// at https://github.com/Amateur-Repeater-Directory/ARD-RepeaterList. Full
// MasterList raw JSON on GitHub.
interface ArdRow {
  repeaterId?: string;
  outputFrequency?: number;
  inputFrequency?: number;
  offset?: number;
  offsetSign?: '+' | '-';
  ctcssTx?: number | null;
  callsign?: string;
  latitude?: number;
  longitude?: number;
  state?: string;
  county?: string;
  nearestCity?: string;
  isOperational?: boolean;
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return NaN;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizeHearHamMode(raw: unknown): RepeaterSuggestion['mode'] {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (s.includes('DMR')) return 'DMR';
  if (s.includes('D-STAR') || s === 'DSTAR' || s === 'D STAR') return 'D-STAR';
  if (s.includes('FUSION') || s === 'YSF' || s === 'C4FM') return 'Fusion';
  return 'FM';
}

function mapHearHamRow(row: HearHamRow): RepeaterSuggestion | null {
  const freqHz = num(row.frequency);
  if (!Number.isFinite(freqHz) || freqHz <= 0) return null;
  const frequency = Math.round((freqHz / 1e6) * 1000) / 1000; // MHz, 3dp
  const offsetHz = num(row.offset);
  const offsetKhz = Number.isFinite(offsetHz) ? Math.round(offsetHz / 1000) : 0;
  const encode = num(row.encode);
  const lat2 = num(row.latitude);
  const lon2 = num(row.longitude);
  const cs = (row.callsign ?? '').toString().trim() || 'UNKNOWN';
  const coverage = (row.city ?? '').toString().trim() || null;
  return {
    name: `${cs} ${frequency}`,
    frequency,
    offsetKhz,
    toneHz: Number.isFinite(encode) && encode > 0 ? encode : null,
    mode: normalizeHearHamMode(row.mode),
    coverage,
    latitude: Number.isFinite(lat2) ? lat2 : null,
    longitude: Number.isFinite(lon2) ? lon2 : null,
  };
}

function ardRowToRepeaterInput(row: ArdRow): RepeaterSuggestion {
  const offsetKhz =
    row.offset != null
      ? Math.round(row.offset * 1000) * (row.offsetSign === '-' ? -1 : 1)
      : 0;
  const coverageParts = [row.nearestCity, row.county, row.state].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  const freq = row.outputFrequency ?? 0;
  return {
    name: `${row.callsign ?? 'Unknown'} ${freq.toFixed(3)}`,
    frequency: freq,
    offsetKhz,
    toneHz: row.ctcssTx != null ? row.ctcssTx : null,
    mode: 'FM',
    coverage: coverageParts.join(', ') || null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
  };
}

// ---- ARD fetch + cache ------------------------------------------------------
// MasterRepeater.json is ~9.3k rows. Pull once per process, refresh every 6h.
const ARD_URL =
  'https://raw.githubusercontent.com/Amateur-Repeater-Directory/ARD-RepeaterList/main/MasterList/MasterRepeater.json';
const ARD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
interface ArdCache {
  rows: ArdRow[];
  fetchedAt: number;
}
let ardCache: ArdCache | null = null;
let ardInFlight: Promise<ArdRow[] | null> | null = null;

export function __resetArdCacheForTests(): void {
  ardCache = null;
  ardInFlight = null;
}

async function loadArdRows(): Promise<ArdRow[] | null> {
  const now = Date.now();
  if (ardCache && now - ardCache.fetchedAt < ARD_CACHE_TTL_MS) {
    return ardCache.rows;
  }
  if (ardInFlight) return ardInFlight;
  ardInFlight = (async () => {
    try {
      const res = await fetch(ARD_URL, {
        signal: AbortSignal.timeout(15000),
        headers: UPSTREAM_HEADERS,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return null;
      ardCache = { rows: data as ArdRow[], fetchedAt: Date.now() };
      return ardCache.rows;
    } catch {
      return null;
    } finally {
      ardInFlight = null;
    }
  })();
  return ardInFlight;
}

async function fetchArdNearby(
  lat: number,
  lon: number,
  distKm: number,
): Promise<RepeaterSuggestion[] | null> {
  const rows = await loadArdRows();
  if (!rows) return null;
  const nearby: Array<{ row: ArdRow; km: number }> = [];
  for (const row of rows) {
    if (row.isOperational === false) continue;
    if (typeof row.latitude !== 'number' || typeof row.longitude !== 'number') continue;
    if (typeof row.outputFrequency !== 'number' || row.outputFrequency <= 0) continue;
    const km = haversineKm(lat, lon, row.latitude, row.longitude);
    if (km > distKm) continue;
    nearby.push({ row, km });
  }
  nearby.sort((a, b) => a.km - b.km);
  return nearby.slice(0, 20).map(({ row }) => ardRowToRepeaterInput(row));
}

// ---- HearHam fetch + cache --------------------------------------------------
// The dataset is ~20k rows (~10-15 MB JSON). Pull it once per process and
// refresh every 6 hours. Exposed for test reset.
const HEARHAM_URL = 'https://hearham.com/api/repeaters/v1';
const HEARHAM_TTL_MS = 6 * 60 * 60 * 1000;
interface HearHamCache {
  rows: HearHamRow[];
  fetchedAt: number;
}
let hearhamCache: HearHamCache | null = null;
let hearhamInFlight: Promise<HearHamRow[] | null> | null = null;

export function __resetHearhamCacheForTests(): void {
  hearhamCache = null;
  hearhamInFlight = null;
}

async function loadHearham(): Promise<HearHamRow[] | null> {
  const now = Date.now();
  if (hearhamCache && now - hearhamCache.fetchedAt < HEARHAM_TTL_MS) {
    return hearhamCache.rows;
  }
  if (hearhamInFlight) return hearhamInFlight;
  hearhamInFlight = (async () => {
    try {
      const res = await fetch(HEARHAM_URL, {
        signal: AbortSignal.timeout(15000),
        headers: UPSTREAM_HEADERS,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return null;
      hearhamCache = { rows: data as HearHamRow[], fetchedAt: Date.now() };
      return hearhamCache.rows;
    } catch {
      return null;
    } finally {
      hearhamInFlight = null;
    }
  })();
  return hearhamInFlight;
}

async function fetchHearhamNearby(
  lat: number,
  lon: number,
  distKm: number,
): Promise<RepeaterSuggestion[] | null> {
  const rows = await loadHearham();
  if (!rows) return null;
  const nearby: Array<{ suggestion: RepeaterSuggestion; km: number }> = [];
  for (const row of rows) {
    if (row.operational === 0) continue;
    const rLat = num(row.latitude);
    const rLon = num(row.longitude);
    if (!Number.isFinite(rLat) || !Number.isFinite(rLon)) continue;
    const km = haversineKm(lat, lon, rLat, rLon);
    if (km > distKm) continue;
    const mapped = mapHearHamRow(row);
    if (!mapped) continue;
    nearby.push({ suggestion: mapped, km });
  }
  nearby.sort((a, b) => a.km - b.km);
  return nearby.slice(0, 20).map((x) => x.suggestion);
}

export type RepeaterSuggestionSource = 'ard' | 'hearham' | 'none';

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
          res.json({ suggestions: [], source: 'none', reason: 'no-location' });
          return;
        }
        lat = lookup.latitude;
        lon = lookup.longitude;
      } else {
        lat = parsed.data.lat;
        lon = parsed.data.lon;
        dist = parsed.data.dist;
      }

      const attempted: string[] = [];

      // Roughly convert miles to km for the in-memory haversine filter.
      const distKm = dist * 1.60934;

      // Primary: Amateur Repeater Directory (ARD) — CC0 github-hosted JSON.
      attempted.push('ard');
      const ardResult = await fetchArdNearby(lat, lon, distKm);
      if (ardResult != null && ardResult.length > 0) {
        res.json({
          suggestions: ardResult,
          source: 'ard' satisfies RepeaterSuggestionSource,
          attempted,
        });
        return;
      }

      // Fallback: HearHam community database.
      attempted.push('hearham');
      const hearham = await fetchHearhamNearby(lat, lon, distKm);
      if (hearham != null && hearham.length > 0) {
        res.json({
          suggestions: hearham,
          source: 'hearham' satisfies RepeaterSuggestionSource,
          attempted,
        });
        return;
      }

      // If any source returned an empty (but non-null) list, treat that as
      // "no nearby" rather than "upstream error" so the user sees a useful
      // message.
      const ardReturnedEmpty = ardResult != null && ardResult.length === 0;
      const hearhamReturnedEmpty = hearham != null && hearham.length === 0;
      const anySucceeded = ardReturnedEmpty || hearhamReturnedEmpty;
      res.json({
        suggestions: [],
        source: 'none' satisfies RepeaterSuggestionSource,
        reason: anySucceeded ? 'no-nearby' : 'upstream-error',
        attempted,
      });
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
