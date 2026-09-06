import type { PrismaClient } from '@prisma/client';

/**
 * Reading the local FCC ULS mirror (see ulsImport.ts).
 *
 * This is the offline half of every callsign lookup in the app. It is one
 * primary-key seek against a table the club owns, so it costs nothing and works
 * with the uplink down; callook.info remains the fallback for anything the
 * mirror cannot answer.
 */

/** A published ULS row: active, and carrying at least a name. */
export interface UlsLookupRow {
  callsign: string;
  name: string;
  operatorClass: string | null;
  city: string | null;
  state: string | null;
}

/**
 * Find a callsign in the local mirror, or null.
 *
 * Two filters make "found" mean "can actually answer the question":
 *
 *  - `status: 'A'` — the publish flag. Rows the importer wrote from EN.dat or
 *    AM.dat before HD.dat confirmed the licence have status NULL, so a lookup
 *    running during (or after an interruption of) an import never reads a
 *    half-imported record. See the interruption notes in ulsImport.ts.
 *  - a non-null `name` — a handful of rows are published with no name because
 *    the importer could not prove the name it had belonged to the licence the
 *    FCC marks active (the callsign-reuse case). Treating those as a miss sends
 *    them to callook, which is a real answer instead of a blank one.
 *
 * A club that has never run an import has an empty table, so every lookup is a
 * miss and the app behaves exactly as it did before the mirror existed.
 */
export async function findUlsLicense(
  prisma: PrismaClient,
  callsign: string,
): Promise<UlsLookupRow | null> {
  const key = callsign.trim().toUpperCase();
  if (!key) return null;
  const row = await prisma.ulsLicense.findFirst({
    where: { callsign: key, status: 'A', NOT: { name: null } },
    select: { callsign: true, name: true, operatorClass: true, city: true, state: true },
  });
  if (!row || !row.name) return null;
  return {
    callsign: row.callsign,
    name: row.name,
    operatorClass: row.operatorClass,
    city: row.city,
    state: row.state,
  };
}

/**
 * "CITY, ST" for the lookup response's `address` field.
 *
 * callook returns its address line 2 as "MANHATTAN, KS 66502". The ZIP is
 * deliberately not stored — nothing in the app renders it — so the local answer
 * is the same line without it rather than a different shape.
 */
export function ulsAddressLine(city: string | null, state: string | null): string | null {
  if (city && state) return `${city}, ${state}`;
  return city || state || null;
}
