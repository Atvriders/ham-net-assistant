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

// Many upstream databases (repeaterbook in particular) 403 requests that
// arrive without a recognizable User-Agent. Node 20's native fetch sends no
// UA header at all by default, which is what was tripping discovery in
// production. Set an explicit, browser-shaped UA on every upstream call.
const UPSTREAM_UA =
  'Mozilla/5.0 (compatible; HamNetAssistant/1.0; +https://github.com/Atvriders/ham-net-assistant)';
const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent': UPSTREAM_UA,
  Accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
};

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

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

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

function extractStateCode(addressLine2: string | null): string | null {
  if (!addressLine2) return null;
  // Format: "MANHATTAN, KS 66502"
  const m = addressLine2.match(/,\s*([A-Z]{2})\s+\d{5}/);
  return m ? m[1]! : null;
}

function mapRow(row: RepeaterbookRow): RepeaterSuggestion | null {
  const frequency = num(row.Frequency);
  if (!Number.isFinite(frequency)) return null;
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
  return {
    name: `${cs} ${frequency}`,
    frequency,
    offsetKhz,
    toneHz: Number.isFinite(tone) && tone > 0 ? tone : null,
    mode: 'FM',
    coverage: coverage || null,
    latitude: Number.isFinite(lat2) ? lat2 : null,
    longitude: Number.isFinite(lon2) ? lon2 : null,
  };
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

async function fetchRepeaterbookProx(
  lat: number,
  lon: number,
  dist: number,
): Promise<RepeaterSuggestion[] | null> {
  try {
    const url = `https://www.repeaterbook.com/api/export.php?qtype=prox&lat=${lat}&long=${lon}&dist=${dist}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: UPSTREAM_HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RepeaterbookResponse;
    const rows = Array.isArray(data.results) ? data.results : [];
    const mapped: RepeaterSuggestion[] = [];
    for (const row of rows) {
      const m = mapRow(row);
      if (!m) continue;
      mapped.push(m);
      if (mapped.length >= 20) break;
    }
    return mapped;
  } catch {
    return null;
  }
}

async function fetchRepeaterbookRowProx(
  lat: number,
  lon: number,
  dist: number,
): Promise<RepeaterSuggestion[] | null> {
  try {
    const url = `https://www.repeaterbook.com/api/exportROW.php?qtype=prox&lat=${lat}&long=${lon}&dist=${dist}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: UPSTREAM_HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RepeaterbookResponse;
    const rows = Array.isArray(data.results) ? data.results : [];
    const mapped: RepeaterSuggestion[] = [];
    for (const row of rows) {
      const m = mapRow(row);
      if (!m) continue;
      mapped.push(m);
      if (mapped.length >= 20) break;
    }
    return mapped;
  } catch {
    return null;
  }
}

async function fetchRepeaterbookState(
  stateName: string,
  lat: number | null,
  lon: number | null,
): Promise<RepeaterSuggestion[] | null> {
  try {
    const url = `https://www.repeaterbook.com/api/export.php?qtype=state&state=${encodeURIComponent(stateName)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: UPSTREAM_HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RepeaterbookResponse;
    const rows = Array.isArray(data.results) ? data.results : [];
    const mapped: RepeaterSuggestion[] = [];
    for (const row of rows) {
      const m = mapRow(row);
      if (!m) continue;
      mapped.push(m);
    }
    if (lat != null && lon != null) {
      mapped.sort((a, b) => {
        const aLat = a.latitude ?? 0;
        const aLon = a.longitude ?? 0;
        const bLat = b.latitude ?? 0;
        const bLon = b.longitude ?? 0;
        return haversineKm(lat, lon, aLat, aLon) - haversineKm(lat, lon, bLat, bLon);
      });
      return mapped.slice(0, 20);
    }
    return mapped.slice(0, 20);
  } catch {
    return null;
  }
}

export type RepeaterSuggestionSource =
  | 'hearham'
  | 'repeaterbook-prox'
  | 'repeaterbook-row'
  | 'repeaterbook-state'
  | 'none';

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
      let stateName: string | null = null;
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
        const code = extractStateCode(lookup.address);
        if (code && US_STATES[code]) {
          stateName = US_STATES[code];
        }
      } else {
        lat = parsed.data.lat;
        lon = parsed.data.lon;
        dist = parsed.data.dist;
      }

      const attempted: string[] = [];

      // Primary: HearHam (open-data, reliable, single cached blob).
      // Roughly convert miles to km for the in-memory haversine filter.
      const distKm = dist * 1.60934;
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

      // Fallback 1: RepeaterBook US prox.
      attempted.push('repeaterbook-prox');
      const proxResult = await fetchRepeaterbookProx(lat, lon, dist);
      if (proxResult != null && proxResult.length > 0) {
        res.json({
          suggestions: proxResult,
          source: 'repeaterbook-prox' satisfies RepeaterSuggestionSource,
          attempted,
        });
        return;
      }

      // Fallback 2: RepeaterBook "rest of world" prox endpoint.
      attempted.push('repeaterbook-row');
      const rowResult = await fetchRepeaterbookRowProx(lat, lon, dist);
      if (rowResult != null && rowResult.length > 0) {
        res.json({
          suggestions: rowResult,
          source: 'repeaterbook-row' satisfies RepeaterSuggestionSource,
          attempted,
        });
        return;
      }

      // Fallback 3: RepeaterBook US state-wide, sorted by distance
      // (callsign variant only — we need a state code from callook).
      if (stateName) {
        attempted.push('repeaterbook-state');
        const stateResult = await fetchRepeaterbookState(stateName, lat, lon);
        if (stateResult != null && stateResult.length > 0) {
          res.json({
            suggestions: stateResult,
            source: 'repeaterbook-state' satisfies RepeaterSuggestionSource,
            attempted,
          });
          return;
        }
      }

      // If hearham returned an empty (but non-null) list AND every
      // other source also returned nothing, treat that as "no nearby"
      // rather than "upstream error" so the user sees a useful message.
      const hearhamReturnedEmpty = hearham != null && hearham.length === 0;
      const proxReturnedEmpty = proxResult != null && proxResult.length === 0;
      const rowReturnedEmpty = rowResult != null && rowResult.length === 0;
      const anySucceeded = hearhamReturnedEmpty || proxReturnedEmpty || rowReturnedEmpty;
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
