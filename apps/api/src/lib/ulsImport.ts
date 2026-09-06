import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Prisma, PrismaClient } from '@prisma/client';
import unzipper from 'unzipper';
import { safeFetch } from './safeFetch.js';

/**
 * Weekly import of the FCC ULS amateur licence database into a local table.
 *
 * WHY: every callsign lookup in this app currently costs an outbound request to
 * callook.info. During a net that is one request per check-in, on a club's
 * uplink, against a service nobody here operates — and when it is down or slow,
 * net control is typing names by hand. The FCC publishes the same data as a
 * weekly bulk dump, so a club can hold its own copy and answer lookups offline
 * in one indexed read.
 *
 * ── The resource problem, which is the whole design ─────────────────────────
 * l_amat.zip is ~190 MB compressed and ~730 MB expanded across nine members.
 * This runs in a container with mem_limit 768m that is also serving a live net.
 * So:
 *
 *  1. NOTHING is buffered. The HTTP response body is piped straight into a
 *     streaming zip reader, each member is piped through a line splitter, and
 *     each line is parsed and dropped. The archive is never written to disk and
 *     no .dat file is ever held in memory. Peak heap is one batch of pending
 *     rows plus stream buffers — a few MB, flat, regardless of dump size.
 *
 *  2. NOTHING is joined in memory. The obvious implementation keys a Map on
 *     unique_system_identifier while the three members stream past; at 1.69 M
 *     records per member that Map is 150-250 MB and would put the container
 *     within sight of its ceiling on net night. Instead the DATABASE is the
 *     join buffer: every member upserts into UlsLicense as it streams, and the
 *     rows meet each other there. Cost of that choice, stated plainly: we write
 *     ~4.2 M upserts to publish ~824 K rows, because AM.dat and EN.dat carry a
 *     row for every expired and cancelled licence too and we cannot know which
 *     are live until HD.dat (the last member we read) tells us.
 *
 *  3. The transfer stops early. Only AM.dat, EN.dat and HD.dat matter, and in
 *     the FCC's archive layout HD.dat is the last of the three; HS.dat and
 *     friends that follow it are ~39 MB we never need, so the socket is closed
 *     as soon as HD.dat has gone past. ~155 MB on the wire instead of ~190 MB.
 *
 * ── Not locking the club out of its own database ────────────────────────────
 * SQLite has one writer. A single transaction around 800 K rows would hold it
 * for minutes and every check-in typed during that window would fail. So writes
 * go in {@link ULS_BATCH_ROWS}-row transactions with an event-loop yield
 * between them (see {@link yieldToEventLoop}); a pending HTTP request runs in
 * that gap, and the longest any request can wait behind the importer is one
 * batch. See ULS_BATCH_ROWS for why that number.
 *
 * ── Surviving an interrupted run ────────────────────────────────────────────
 * A container can be restarted at any instant — mid-download, mid-batch. The
 * table must never answer a lookup with a half-imported record, and it must
 * never go empty, because "no row" silently means "ask callook instead".
 *
 * Rejected: staging table + swap. The swap is either one enormous transaction
 * (the lock-out above) or a delete-then-copy with a window where the table is
 * EMPTY, and being restarted inside that window leaves the club with no local
 * data at all until the following Friday.
 *
 * Chosen: a generation counter plus a publish flag, with in-place upserts.
 *
 *   - `status` is the publish flag. Every lookup reads WHERE status = 'A'.
 *     Only the HD.dat pass ever SETS it, and only for licences the FCC marks
 *     ACTIVE. Rows conjured by the AM/EN passes for licences that turn out to
 *     be expired have status NULL and are invisible from the moment they are
 *     written, so a crash at any point cannot expose them.
 *     The AM/EN passes do CLEAR it, in the one case where they move a row onto
 *     a different licence than the published one — see EN_UPSERT_SQL. Without
 *     that the second and later imports mutate rows that are already live, and
 *     a crash between the EN pass and the HD pass leaves a handful of callsigns
 *     answering with the PREVIOUS holder's name for a week.
 *   - `statusGeneration` records which run last confirmed the row ACTIVE.
 *     After a run completes -- and only then -- everything the run did not
 *     confirm is swept in batches. A run that dies half way sweeps nothing, so
 *     it leaves a table holding a mix of this week's and last week's confirmed
 *     rows: both are genuine FCC records, so every lookup is still answered
 *     correctly, just some of them a week stale. The next run re-stamps what is
 *     still live and sweeps the remainder.
 *   - Re-running is therefore idempotent by construction: every write is an
 *     upsert keyed on callsign, so importing the same dump twice leaves exactly
 *     one row per callsign.
 *
 * A run that produces implausibly few active callsigns (a truncated download, a
 * mirror serving an error page as a zip, an FCC format change) is failed
 * WITHOUT sweeping — see {@link ULS_MIN_ACTIVE_CALLSIGNS}. Last week's data
 * stays published, which is the right answer when this week's is not
 * trustworthy.
 *
 * ── Joining the three members ───────────────────────────────────────────────
 * See {@link HD_STATUS} and the usi guard in {@link EN_UPSERT_SQL}: the members
 * are joined on unique_system_identifier, NOT on callsign, because callsigns are
 * reissued. Measured on the 2026-08-30 dump: 75,967 of 823,953 active callsigns
 * (9.2%) also carry an expired or cancelled licence row belonging to a previous
 * holder, so a callsign-keyed import puts the wrong name on roughly one active
 * callsign in eleven.
 */

/**
 * Members we read. The real archive orders them AM, EN, HD (alphabetically),
 * which is also the order this design wants: HD.dat is what proves which
 * licence a callsign's fields came from, so reading it last means the ~99
 * inverted-usi callsigns are corrected in the same pass that publishes them.
 * Nothing BREAKS if the FCC reorders the archive — the AM/EN unpublish arm
 * keeps an unproven name from ever being served either way — but with HD first
 * those callsigns end up unpublished for the week rather than published with
 * no name, i.e. a callook fallback instead of a callook fallback. Do not
 * "optimise" by assuming an order beyond that.
 */
const AM_DAT = 'AM.dat';
const EN_DAT = 'EN.dat';
const HD_DAT = 'HD.dat';
/** Tiny manifest the FCC ships inside the archive; carries the dump's own date. */
const COUNTS = 'counts';
const WANTED_MEMBERS: ReadonlySet<string> = new Set([AM_DAT, EN_DAT, HD_DAT]);

/**
 * Rows per write transaction.
 *
 * 2,000 is chosen from both ends. Below ~500 the per-transaction cost (a WAL
 * commit and its fsync) dominates and the import takes far longer than it needs
 * to, which means more total time during which the club shares a writer with
 * it. Above ~5,000 the throughput curve has flattened but the time the writer
 * is held keeps growing linearly, and that time is exactly what a check-in
 * typed mid-import has to wait through. At 2,000 a batch commits in tens of
 * milliseconds — under the 5 s busy_timeout that db.ts sets, with three orders
 * of magnitude to spare — and the event loop is handed back between every one.
 */
export const ULS_BATCH_ROWS = 2000;

/**
 * Bound parameters per SQL statement.
 *
 * A batch is one TRANSACTION but several statements: SQLite's
 * SQLITE_MAX_VARIABLE_NUMBER is 32,766 on modern builds but only 999 on older
 * ones, and this ships to whatever SQLite the club's image happens to carry.
 * 900 is under the historic floor, so a batch is split into however many
 * multi-row INSERTs that allows and they all commit together.
 */
const MAX_BOUND_PARAMS = 900;

/**
 * Write batches between WAL checkpoints.
 *
 * Measured, not guessed: an unthrottled import pushed ham.db-wal to 1.5 GB —
 * ten times the size of the database it was writing into. SQLite's automatic
 * checkpoint copies WAL pages back into the database but can only RESET the
 * file when no reader holds a snapshot, and a club's app is reading constantly,
 * so under sustained writes the WAL only ever grows. The API process holds its
 * connection open for months, so nothing would have reclaimed that until the
 * next container restart: a permanent 1.5 GB in the /data volume as the price
 * of one weekly refresh.
 *
 * A TRUNCATE checkpoint every 25 batches (50,000 rows) caps it at tens of MB.
 * The cost is ~100 short pauses across a four-minute job that runs at 03:00.
 */
const CHECKPOINT_EVERY_BATCHES = 25;

/**
 * Below this many confirmed-active callsigns, a run is treated as a bad
 * download rather than a real dump and is failed without sweeping.
 *
 * The real number is ~824,000 and has been in the high hundreds of thousands
 * for decades; 100,000 is far enough below to never fire on a genuine dump and
 * far enough above zero to catch a truncated transfer, an HTML error page with
 * a .zip name, or an FCC column change that makes every row unparseable.
 */
export const ULS_MIN_ACTIVE_CALLSIGNS = 100_000;

/**
 * Whole-run budget for the transfer. A club on a slow ADSL uplink can
 * legitimately need half an hour for 155 MB, so this is generous; it exists so
 * a stalled socket cannot pin the importer (and its in-flight guard) forever.
 */
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

/** Failure text is stored in a DB column and logged; keep it bounded. */
const ERROR_TEXT_LIMIT = 500;

// ── Record layouts ──────────────────────────────────────────────────────────
// Field positions are 0-based indexes into the pipe-split line and were
// verified against the 2026-08-30 dump, not just the FCC's published record
// layouts. Every member has a fixed column count there (AM 18, EN 30, HD 59),
// but we check only that a line is long enough to carry the fields we read:
// the FCC has appended columns to these files before, and a strict equality
// check would turn "FCC added a column" into "every row is malformed and the
// club's data silently stops refreshing".

/** unique_system_identifier — the join key, present in every member. */
const F_USI = 1;
/** call_sign — also present in every member, but NOT unique across licences. */
const F_CALLSIGN = 4;

/** AM.dat: | AM | usi | file | ebf | call_sign | operator_class | group | ... */
const AM_MIN_FIELDS = 6;
const AM_OPERATOR_CLASS = 5;

/** EN.dat: | EN | usi | file | ebf | call_sign | entity_type | licensee_id | entity_name | first | mi | last | ... */
const EN_MIN_FIELDS = 18;
const EN_ENTITY_TYPE = 5;
const EN_ENTITY_NAME = 7;
const EN_FIRST_NAME = 8;
const EN_LAST_NAME = 10;
const EN_CITY = 16;
const EN_STATE = 17;

/** HD.dat: | HD | usi | file | ebf | call_sign | license_status | radio_service | ... */
const HD_MIN_FIELDS = 6;
const HD_LICENSE_STATUS = 5;

/**
 * The only licence status we store. HD.dat also carries E (expired),
 * C (cancelled) and T (terminated); in the 2026-08-30 dump 823,953 of
 * 1,694,648 rows were 'A'.
 */
const HD_STATUS = 'A';

/**
 * EN.dat's entity_type for the licensee itself. 100% of rows in the sampled
 * dump are 'L'; anything else would be a contact or representative record and
 * must not be allowed to overwrite the licensee's name. Blank is accepted so a
 * future dump that stops populating the column still imports.
 */
const EN_LICENSEE_TYPES: ReadonlySet<string> = new Set(['L', '']);

/**
 * ULS operator_class codes, rendered in callook.info's vocabulary so the SPA
 * cannot tell a local hit from a remote one. Club stations carry no class.
 */
const OPERATOR_CLASS_LABEL: Readonly<Record<string, string>> = {
  A: 'ADVANCED',
  E: 'EXTRA',
  G: 'GENERAL',
  N: 'NOVICE',
  P: 'TECHNICIAN PLUS',
  T: 'TECHNICIAN',
};

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * What one source line produced.
 *
 * `malformed` and `ignored` are deliberately different: a line with too few
 * columns is a defect worth counting and surfacing, whereas an expired licence
 * or a club with no operator class is perfectly ordinary data we have no use
 * for. Folding them together would bury a real format change under a six-digit
 * "skipped" number that is normal.
 */
export type RowResult<T> =
  | { kind: 'row'; value: T }
  | { kind: 'malformed' }
  | { kind: 'ignored' };

const MALFORMED = { kind: 'malformed' } as const;
const IGNORED = { kind: 'ignored' } as const;

/**
 * Read one field, trimmed, with a defensive unquote.
 *
 * ULS .dat files are not RFC 4180: no field in any sampled dump is quoted. The
 * unquote is here so that if one ever is, the value is stored as its content
 * rather than with literal quotation marks around it. Applied only to the four
 * or five fields per row we actually keep — doing it to all 59 columns of HD.dat
 * would be 100 M wasted string operations per import.
 */
export function readField(fields: readonly string[], index: number): string {
  const raw = fields[index];
  if (raw === undefined) return '';
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.charCodeAt(0) === 34 &&
    trimmed.charCodeAt(trimmed.length - 1) === 34
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
}

/** Title-case a name the way the callook path already does, so both agree. */
export function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the display name for an EN.dat row.
 *
 * Individuals carry structured first/last columns, which is strictly better
 * than what callook offers (it returns one "FIRST MIDDLE LAST" string that the
 * existing parser has to guess at). Middle names are dropped, matching the
 * existing behaviour.
 *
 * Clubs and organisations have no first/last; their name lives in entity_name
 * and is kept whole — "Central Arizona Dx Assn", where the callook path's
 * first-word-plus-last-word heuristic would have produced "Central Assn".
 *
 * entity_name for an individual is "LAST, FIRST M", so if that is all we have,
 * the comma is used to put it back in reading order.
 */
export function formatUlsName(
  firstName: string,
  lastName: string,
  entityName: string,
): string | null {
  if (firstName && lastName) return `${titleCase(firstName)} ${titleCase(lastName)}`;
  if (lastName) return titleCase(lastName);
  if (firstName) return titleCase(firstName);
  if (!entityName) return null;
  const comma = entityName.indexOf(',');
  if (comma > 0) {
    const surname = entityName.slice(0, comma).trim();
    const given = entityName.slice(comma + 1).trim().split(/\s+/)[0] ?? '';
    if (surname && given) return `${titleCase(given)} ${titleCase(surname)}`;
  }
  return titleCase(entityName) || null;
}

/** Fields shared by every parsed row. */
interface JoinKey {
  usi: number;
  callsign: string;
}

export interface AmRow extends JoinKey {
  operatorClass: string | null;
}
export interface EnRow extends JoinKey {
  name: string | null;
  city: string | null;
  state: string | null;
}
export type HdRow = JoinKey;

/**
 * usi and callsign, or null when the line cannot supply both. A row without
 * them cannot be joined or looked up, so it is worthless whatever else it says.
 */
function joinKey(fields: readonly string[]): JoinKey | null {
  const usi = Number(readField(fields, F_USI));
  const callsign = readField(fields, F_CALLSIGN).toUpperCase();
  if (!callsign) return null;
  if (!Number.isInteger(usi) || usi <= 0) return null;
  return { usi, callsign };
}

/** Split a .dat line into fields. Exported so tests can assert on it. */
export function splitDatLine(line: string): string[] {
  return line.split('|');
}

export function parseAmLine(line: string): RowResult<AmRow> {
  const fields = splitDatLine(line);
  if (fields.length < AM_MIN_FIELDS) return MALFORMED;
  const key = joinKey(fields);
  if (!key) return MALFORMED;
  const code = readField(fields, AM_OPERATOR_CLASS).toUpperCase();
  // Club stations have no operator class. Writing a null over a null is pure
  // cost, so those rows are dropped here rather than in the database.
  if (!code) return IGNORED;
  const label = OPERATOR_CLASS_LABEL[code];
  if (!label) return IGNORED;
  return { kind: 'row', value: { ...key, operatorClass: label } };
}

export function parseEnLine(line: string): RowResult<EnRow> {
  const fields = splitDatLine(line);
  if (fields.length < EN_MIN_FIELDS) return MALFORMED;
  const key = joinKey(fields);
  if (!key) return MALFORMED;
  if (!EN_LICENSEE_TYPES.has(readField(fields, EN_ENTITY_TYPE).toUpperCase())) return IGNORED;
  const name = formatUlsName(
    readField(fields, EN_FIRST_NAME),
    readField(fields, EN_LAST_NAME),
    readField(fields, EN_ENTITY_NAME),
  );
  const city = readField(fields, EN_CITY) || null;
  const state = readField(fields, EN_STATE).toUpperCase() || null;
  // Nothing we would store: not malformed, just empty.
  if (name === null && city === null && state === null) return IGNORED;
  return { kind: 'row', value: { ...key, name, city, state } };
}

export function parseHdLine(line: string): RowResult<HdRow> {
  const fields = splitDatLine(line);
  if (fields.length < HD_MIN_FIELDS) return MALFORMED;
  const key = joinKey(fields);
  if (!key) return MALFORMED;
  if (readField(fields, HD_LICENSE_STATUS).toUpperCase() !== HD_STATUS) return IGNORED;
  return { kind: 'row', value: key };
}

// ── Line reading ────────────────────────────────────────────────────────────

/**
 * Cap on the partial record carried across chunk boundaries.
 *
 * `forEachLine` is the reason no .dat file is ever held in memory, and this is
 * the one thing that could break that promise: if a member arrives with no
 * newline in it — a truncated write, a member that is not the text file its
 * name claims, a future FCC format change — the carry buffer grows to the whole
 * decompressed member. HD.dat alone expands to ~400 MB, which is an OOM kill of
 * the container that is also running the club's net, not a failed import.
 * 1 MB is thousands of times the longest real record (HD.dat's are ~250 bytes),
 * so nothing genuine can trip it. Checked once per CHUNK, never per line, so
 * the five-million-iteration inner loop is untouched.
 */
const MAX_RECORD_BYTES = 1_000_000;

/**
 * Feed a stream to `onLine`, one record at a time, without ever holding more
 * than the current chunk plus a partial line.
 *
 * latin1, not utf8: ULS is single-byte, and with a single-byte decoding a chunk
 * boundary can never split a character — no stateful decoder, no replacement
 * characters on a stray accented byte.
 *
 * `onLine` may return a promise; it is awaited only when it actually does,
 * because awaiting a non-promise 4 million times costs a microtask each. The
 * await is what applies backpressure: while a batch is being written the source
 * stream — and therefore the download — is paused.
 */
export async function forEachLine(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  let carry = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const text = carry + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      // CRLF: the FCC ships \r\n, so strip a trailing CR from every record.
      const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      if (end > start) {
        const pending = onLine(text.slice(start, end));
        if (pending) await pending;
      }
      start = nl + 1;
    }
    carry = text.slice(start);
    if (carry.length > MAX_RECORD_BYTES) {
      throw new Error(
        `record exceeded ${MAX_RECORD_BYTES} bytes with no line ending — ` +
          'the member is not the text file it claims to be',
      );
    }
  }
  // Last record when the file does not end with a newline.
  const tail = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
  if (tail.length > 0) {
    const pending = onLine(tail);
    if (pending) await pending;
  }
}

/** Hand the event loop back so pending HTTP requests are served. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * EN.dat -> UlsLicense.
 *
 * The `WHERE excluded.usi >= UlsLicense.usi` guard on the conflict clause is
 * the callsign-reuse defence: when two licences share a callsign, the newer
 * (higher usi) one wins, so a previous holder's row streaming past later cannot
 * overwrite the current holder's name. That is right for all but ~99 of 823,953
 * callsigns, and the HD pass below catches even those.
 *
 * It never SETS `status` or `statusGeneration` — only HD.dat publishes — but it
 * does UNPUBLISH: `status` is cleared whenever this statement moves a row to a
 * different licence than the one currently published.
 *
 * That arm is not decoration. On the second and later imports the row it is
 * overwriting is already published from last week, so without it the fields
 * change underneath a live `status = 'A'` and the club is served a name the
 * import has not yet proved. Two ways that goes wrong:
 *
 *   - the ~99 callsigns whose ACTIVE licence is NOT their highest-numbered one:
 *     the previous holder's EN row wins the usi guard, and between this pass
 *     and HD.dat the lookup answers with the PREVIOUS HOLDER'S NAME. If the run
 *     dies or fails in that gap, it answers that way until the next Friday.
 *   - a callsign that genuinely changed hands: for the same gap the row carries
 *     the new licence's usi and the old holder's published status.
 *
 * Clearing status turns both into a miss, which falls through to callook — a
 * blank answer instead of a confidently wrong one, which is the same trade the
 * HD pass makes for those 99. A row whose usi is unchanged (the overwhelming
 * majority, week after week) keeps its published status and is never hidden.
 */
const EN_UPSERT_SQL = (rows: number): string =>
  `INSERT INTO "UlsLicense" ("callsign","usi","name","city","state") VALUES ${placeholders(rows, 5)}
   ON CONFLICT("callsign") DO UPDATE SET
     "name" = excluded."name",
     "city" = excluded."city",
     "state" = excluded."state",
     "status" = CASE WHEN "UlsLicense"."usi" = excluded."usi" THEN "UlsLicense"."status" ELSE NULL END,
     "usi" = excluded."usi"
   WHERE excluded."usi" >= "UlsLicense"."usi"`;

/** AM.dat -> UlsLicense. Same usi guard, same unpublish-on-relicence arm. */
const AM_UPSERT_SQL = (rows: number): string =>
  `INSERT INTO "UlsLicense" ("callsign","usi","operatorClass") VALUES ${placeholders(rows, 3)}
   ON CONFLICT("callsign") DO UPDATE SET
     "operatorClass" = excluded."operatorClass",
     "status" = CASE WHEN "UlsLicense"."usi" = excluded."usi" THEN "UlsLicense"."status" ELSE NULL END,
     "usi" = excluded."usi"
   WHERE excluded."usi" >= "UlsLicense"."usi"`;

/**
 * HD.dat -> UlsLicense. This is the statement that publishes a row, and the
 * only one that writes `status` or `statusGeneration`.
 *
 * The CASE arms are the correction for the ~99 callsigns whose ACTIVE licence
 * is not their highest-numbered one: if the name/city/state/class we are
 * holding were read from a DIFFERENT licence than the one the FCC says is
 * active, they belong to a previous holder and are dropped. The row is then
 * published with no name, which sends that lookup to callook — a missing answer
 * instead of a confidently wrong one.
 *
 * `"usi" = excluded."usi"` is last for readability only: SQL evaluates every
 * assignment against the pre-update row, so the CASE arms still compare against
 * the stored usi. There is a test that pins exactly this.
 */
const HD_UPSERT_SQL = (rows: number): string =>
  `INSERT INTO "UlsLicense" ("callsign","usi","status","statusGeneration") VALUES ${placeholders(rows, 3, `'${HD_STATUS}'`, 2)}
   ON CONFLICT("callsign") DO UPDATE SET
     "status" = '${HD_STATUS}',
     "statusGeneration" = excluded."statusGeneration",
     "name" = CASE WHEN "UlsLicense"."usi" = excluded."usi" THEN "UlsLicense"."name" ELSE NULL END,
     "city" = CASE WHEN "UlsLicense"."usi" = excluded."usi" THEN "UlsLicense"."city" ELSE NULL END,
     "state" = CASE WHEN "UlsLicense"."usi" = excluded."usi" THEN "UlsLicense"."state" ELSE NULL END,
     "operatorClass" = CASE WHEN "UlsLicense"."usi" = excluded."usi" THEN "UlsLicense"."operatorClass" ELSE NULL END,
     "usi" = excluded."usi"`;

/**
 * `(?,?,?),(?,?,?),…` for a multi-row VALUES clause, optionally splicing a
 * literal in at `literalAt` (used for the constant 'A' status, which would
 * otherwise burn a bound parameter per row for no reason).
 */
function placeholders(rows: number, bound: number, literal?: string, literalAt?: number): string {
  const cells: string[] = [];
  const total = bound + (literal === undefined ? 0 : 1);
  for (let i = 0; i < total; i++) {
    cells.push(literal !== undefined && i === literalAt ? literal : '?');
  }
  const one = `(${cells.join(',')})`;
  return Array.from({ length: rows }, () => one).join(',');
}

/**
 * Roll the write-ahead log back into the database and truncate it.
 *
 * TRUNCATE rather than PASSIVE: PASSIVE is what SQLite already does on its own
 * and is exactly what fails to reclaim the file under a steady read load.
 * Never fatal — a checkpoint that cannot get in returns busy, and the next one
 * 50,000 rows later will.
 */
async function checkpointWal(prisma: PrismaClient): Promise<void> {
  try {
    // $queryRawUnsafe, not $executeRawUnsafe: the pragma returns a result row
    // (busy / log frames / checkpointed frames) and Prisma's execute path
    // rejects SQLite statements that return results. Same trap as db.ts.
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[uls] wal checkpoint failed (continuing)', e);
  }
}

/** How many rows of `paramsPerRow` fit in one statement. */
function rowsPerStatement(paramsPerRow: number): number {
  return Math.max(1, Math.floor(MAX_BOUND_PARAMS / paramsPerRow));
}

/**
 * Write one batch as a single transaction made of several bounded statements,
 * then hand the event loop back.
 *
 * `$transaction(array)` rather than an interactive transaction: the statements
 * are known up front, so there is no round trip between them holding the writer
 * open longer than the work needs.
 */
async function writeBatch(
  prisma: PrismaClient,
  rows: readonly unknown[][],
  paramsPerRow: number,
  sql: (rowCount: number) => string,
  counters: Counters,
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = rowsPerStatement(paramsPerRow);
  const statements: Prisma.PrismaPromise<number>[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const slice = rows.slice(i, i + perStatement);
    const params = slice.flat();
    statements.push(prisma.$executeRawUnsafe(sql(slice.length), ...params));
  }
  await prisma.$transaction(statements);
  counters.batches += 1;
  if (counters.batches % CHECKPOINT_EVERY_BATCHES === 0) await checkpointWal(prisma);
  await yieldToEventLoop();
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface UlsImportSummary {
  runId: string;
  generation: number;
  outcome: 'success' | 'failed';
  /** Callsigns published (confirmed ACTIVE) by this run. */
  callsigns: number;
  /** Data lines read across AM/EN/HD. */
  rowsRead: number;
  malformedRows: number;
  removedRows: number;
  unnamedCallsigns: number;
  bytesRead: number;
  sourceFileDate: string | null;
  durationMs: number;
  error: string | null;
}

export interface UlsImportOptions {
  /** Archive URL. Required — this module never reads env itself. */
  url: string;
  trigger?: 'schedule' | 'manual';
  now?: () => Date;
  batchRows?: number;
  /**
   * Opens the archive byte stream. Injected by tests so nothing touches the
   * network; production uses the SSRF-guarded fetch below.
   */
  openArchive?: (url: string) => Promise<NodeJS.ReadableStream>;
  log?: (message: string) => void;
  /**
   * Override the plausibility floor. Only tests set this — they import
   * archives of a dozen records, which the production floor would (correctly)
   * reject as a truncated download.
   */
  minActiveCallsigns?: number;
}

/**
 * In-process mutex. Two concurrent imports would each write ~4 M rows through
 * the same single SQLite writer and interleave their generations. Like every
 * other scheduler here, this app is single-replica by design (see
 * autoOpenScheduler), so a module-level flag is the whole lock.
 */
let importInFlight = false;

/** True while an import is running — the admin route answers 409 on this. */
export function isUlsImportRunning(): boolean {
  return importInFlight;
}

export class UlsImportBusyError extends Error {
  constructor() {
    super('A ULS import is already running');
    this.name = 'UlsImportBusyError';
  }
}

/** Fetch the archive through the app's single SSRF-guarded outbound path. */
async function fetchArchive(url: string): Promise<NodeJS.ReadableStream> {
  const { response } = await safeFetch(url, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    headers: { 'User-Agent': 'HamNetAssistant/1.0 (FCC ULS weekly import)' },
  });
  if (!response.ok) {
    throw new Error(`source responded ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error('source response had no body');
  return Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
}

/** Count bytes off the wire without buffering any of them. */
function byteCounter(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

/**
 * Pull the FCC's own creation stamp out of the archive's `counts` member, e.g.
 * "File Creation Date: Sun Aug 30 09:07:53 EDT 2026". Kept as the source's
 * literal text: it carries a US timezone abbreviation that Date cannot parse
 * unambiguously, and the point is to show an operator which dump they have.
 */
export function parseCountsFileDate(text: string): string | null {
  const m = /File Creation Date:\s*(.+)/i.exec(text);
  return m?.[1] ? m[1].trim() : null;
}

/** Everything a run accumulates while streaming. */
interface Counters {
  rowsRead: number;
  malformed: number;
  active: number;
  bytes: number;
  /** Batches written so far, used to pace WAL checkpoints. */
  batches: number;
}

/**
 * Mark runs left in 'running' by a killed process as failed.
 *
 * Without this a container that dies mid-import leaves a row that claims an
 * import is in progress forever, and the admin status page reads "running"
 * months later.
 */
export async function markInterruptedRuns(prisma: PrismaClient, now: Date): Promise<number> {
  const res = await prisma.ulsImportRun.updateMany({
    where: { outcome: 'running' },
    data: {
      outcome: 'failed',
      finishedAt: now,
      error: 'Interrupted — the process exited while this import was running.',
    },
  });
  return res.count;
}

/** Delete every row the just-completed run did not confirm ACTIVE. */
async function sweepStaleRows(
  prisma: PrismaClient,
  generation: number,
  batchRows: number,
  counters: Counters,
): Promise<number> {
  let removed = 0;
  for (;;) {
    // DELETE … LIMIT needs a compile-time SQLite option that is often off, so
    // the batch is expressed as a subquery instead — portable everywhere.
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM "UlsLicense" WHERE "callsign" IN (
         SELECT "callsign" FROM "UlsLicense"
         WHERE "statusGeneration" IS NULL OR "statusGeneration" < ?
         LIMIT ?)`,
      generation,
      batchRows,
    );
    removed += n;
    if (n === 0) break;
    // Deleting three quarters of a million rows dirties as many pages as
    // writing them did, so the sweep needs the same WAL discipline.
    counters.batches += 1;
    if (counters.batches % CHECKPOINT_EVERY_BATCHES === 0) await checkpointWal(prisma);
    await yieldToEventLoop();
  }
  return removed;
}

/**
 * Run one import. Never throws for an expected failure (network, bad archive,
 * implausible dump): the outcome is recorded on the run row and returned, so a
 * scheduler tick and an admin click handle failure the same way.
 *
 * Throws only {@link UlsImportBusyError}, and only when one is already running.
 */
export async function runUlsImport(
  prisma: PrismaClient,
  options: UlsImportOptions,
): Promise<UlsImportSummary> {
  if (importInFlight) throw new UlsImportBusyError();
  importInFlight = true;
  // The flag MUST be released on every exit path, including the run-row
  // bookkeeping that happens before the streaming try/catch below: a single
  // transient write failure there (SQLITE_BUSY during a net, a full /data
  // volume, the migration not yet applied) used to leave the mutex latched
  // for the life of the process, after which every weekly tick answered
  // 'busy' and the admin retry button answered 409 forever — an importer
  // that could only be revived by restarting the container.
  try {
    return await runUlsImportLocked(prisma, options);
  } finally {
    importInFlight = false;
  }
}

/** The body of {@link runUlsImport}, run with the in-flight mutex held. */
async function runUlsImportLocked(
  prisma: PrismaClient,
  options: UlsImportOptions,
): Promise<UlsImportSummary> {
  const now = options.now ?? ((): Date => new Date());
  const batchRows = options.batchRows ?? ULS_BATCH_ROWS;
  const openArchive = options.openArchive ?? fetchArchive;
  const log = options.log ?? ((m: string): void => console.log(`[uls] ${m}`));
  const startedAt = now();

  const counters: Counters = { rowsRead: 0, malformed: 0, active: 0, bytes: 0, batches: 0 };
  let sourceFileDate: string | null = null;

  await markInterruptedRuns(prisma, startedAt);
  const previous = await prisma.ulsImportRun.aggregate({ _max: { generation: true } });
  const generation = (previous._max.generation ?? 0) + 1;
  const run = await prisma.ulsImportRun.create({
    data: {
      generation,
      startedAt,
      outcome: 'running',
      trigger: options.trigger ?? 'manual',
      sourceUrl: options.url,
    },
  });

  const finish = async (
    outcome: 'success' | 'failed',
    extra: { removedRows: number; unnamedCallsigns: number; error: string | null },
  ): Promise<UlsImportSummary> => {
    const finishedAt = now();
    await prisma.ulsImportRun.update({
      where: { id: run.id },
      data: {
        outcome,
        finishedAt,
        sourceFileDate,
        rowsRead: counters.rowsRead,
        callsigns: counters.active,
        malformedRows: counters.malformed,
        bytesRead: counters.bytes,
        removedRows: extra.removedRows,
        unnamedCallsigns: extra.unnamedCallsigns,
        error: extra.error,
      },
    });
    return {
      runId: run.id,
      generation,
      outcome,
      callsigns: counters.active,
      rowsRead: counters.rowsRead,
      malformedRows: counters.malformed,
      removedRows: extra.removedRows,
      unnamedCallsigns: extra.unnamedCallsigns,
      bytesRead: counters.bytes,
      sourceFileDate,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: extra.error,
    };
  };

  try {
    log(`generation ${generation}: streaming ${options.url}`);
    const source = await openArchive(options.url);
    const counted = source.pipe(byteCounter((n) => (counters.bytes += n)));
    const zip = counted.pipe(unzipper.Parse({ forceStream: true }));
    const seen = new Set<string>();

    // `.pipe()` does not forward errors. Without this, a connection dropped
    // mid-download raises 'error' on a stream nothing is listening to — which
    // in Node is a process-level crash, not a failed import.
    const failStream = (e: Error): void => {
      if (!zip.destroyed) zip.destroy(e);
    };
    source.on('error', failStream);
    counted.on('error', failStream);

    // A truncated archive makes unzipper emit 'error' (FILE_ENDED) and then
    // carry on handing out entry streams that never end, so `for await` alone
    // hangs forever holding the in-flight lock. Racing the loop against the
    // parser's error is what turns that into a failed run.
    const parseFailed = new Promise<never>((_resolve, reject) => {
      zip.once('error', (e: unknown) => {
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });

    const readMembers = async (): Promise<void> => {
      for await (const entry of zip as unknown as AsyncIterable<unzipper.Entry>) {
        // Members are named at the archive root, but tolerate a directory
        // prefix rather than silently importing nothing if the FCC adds one.
        const member = entry.path.split('/').pop() ?? entry.path;

        if (member === COUNTS) {
          // 499 bytes. The one member small enough to hold in memory.
          sourceFileDate = parseCountsFileDate((await entry.buffer()).toString('latin1'));
          continue;
        }
        if (!WANTED_MEMBERS.has(member)) {
          // Every entry must be consumed or drained or Parse stalls.
          entry.autodrain();
          continue;
        }

        const before = counters.rowsRead;
        await consumeMember(prisma, member, entry, counters, generation, batchRows);
        seen.add(member);
        log(`${member}: ${counters.rowsRead - before} records`);

        if (seen.size === WANTED_MEMBERS.size) {
          // Everything we need has gone past; the rest of the archive is ~39 MB
          // of members this app has no use for.
          break;
        }
      }
    };

    try {
      // Promise.race subscribes to both, so neither can settle unhandled.
      await Promise.race([readMembers(), parseFailed]);
    } finally {
      // Always, on every path: on success this is a no-op, on the early break
      // it is what closes the socket, and on failure it releases a stream the
      // abandoned loop may still be parked on. Tear down from the reader back
      // towards the socket so nothing keeps pulling once we stop consuming.
      zip.destroy();
      counted.destroy();
      (source as Readable).destroy?.();
    }

    const missing = [...WANTED_MEMBERS].filter((m) => !seen.has(m));
    if (missing.length > 0) {
      return await finish('failed', {
        removedRows: 0,
        unnamedCallsigns: 0,
        error: `archive did not contain ${missing.join(', ')}`,
      });
    }

    const minActive = options.minActiveCallsigns ?? ULS_MIN_ACTIVE_CALLSIGNS;
    if (counters.active < minActive) {
      // Refuse to publish, and — crucially — refuse to sweep. Whatever the
      // previous import left behind stays live and answering.
      return await finish('failed', {
        removedRows: 0,
        unnamedCallsigns: 0,
        error:
          `only ${counters.active} active callsigns found (expected at least ` +
          `${minActive}); refusing to replace the existing data`,
      });
    }

    const removedRows = await sweepStaleRows(prisma, generation, batchRows, counters);
    const unnamedCallsigns = await prisma.ulsLicense.count({
      where: { status: HD_STATUS, name: null },
    });

    // The process holds its connection for months; leave the volume tidy.
    await checkpointWal(prisma);

    log(
      `generation ${generation} complete: ${counters.active} callsigns, ` +
        `${counters.malformed} malformed lines, ${removedRows} stale rows removed`,
    );
    return await finish('success', { removedRows, unnamedCallsigns, error: null });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // unzipper reports a truncated archive as the bare string "FILE_ENDED",
    // which tells an operator staring at the admin page nothing at all.
    const message =
      raw === 'FILE_ENDED'
        ? 'the archive ended part-way through — the download was truncated'
        : raw;
    console.warn('[uls] import failed', e);
    return await finish('failed', {
      removedRows: 0,
      unnamedCallsigns: 0,
      error: message.slice(0, ERROR_TEXT_LIMIT),
    });
  }
}

/** Stream one member, parsing and batching its rows into UlsLicense. */
async function consumeMember(
  prisma: PrismaClient,
  member: string,
  entry: NodeJS.ReadableStream,
  counters: Counters,
  generation: number,
  batchRows: number,
): Promise<void> {
  let batch: unknown[][] = [];
  const paramsPerRow = member === EN_DAT ? 5 : 3;
  const sql = member === EN_DAT ? EN_UPSERT_SQL : member === AM_DAT ? AM_UPSERT_SQL : HD_UPSERT_SQL;

  const flush = async (): Promise<void> => {
    const pending = batch;
    batch = [];
    await writeBatch(prisma, pending, paramsPerRow, sql, counters);
  };

  await forEachLine(entry, (line) => {
    counters.rowsRead += 1;
    let row: unknown[] | null = null;
    if (member === EN_DAT) {
      const parsed = parseEnLine(line);
      if (parsed.kind === 'malformed') counters.malformed += 1;
      else if (parsed.kind === 'row') {
        const v = parsed.value;
        row = [v.callsign, v.usi, v.name, v.city, v.state];
      }
    } else if (member === AM_DAT) {
      const parsed = parseAmLine(line);
      if (parsed.kind === 'malformed') counters.malformed += 1;
      else if (parsed.kind === 'row') row = [parsed.value.callsign, parsed.value.usi, parsed.value.operatorClass];
    } else {
      const parsed = parseHdLine(line);
      if (parsed.kind === 'malformed') counters.malformed += 1;
      else if (parsed.kind === 'row') {
        counters.active += 1;
        row = [parsed.value.callsign, parsed.value.usi, generation];
      }
    }
    if (!row) return;
    batch.push(row);
    // Returning the promise is what pauses the source stream while the write
    // is in flight — the backpressure that keeps memory flat.
    if (batch.length >= batchRows) return flush();
  });

  await flush();
}
