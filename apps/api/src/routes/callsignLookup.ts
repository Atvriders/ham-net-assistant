import { Router } from 'express';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';

const CALLSIGN_RE = /^[A-Z0-9]{3,7}$/;

export interface LookupResult {
  callsign: string;
  name: string | null;
  licenseClass: string | null;
  country: string;
  found: boolean;
  gridSquare: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

interface CallookRaw {
  status?: string;
  name?: string;
  current?: { operClass?: string };
  address?: { line1?: string; line2?: string };
  location?: { latitude?: string; longitude?: string; gridsquare?: string };
}

function emptyResult(callsign: string): LookupResult {
  return {
    callsign,
    name: null,
    licenseClass: null,
    country: 'US',
    found: false,
    gridSquare: null,
    latitude: null,
    longitude: null,
    address: null,
  };
}

function parseNum(s: unknown): number | null {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetches and parses a callook.info record for the given callsign.
 * Returns a normalized LookupResult; swallows network/parse errors by
 * returning a found:false result so callers don't need to try/catch.
 */
export async function fetchCallookLookup(callsign: string): Promise<LookupResult> {
  const raw = callsign.trim().toUpperCase();
  try {
    const remote = await fetch(`https://callook.info/${raw}/json`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'HamNetAssistant/1.0' },
    });
    if (!remote.ok) return emptyResult(raw);
    const data = (await remote.json()) as CallookRaw;
    if (data.status !== 'VALID') return emptyResult(raw);

    const rawName = (data.name ?? '').trim();
    const parts = rawName.split(/\s+/).filter(Boolean);
    // callook returns individual names as "FIRST [MIDDLE...] LAST"
    // (e.g. "JOHN MICHAEL SMITH"). We emit only "First Last"; any
    // middle names/initials are dropped. Compound last names like
    // "van der Berg" are mis-parsed because callook doesn't distinguish
    // them from middle names — we accept this limitation.
    let prettyName: string;
    if (parts.length === 0) {
      prettyName = '';
    } else if (parts.length === 1) {
      prettyName = titleCase(parts[0]!);
    } else {
      prettyName = `${titleCase(parts[0]!)} ${titleCase(parts[parts.length - 1]!)}`;
    }

    return {
      callsign: raw,
      name: prettyName || null,
      licenseClass: data.current?.operClass ?? null,
      country: 'US',
      found: true,
      gridSquare: data.location?.gridsquare ?? null,
      latitude: parseNum(data.location?.latitude),
      longitude: parseNum(data.location?.longitude),
      address: data.address?.line2 ?? null,
    };
  } catch {
    return emptyResult(raw);
  }
}

export function callsignLookupRouter(): Router {
  const router = Router();

  router.get(
    '/:callsign',
    asyncHandler(async (req, res) => {
      const raw = String(req.params.callsign ?? '').trim().toUpperCase();
      if (!CALLSIGN_RE.test(raw)) {
        throw new HttpError(400, 'VALIDATION', 'Invalid callsign format');
      }
      const result = await fetchCallookLookup(raw);
      res.json(result);
    }),
  );

  return router;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
