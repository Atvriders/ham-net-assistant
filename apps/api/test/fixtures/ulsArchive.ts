import zlib from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * Builds real ZIP archives in memory so the ULS importer tests exercise the
 * actual streaming zip reader rather than a stub of it.
 *
 * Hand-rolled rather than pulled from a package: the importer's whole reason to
 * exist is that it never buffers an archive, and the one thing a test must not
 * do is quietly prove a different code path. This produces exactly the shape
 * the FCC ships — deflate (method 8), no data descriptor, entries in the order
 * given — so `unzipper.Parse` walks it the same way it walks l_amat.zip.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 as the ZIP spec wants it. Hand-written so no Node version matters. */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  /** Member body. latin1-encoded, exactly like the FCC's files. */
  content: string;
}

/** Build a complete ZIP: local headers, deflated bodies, central directory, EOCD. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'latin1');
    const raw = Buffer.from(entry.content, 'latin1');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags: no data descriptor, exactly like the FCC's
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * A readable stream of `buffer`, delivered in small chunks so every test drives
 * the importer's chunk-boundary handling — a record split across two chunks is
 * the case a naive line splitter gets wrong.
 */
export function chunkedStream(buffer: Buffer, chunkSize = 64): Readable {
  let position = 0;
  return new Readable({
    read(): void {
      if (position >= buffer.length) {
        this.push(null);
        return;
      }
      this.push(buffer.subarray(position, position + chunkSize));
      position += chunkSize;
    },
  });
}

/** `openArchive` implementation that serves a fixed archive and never uses the network. */
export function archiveOpener(entries: readonly ZipEntry[]): () => Promise<Readable> {
  const zip = buildZip(entries);
  return () => Promise.resolve(chunkedStream(zip));
}

// ── Sample records ──────────────────────────────────────────────────────────
// Field layouts and column counts are copied from the real 2026-08-30 dump
// (AM 18 columns, EN 30, HD 59) so a fixture cannot drift away from the source.

/** One AM.dat record. `operatorClass` is the raw single-letter FCC code. */
export function amRecord(usi: number, callsign: string, operatorClass: string): string {
  const f = new Array<string>(18).fill('');
  f[0] = 'AM';
  f[1] = String(usi);
  f[4] = callsign;
  f[5] = operatorClass;
  f[6] = 'D';
  f[7] = '1';
  return f.join('|');
}

/** One EN.dat record for an individual. */
export function enPerson(
  usi: number,
  callsign: string,
  first: string,
  last: string,
  city: string,
  state: string,
): string {
  const f = new Array<string>(30).fill('');
  f[0] = 'EN';
  f[1] = String(usi);
  f[4] = callsign;
  f[5] = 'L';
  f[6] = `L${usi}`;
  f[7] = `${last}, ${first}`;
  f[8] = first;
  f[10] = last;
  f[15] = '1 MAIN ST';
  f[16] = city;
  f[17] = state;
  f[18] = '01234';
  f[23] = 'I';
  return f.join('|');
}

/** One EN.dat record for a club: entity_name only, no first/last. */
export function enClub(
  usi: number,
  callsign: string,
  entityName: string,
  city: string,
  state: string,
): string {
  const f = new Array<string>(30).fill('');
  f[0] = 'EN';
  f[1] = String(usi);
  f[4] = callsign;
  f[5] = 'L';
  f[6] = `L${usi}`;
  f[7] = entityName;
  f[16] = city;
  f[17] = state;
  f[23] = 'B';
  return f.join('|');
}

/** One HD.dat record. `status` is the raw FCC code: A / E / C / T. */
export function hdRecord(usi: number, callsign: string, status: string): string {
  const f = new Array<string>(59).fill('');
  f[0] = 'HD';
  f[1] = String(usi);
  f[2] = '0001234567';
  f[4] = callsign;
  f[5] = status;
  f[6] = 'HA';
  f[7] = '01/27/2020';
  f[8] = '04/17/2030';
  return f.join('|');
}

/** The archive's `counts` manifest, which carries the dump's own date stamp. */
export function countsMember(date = 'Sun Aug 30 09:07:53 EDT 2026'): string {
  return [
    `File Creation Date: ${date}`,
    '        4 /home/pubacc/scripts/licweekzipdata/AM.dat',
    '        4 /home/pubacc/scripts/licweekzipdata/EN.dat',
    '        4 /home/pubacc/scripts/licweekzipdata/HD.dat',
    '       12 total',
    '',
  ].join('\r\n');
}

/** Join records into a member body with the CRLF line endings the FCC uses. */
export function crlf(lines: readonly string[]): string {
  return lines.map((l) => `${l}\r\n`).join('');
}
