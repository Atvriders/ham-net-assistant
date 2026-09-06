import type { Prisma, PrismaClient } from '@prisma/client';

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
 * How a callsign becomes a mirror key. Trim + uppercase, nothing else.
 *
 * Exported so there is ONE such rule in the codebase. The ULS name-sync admin
 * action matches hundreds of stored callsigns against this table in bulk, and
 * a second, subtly different normalisation there (stripping a `/M` suffix,
 * say) would make the bulk rewrite disagree with the single lookup the rest of
 * the app performs — on an FCC-facing log, with no per-row review.
 *
 * A portable-operation callsign such as `W1AW/M` deliberately does NOT match:
 * it is not a key the FCC issues, so it is a miss, and a miss is always
 * treated as "leave this name alone".
 */
export function normalizeCallsign(callsign: string): string {
  return callsign.trim().toUpperCase();
}

/**
 * The predicate that makes a mirror row answerable — the `status`/`name`
 * filters documented on {@link findUlsLicense}, in one place so the single and
 * bulk readers cannot drift apart.
 */
function publishedRow(): Prisma.UlsLicenseWhereInput {
  return { status: 'A', NOT: { name: null } };
}

/**
 * The stored name, or null when it is not a name anyone can be called.
 *
 * `NOT: { name: null }` is a SQL predicate and cannot see the difference
 * between "Robert Bobson" and `"   "`. EN.dat is a pipe-delimited text file
 * and the importer's own formatter ends on `titleCase(entityName) || null`, so
 * a padded or quoted-empty entity name can reach the table as whitespace. That
 * matters far more here than on the lookup path: the ULS name-sync writes this
 * value straight over `CheckIn.nameAtCheckIn`, and a whitespace name is a
 * blanked log entry — the one outcome the whole feature promises never to
 * produce. Trimmed rather than merely rejected, so the single and bulk readers
 * return the same string for the same row.
 */
function usableName(name: string | null): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Chunk size for the bulk name reader.
 *
 * Every key is a bound parameter, and SQLITE_MAX_VARIABLE_NUMBER is 999 on
 * older builds (see the same note in ulsImport.ts). 500 stays well under that
 * on whatever SQLite the club's image happens to carry.
 */
const BULK_LOOKUP_CHUNK = 500;

/**
 * Resolve many callsigns to their published ULS names in one pass.
 *
 * Same normalisation and same publish filter as {@link findUlsLicense}, so
 * "found here" and "found there" mean exactly the same thing; the only
 * difference is that this answers a whole log's worth of callsigns in a
 * handful of indexed `IN` seeks instead of one query per station.
 *
 * Keys of the returned map are NORMALISED callsigns, and a callsign that is
 * absent, unpublished, or nameless is simply missing from the map. There is no
 * null-valued entry: "no name" and "no row" are the same answer to the only
 * caller that asks, and both mean "do not touch the stored name".
 */
export async function findUlsNames(
  prisma: PrismaClient,
  callsigns: Iterable<string>,
): Promise<Map<string, string>> {
  const keys = [...new Set([...callsigns].map(normalizeCallsign))].filter((k) => k !== '');
  const found = new Map<string, string>();
  for (let i = 0; i < keys.length; i += BULK_LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + BULK_LOOKUP_CHUNK);
    const rows = await prisma.ulsLicense.findMany({
      where: { callsign: { in: chunk }, ...publishedRow() },
      select: { callsign: true, name: true },
    });
    for (const row of rows) {
      const name = usableName(row.name);
      if (name) found.set(row.callsign, name);
    }
  }
  return found;
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
  const key = normalizeCallsign(callsign);
  if (!key) return null;
  const row = await prisma.ulsLicense.findFirst({
    where: { callsign: key, ...publishedRow() },
    select: { callsign: true, name: true, operatorClass: true, city: true, state: true },
  });
  if (!row) return null;
  const name = usableName(row.name);
  if (!name) return null;
  return {
    callsign: row.callsign,
    name,
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
