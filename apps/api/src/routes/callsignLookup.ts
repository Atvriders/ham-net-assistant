import { Router } from 'express';
import { asyncHandler } from '../middleware/async.js';
import { HttpError } from '../middleware/error.js';

const CALLSIGN_RE = /^[A-Z0-9]{3,7}$/;

interface LookupResult {
  callsign: string;
  name: string | null;
  licenseClass: string | null;
  country: string;
  found: boolean;
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
      try {
        const remote = await fetch(`https://callook.info/${raw}/json`, {
          signal: AbortSignal.timeout(4000),
          headers: { 'User-Agent': 'HamNetAssistant/1.0' },
        });
        if (!remote.ok) {
          res.json({
            callsign: raw,
            name: null,
            licenseClass: null,
            country: 'US',
            found: false,
          } satisfies LookupResult);
          return;
        }
        const data = (await remote.json()) as {
          status?: string;
          name?: string;
          current?: { operClass?: string };
        };
        if (data.status !== 'VALID') {
          res.json({
            callsign: raw,
            name: null,
            licenseClass: null,
            country: 'US',
            found: false,
          } satisfies LookupResult);
          return;
        }
        const rawName = (data.name ?? '').trim();
        const parts = rawName.split(/\s+/).filter(Boolean);
        const prettyName =
          parts.length >= 2
            ? `${titleCase(parts.slice(1).join(' '))} ${titleCase(parts[0]!)}`
            : titleCase(rawName);
        res.json({
          callsign: raw,
          name: prettyName || null,
          licenseClass: data.current?.operClass ?? null,
          country: 'US',
          found: true,
        } satisfies LookupResult);
      } catch {
        res.json({
          callsign: raw,
          name: null,
          licenseClass: null,
          country: 'US',
          found: false,
        } satisfies LookupResult);
      }
    }),
  );

  return router;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
