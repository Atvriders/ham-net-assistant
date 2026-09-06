import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';
import { findUlsLicense, ulsAddressLine, type UlsLookupRow } from '../lib/ulsLookup.js';

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

/**
 * Render a local FCC ULS row in the wire shape the SPA already consumes.
 *
 * `gridSquare`, `latitude` and `longitude` are null because the FCC's bulk
 * amateur licence data does not contain coordinates at all — callook derives
 * them by geocoding the street address, which is a service, not a dataset.
 * See the `location` query flag on the route for how callers that need a grid
 * square still get one.
 */
export function ulsToLookupResult(row: UlsLookupRow): LookupResult {
  return {
    callsign: row.callsign,
    name: row.name,
    licenseClass: row.operatorClass,
    country: 'US',
    found: true,
    gridSquare: null,
    latitude: null,
    longitude: null,
    address: ulsAddressLine(row.city, row.state),
  };
}

/**
 * Callsign lookup: the local FCC mirror first, callook.info second.
 *
 * Local first because the mirror is the same FCC data callook republishes, it
 * answers in one indexed read with no network at all, and during a net this
 * route is called once per check-in. callook remains the fallback for every
 * miss — a club that has never imported (empty table), a callsign issued since
 * the last Friday, a non-US call, or one of the handful of rows the importer
 * published without a name because it could not prove whose it was.
 *
 * The response shape is byte-for-byte what it was before the mirror existed;
 * apps/web's RegisterPage, RunNetPage and RepeatersPage all keep working
 * untouched.
 *
 * `?location=1` additionally asks callook for the fields the FCC bulk data
 * cannot carry (grid square and coordinates) and merges them onto the local
 * answer. It exists for RepeatersPage's "use my callsign's grid" button, which
 * is the one caller that needs coordinates; leaving it off is what keeps the
 * hot path — resolving names during a net — entirely offline. A callook failure
 * here is not an error: the local answer is still returned, just without a grid.
 */
export function callsignLookupRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    '/:callsign',
    asyncHandler(async (req, res) => {
      const raw = String(req.params.callsign ?? '').trim().toUpperCase();
      if (!CALLSIGN_RE.test(raw)) {
        throw new HttpError(400, 'VALIDATION', 'Invalid callsign format');
      }

      const local = await findUlsLicense(prisma, raw);
      if (local) {
        const result = ulsToLookupResult(local);
        const wantsLocation = req.query.location === '1' || req.query.location === 'true';
        if (wantsLocation) {
          const remote = await fetchCallookLookup(raw);
          if (remote.found) {
            result.gridSquare = remote.gridSquare;
            result.latitude = remote.latitude;
            result.longitude = remote.longitude;
            // callook's address line carries the ZIP, which the mirror does
            // not store; prefer it when we went to the trouble of asking.
            result.address = remote.address ?? result.address;
          }
        }
        res.json(result);
        return;
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
