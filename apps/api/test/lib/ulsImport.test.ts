import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Readable } from 'node:stream';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import {
  forEachLine,
  formatUlsName,
  markInterruptedRuns,
  parseAmLine,
  parseEnLine,
  parseHdLine,
  parseCountsFileDate,
  readField,
  runUlsImport,
} from '../../src/lib/ulsImport.js';
import { findUlsLicense } from '../../src/lib/ulsLookup.js';
import {
  amRecord,
  archiveOpener,
  buildZip,
  chunkedStream,
  countsMember,
  crlf,
  enClub,
  enPerson,
  hdRecord,
} from '../fixtures/ulsArchive.js';

let prisma: PrismaClient;
let dbFile: string;

beforeAll(() => {
  ({ prisma, dbFile } = makeTestDb());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
beforeEach(async () => {
  await prisma.ulsLicense.deleteMany();
  await prisma.ulsImportRun.deleteMany();
});

const URL_ = 'https://example.test/l_amat.zip';

/** Import a fixture archive with the plausibility floor lowered for tests. */
function importArchive(
  entries: Array<{ name: string; content: string }>,
  extra: { batchRows?: number } = {},
) {
  return runUlsImport(prisma, {
    url: URL_,
    trigger: 'manual',
    minActiveCallsigns: 1,
    openArchive: archiveOpener(entries),
    log: () => {},
    ...extra,
  });
}

// ── Field reading ───────────────────────────────────────────────────────────

describe('readField', () => {
  it('trims surrounding whitespace', () => {
    expect(readField(['a', '  W1AW  '], 1)).toBe('W1AW');
  });

  it('returns empty string for a missing column', () => {
    expect(readField(['a'], 9)).toBe('');
  });

  it('returns empty string for an empty column', () => {
    expect(readField(['a', '', 'b'], 1)).toBe('');
  });

  // ULS is not RFC 4180 and nothing in the real dump is quoted, but a quoted
  // field must never be stored with its quotation marks.
  it('strips surrounding double quotes and unescapes doubled ones', () => {
    expect(readField(['a', '"SMITH"'], 1)).toBe('SMITH');
    expect(readField(['a', '"O""BRIEN"'], 1)).toBe('O"BRIEN');
  });

  it('leaves an interior quote alone', () => {
    expect(readField(['a', 'JOHN "JACK" SMITH'], 1)).toBe('JOHN "JACK" SMITH');
  });
});

// ── Name formatting ─────────────────────────────────────────────────────────

describe('formatUlsName', () => {
  it('builds "First Last" from the structured columns', () => {
    expect(formatUlsName('CATHERINE', 'HARTMAN', 'HARTMAN, CATHERINE E')).toBe('Catherine Hartman');
  });

  it('keeps a club name whole rather than first-word-plus-last-word', () => {
    expect(formatUlsName('', '', 'CENTRAL ARIZONA DX ASSN')).toBe('Central Arizona Dx Assn');
  });

  it('reverses "LAST, FIRST M" when the structured columns are empty', () => {
    expect(formatUlsName('', '', 'NELSON, DOUGLAS J')).toBe('Douglas Nelson');
  });

  it('handles a lone surname', () => {
    expect(formatUlsName('', 'MACDONALD', '')).toBe('Macdonald');
  });

  it('returns null when there is no name at all', () => {
    expect(formatUlsName('', '', '')).toBeNull();
  });

  it('title-cases across an apostrophe', () => {
    expect(formatUlsName('MARY', "O'BRIEN", '')).toBe("Mary O'Brien");
  });
});

// ── Line parsing ────────────────────────────────────────────────────────────

describe('parseEnLine', () => {
  it('reads usi, callsign, name, city and state from a real-shaped record', () => {
    const line =
      'EN|481993|||KC8DNW|L|L01119460|HARTMAN, CATHERINE E|CATHERINE|E|HARTMAN|||||1 976 CO RD V|LIBERTY CENTER|OH|43532|||000|0014693022|I||||||';
    const parsed = parseEnLine(line);
    expect(parsed.kind).toBe('row');
    if (parsed.kind !== 'row') return;
    expect(parsed.value).toEqual({
      usi: 481993,
      callsign: 'KC8DNW',
      name: 'Catherine Hartman',
      city: 'LIBERTY CENTER',
      state: 'OH',
    });
  });

  it('reads a club record', () => {
    const line =
      'EN|1303600|||K7UGA|L|L00289041|CENTRAL ARIZONA DX ASSN|||||||||TEMPE|AZ|852854616|24616|MICHAEL C FULCHER|000|0003948072|B||||||';
    const parsed = parseEnLine(line);
    expect(parsed.kind).toBe('row');
    if (parsed.kind !== 'row') return;
    expect(parsed.value.name).toBe('Central Arizona Dx Assn');
    expect(parsed.value.city).toBe('TEMPE');
  });

  it('counts a truncated record as malformed rather than importing junk', () => {
    expect(parseEnLine('EN|481993|||KC8DNW|L|L01119460|HARTMAN').kind).toBe('malformed');
  });

  it('treats a record with no usi as malformed', () => {
    expect(parseEnLine(enPerson(0, 'W1AW', 'A', 'B', 'C', 'MA').replace('|0|', '||')).kind).toBe(
      'malformed',
    );
  });

  // A contact or representative row must never overwrite the licensee's name.
  it('ignores a non-licensee entity type', () => {
    const line = enPerson(1, 'W1AW', 'JOHN', 'SMITH', 'BOSTON', 'MA').split('|');
    line[5] = 'CL';
    expect(parseEnLine(line.join('|')).kind).toBe('ignored');
  });
});

describe('parseAmLine', () => {
  it('maps the FCC operator-class code to callook wording', () => {
    const cases: Array<[string, string]> = [
      ['E', 'EXTRA'],
      ['A', 'ADVANCED'],
      ['G', 'GENERAL'],
      ['T', 'TECHNICIAN'],
      ['P', 'TECHNICIAN PLUS'],
      ['N', 'NOVICE'],
    ];
    for (const [code, label] of cases) {
      const parsed = parseAmLine(amRecord(100, 'W1AW', code));
      expect(parsed.kind).toBe('row');
      if (parsed.kind !== 'row') continue;
      expect(parsed.value.operatorClass).toBe(label);
    }
  });

  it('ignores a club record, which carries no operator class', () => {
    expect(parseAmLine(amRecord(100, 'K7UGA', '')).kind).toBe('ignored');
  });

  it('ignores an unrecognised class code instead of storing it raw', () => {
    expect(parseAmLine(amRecord(100, 'W1AW', 'Z')).kind).toBe('ignored');
  });

  it('counts a truncated record as malformed', () => {
    expect(parseAmLine('AM|100||').kind).toBe('malformed');
  });

  it('reads the real-dump layout, where field 5 is the class and 6 the group', () => {
    const parsed = parseAmLine('AM|301179|||KA5GQI|T|D|5|||||||||P|');
    expect(parsed.kind).toBe('row');
    if (parsed.kind !== 'row') return;
    expect(parsed.value).toEqual({ usi: 301179, callsign: 'KA5GQI', operatorClass: 'TECHNICIAN' });
  });
});

describe('parseHdLine', () => {
  it('accepts an ACTIVE licence', () => {
    const parsed = parseHdLine(
      'HD|215008|9400005006||AA0AI|A|HA|10/11/2023|11/23/2033||||||||||||||||||||N||||||||||||||10/11/2023|10/11/2023|||||||||||||||',
    );
    expect(parsed.kind).toBe('row');
    if (parsed.kind !== 'row') return;
    expect(parsed.value).toEqual({ usi: 215008, callsign: 'AA0AI' });
  });

  it.each([
    ['E', 'expired'],
    ['C', 'cancelled'],
    ['T', 'terminated'],
  ])('ignores a licence whose status is %s (%s)', (status) => {
    expect(parseHdLine(hdRecord(215005, 'AA0AE', status)).kind).toBe('ignored');
  });

  it('counts a truncated record as malformed', () => {
    expect(parseHdLine('HD|215005|94000|').kind).toBe('malformed');
  });
});

describe('parseCountsFileDate', () => {
  it('extracts the FCC file creation stamp verbatim', () => {
    expect(parseCountsFileDate(countsMember())).toBe('Sun Aug 30 09:07:53 EDT 2026');
  });

  it('returns null when the manifest has no stamp', () => {
    expect(parseCountsFileDate('    12 total\r\n')).toBeNull();
  });
});

// ── Line reading ────────────────────────────────────────────────────────────

describe('forEachLine', () => {
  async function collect(text: string, chunkSize = 7): Promise<string[]> {
    const out: string[] = [];
    await forEachLine(chunkedStream(Buffer.from(text, 'latin1'), chunkSize), (l) => {
      out.push(l);
    });
    return out;
  }

  it('strips the CR from CRLF records', async () => {
    expect(await collect('one\r\ntwo\r\nthree\r\n')).toEqual(['one', 'two', 'three']);
  });

  it('handles bare LF too', async () => {
    expect(await collect('one\ntwo\n')).toEqual(['one', 'two']);
  });

  it('emits a final record with no trailing newline', async () => {
    expect(await collect('one\r\ntwo')).toEqual(['one', 'two']);
  });

  it('skips blank lines', async () => {
    expect(await collect('one\r\n\r\ntwo\r\n')).toEqual(['one', 'two']);
  });

  // The case a naive splitter gets wrong: one chunk per byte means every
  // record is split across chunk boundaries, including the CRLF itself.
  it('reassembles records split across chunk boundaries', async () => {
    const long = 'EN|1|||W1AW|L|x'.repeat(1);
    expect(await collect(`${long}\r\n${long}\r\n`, 1)).toEqual([long, long]);
  });

  it('awaits an async handler, which is what applies backpressure', async () => {
    const order: string[] = [];
    await forEachLine(chunkedStream(Buffer.from('a\nb\n', 'latin1'), 1), async (l) => {
      order.push(`start:${l}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end:${l}`);
    });
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  /**
   * The claim this whole module rests on is that no .dat file is ever held in
   * memory. A member with no line ending in it is the one input that would
   * break that: the partial-record carry becomes the entire decompressed
   * member, and HD.dat expands to ~400 MB — an OOM kill of the container
   * running the club's net rather than a failed import. It must fail loudly
   * and cheaply instead.
   */
  it('refuses a member with no line ending rather than buffering it whole', async () => {
    const noNewlines = 'x'.repeat(1_200_000);
    await expect(
      forEachLine(chunkedStream(Buffer.from(noNewlines, 'latin1'), 64 * 1024), () => {}),
    ).rejects.toThrow(/no line ending/);
  });
});

// ── Import: the join across EN / AM / HD ────────────────────────────────────

/** The archive the FCC ships, in its real member order, with tiny bodies. */
function baseArchive(): Array<{ name: string; content: string }> {
  return [
    { name: 'counts', content: countsMember() },
    {
      name: 'AM.dat',
      content: crlf([
        amRecord(4000001, 'W1AAA', 'E'),
        amRecord(4000002, 'W1BBB', 'G'),
        amRecord(4000003, 'W1CCC', 'T'),
        amRecord(4000004, 'K1CLUB', ''),
      ]),
    },
    {
      name: 'CO.dat',
      content: crlf(['CO|4000001|||W1AAA|comment we never read']),
    },
    {
      name: 'EN.dat',
      content: crlf([
        enPerson(4000001, 'W1AAA', 'ALICE', 'ANDERSON', 'BOSTON', 'MA'),
        enPerson(4000002, 'W1BBB', 'BOB', 'BAKER', 'PROVIDENCE', 'RI'),
        enPerson(4000003, 'W1CCC', 'CAROL', 'CLARK', 'HARTFORD', 'CT'),
        enClub(4000004, 'K1CLUB', 'HAM CLUB OF SOMEWHERE', 'NEWINGTON', 'CT'),
      ]),
    },
    {
      name: 'HD.dat',
      content: crlf([
        hdRecord(4000001, 'W1AAA', 'A'),
        hdRecord(4000002, 'W1BBB', 'A'),
        // W1CCC is expired: present in AM and EN, must NOT be published.
        hdRecord(4000003, 'W1CCC', 'E'),
        hdRecord(4000004, 'K1CLUB', 'A'),
      ]),
    },
    // Members after HD.dat exist only to prove we stop reading at HD.
    { name: 'HS.dat', content: crlf(['HS|4000001|||W1AAA|history']) },
    { name: 'SF.dat', content: crlf(['SF|1|special condition']) },
  ];
}

describe('runUlsImport — joining EN, AM and HD', () => {
  it('publishes one row per active callsign with fields from all three members', async () => {
    const summary = await importArchive(baseArchive());

    expect(summary.outcome).toBe('success');
    expect(summary.error).toBeNull();
    expect(summary.callsigns).toBe(3);
    expect(summary.malformedRows).toBe(0);
    expect(summary.sourceFileDate).toBe('Sun Aug 30 09:07:53 EDT 2026');

    const alice = await prisma.ulsLicense.findUnique({ where: { callsign: 'W1AAA' } });
    expect(alice).toMatchObject({
      callsign: 'W1AAA',
      usi: 4000001,
      name: 'Alice Anderson',
      operatorClass: 'EXTRA',
      status: 'A',
      city: 'BOSTON',
      state: 'MA',
      statusGeneration: 1,
    });

    const club = await prisma.ulsLicense.findUnique({ where: { callsign: 'K1CLUB' } });
    // A club has a name but no operator class — exactly as callook reports it.
    expect(club?.name).toBe('Ham Club Of Somewhere');
    expect(club?.operatorClass).toBeNull();
    expect(club?.status).toBe('A');
  });

  it('excludes a non-ACTIVE licence even though EN and AM carry rows for it', async () => {
    await importArchive(baseArchive());
    // Swept, not merely hidden: it was never confirmed by HD.
    expect(await prisma.ulsLicense.findUnique({ where: { callsign: 'W1CCC' } })).toBeNull();
    expect(await findUlsLicense(prisma, 'W1CCC')).toBeNull();
  });

  it('records the run with its counts and the source stamp', async () => {
    await importArchive(baseArchive());
    const run = await prisma.ulsImportRun.findFirstOrThrow();
    expect(run).toMatchObject({
      outcome: 'success',
      trigger: 'manual',
      generation: 1,
      callsigns: 3,
      sourceUrl: URL_,
      sourceFileDate: 'Sun Aug 30 09:07:53 EDT 2026',
      error: null,
    });
    expect(run.finishedAt).not.toBeNull();
    expect(run.bytesRead).toBeGreaterThan(0);
    // AM(4) + EN(4) + HD(4). CO/HS/SF are drained without being parsed.
    expect(run.rowsRead).toBe(12);
  });

  it('works whatever order the members appear in', async () => {
    const members = baseArchive();
    const reordered = [
      members[0]!,
      members[4]!, // HD.dat first
      members[3]!, // EN.dat
      members[1]!, // AM.dat
    ];
    const summary = await importArchive(reordered);
    expect(summary.outcome).toBe('success');
    expect(await prisma.ulsLicense.findUnique({ where: { callsign: 'W1AAA' } })).toMatchObject({
      name: 'Alice Anderson',
      operatorClass: 'EXTRA',
      status: 'A',
    });
  });
});

// ── Import: malformed input ─────────────────────────────────────────────────

describe('runUlsImport — malformed rows', () => {
  it('skips and counts bad lines instead of throwing away the whole run', async () => {
    const members = baseArchive();
    members[3] = {
      name: 'EN.dat',
      content: crlf([
        enPerson(4000001, 'W1AAA', 'ALICE', 'ANDERSON', 'BOSTON', 'MA'),
        'EN|4000002|||W1BBB|L|truncated right here',
        'not even pipe delimited',
        enPerson(4000004, 'K1CLUB', 'X', 'Y', 'Z', 'CT'),
      ]),
    };
    const summary = await importArchive(members);

    expect(summary.outcome).toBe('success');
    expect(summary.malformedRows).toBe(2);
    // The good rows around the bad ones still landed.
    expect((await prisma.ulsLicense.findUnique({ where: { callsign: 'W1AAA' } }))?.name).toBe(
      'Alice Anderson',
    );
    // W1BBB is still published (HD confirmed it); it just has no name, so the
    // lookup treats it as a miss and falls through to callook.
    expect((await prisma.ulsLicense.findUnique({ where: { callsign: 'W1BBB' } }))?.status).toBe('A');
    expect(await findUlsLicense(prisma, 'W1BBB')).toBeNull();
    expect(summary.unnamedCallsigns).toBe(1);
  });
});

// ── Import: callsign reuse ──────────────────────────────────────────────────

describe('runUlsImport — reissued callsigns', () => {
  /**
   * 9.2% of active callsigns in the real dump also carry a previous holder's
   * expired licence. Joining on callsign instead of unique_system_identifier
   * puts that previous holder's name on the current licensee.
   */
  it('keeps the ACTIVE licensee, not the previous holder whose row streams later', async () => {
    const members = [
      { name: 'counts', content: countsMember() },
      { name: 'AM.dat', content: crlf([amRecord(4900000, 'W1REUSE', 'E')]) },
      {
        name: 'EN.dat',
        content: crlf([
          // Current holder first, previous holder second: last-write-wins would
          // leave "Bob Bygone" on the callsign.
          enPerson(4900000, 'W1REUSE', 'ALICE', 'ACTIVE', 'BOSTON', 'MA'),
          enPerson(300000, 'W1REUSE', 'BOB', 'BYGONE', 'MIAMI', 'FL'),
        ]),
      },
      {
        name: 'HD.dat',
        content: crlf([hdRecord(4900000, 'W1REUSE', 'A'), hdRecord(300000, 'W1REUSE', 'E')]),
      },
    ];
    const summary = await importArchive(members);
    expect(summary.outcome).toBe('success');
    expect((await findUlsLicense(prisma, 'W1REUSE'))?.name).toBe('Alice Active');
  });

  /**
   * The rarer inversion, measured at 99 of 823,953 callsigns: the ACTIVE
   * licence is not the highest-numbered one, so the usi tiebreak picks the
   * wrong row. HD must then drop what it cannot vouch for, leaving the lookup
   * to fall back to callook rather than answering with a stranger's name.
   */
  it('drops a name it cannot prove belongs to the active licence', async () => {
    const members = [
      { name: 'counts', content: countsMember() },
      { name: 'AM.dat', content: crlf([amRecord(5000000, 'W1ODD', 'G')]) },
      {
        name: 'EN.dat',
        content: crlf([enPerson(5000000, 'W1ODD', 'WRONG', 'HOLDER', 'RENO', 'NV')]),
      },
      // The ACTIVE licence is the LOWER usi here.
      {
        name: 'HD.dat',
        content: crlf([hdRecord(4000000, 'W1ODD', 'A'), hdRecord(5000000, 'W1ODD', 'C')]),
      },
    ];
    const summary = await importArchive(members);

    const row = await prisma.ulsLicense.findUnique({ where: { callsign: 'W1ODD' } });
    expect(row).toMatchObject({ usi: 4000000, status: 'A', name: null, city: null, state: null });
    expect(row?.operatorClass).toBeNull();
    expect(summary.unnamedCallsigns).toBe(1);
    // A missing answer, never a wrong one.
    expect(await findUlsLicense(prisma, 'W1ODD')).toBeNull();
  });

  /**
   * The same inversion, but on the SECOND import — the case a club actually
   * lives in every week after the first.
   *
   * W1ODD is already published (nameless) from last week. This week's EN pass
   * runs before HD.dat and the previous holder's row wins the usi tiebreak, so
   * for the minutes between the two passes the row carries a stranger's name
   * under last week's still-live `status = 'A'`. The EN statement clears
   * `status` whenever it moves a row to a different licence, which turns that
   * window into a callook fallback instead of a confident wrong answer — and
   * keeps it that way if the container dies before HD.dat arrives.
   */
  it('never serves the previous holder when a run stops between EN and HD', async () => {
    const week1 = [
      { name: 'counts', content: countsMember() },
      { name: 'AM.dat', content: crlf([amRecord(4000000, 'W1ODD', 'G')]) },
      { name: 'EN.dat', content: crlf([enPerson(4000000, 'W1ODD', 'REAL', 'HOLDER', 'RENO', 'NV')]) },
      {
        name: 'HD.dat',
        content: crlf([hdRecord(4000000, 'W1ODD', 'A'), hdRecord(5000000, 'W1ODD', 'C')]),
      },
    ];
    expect((await importArchive(week1)).outcome).toBe('success');
    expect(await prisma.ulsLicense.findUnique({ where: { callsign: 'W1ODD' } })).toMatchObject({
      usi: 4000000,
      status: 'A',
    });

    // Week 2, cut off before HD.dat ever streams.
    const stopped = await importArchive([
      { name: 'counts', content: countsMember('Fri Sep 04 09:00:00 EDT 2026') },
      { name: 'AM.dat', content: crlf([amRecord(5000000, 'W1ODD', 'E')]) },
      {
        name: 'EN.dat',
        content: crlf([enPerson(5000000, 'W1ODD', 'WRONG', 'HOLDER', 'MIAMI', 'FL')]),
      },
    ]);
    expect(stopped.outcome).toBe('failed');

    const row = await prisma.ulsLicense.findUnique({ where: { callsign: 'W1ODD' } });
    expect(row?.name).toBe('Wrong Holder');
    // ...but unpublished, so nobody is told that is who holds W1ODD.
    expect(row?.status).toBeNull();
    expect(await findUlsLicense(prisma, 'W1ODD')).toBeNull();
  });

  /**
   * The member order in l_amat.zip is AM, EN, HD and the importer is happiest
   * that way, but a reordered archive must never turn into a WRONG answer —
   * only into a missing one.
   */
  it('does not publish the previous holder if HD.dat streams before EN.dat', async () => {
    const summary = await importArchive([
      { name: 'counts', content: countsMember() },
      {
        name: 'HD.dat',
        content: crlf([hdRecord(4000000, 'W1ODD', 'A'), hdRecord(5000000, 'W1ODD', 'C')]),
      },
      {
        name: 'EN.dat',
        content: crlf([enPerson(5000000, 'W1ODD', 'WRONG', 'HOLDER', 'RENO', 'NV')]),
      },
      { name: 'AM.dat', content: crlf([amRecord(5000000, 'W1ODD', 'G')]) },
    ]);
    expect(summary.outcome).toBe('success');
    expect(await findUlsLicense(prisma, 'W1ODD')).toBeNull();
  });
});

// ── Import: idempotency and generations ─────────────────────────────────────

describe('runUlsImport — idempotency', () => {
  it('leaves exactly one row per callsign when the same dump is imported twice', async () => {
    await importArchive(baseArchive());
    const first = await prisma.ulsLicense.findMany({ orderBy: { callsign: 'asc' } });

    const second = await importArchive(baseArchive());
    const after = await prisma.ulsLicense.findMany({ orderBy: { callsign: 'asc' } });

    expect(second.outcome).toBe('success');
    expect(after).toHaveLength(first.length);
    expect(after.map((r) => r.callsign)).toEqual(first.map((r) => r.callsign));
    // Only the generation stamp moves.
    expect(after.map((r) => ({ ...r, statusGeneration: 0 }))).toEqual(
      first.map((r) => ({ ...r, statusGeneration: 0 })),
    );
    expect(after.every((r) => r.statusGeneration === 2)).toBe(true);
  });

  it('is idempotent at a batch size that forces many transactions', async () => {
    await importArchive(baseArchive(), { batchRows: 1 });
    await importArchive(baseArchive(), { batchRows: 1 });
    expect(await prisma.ulsLicense.count()).toBe(3);
  });

  it('sweeps callsigns the newest dump no longer lists as active', async () => {
    await importArchive(baseArchive());
    expect(await prisma.ulsLicense.count()).toBe(3);

    // Next week: W1BBB has lapsed and vanished from the dump entirely.
    const nextWeek = [
      { name: 'counts', content: countsMember('Fri Sep 04 09:00:00 EDT 2026') },
      { name: 'AM.dat', content: crlf([amRecord(4000001, 'W1AAA', 'E')]) },
      {
        name: 'EN.dat',
        content: crlf([enPerson(4000001, 'W1AAA', 'ALICE', 'ANDERSON', 'BOSTON', 'MA')]),
      },
      { name: 'HD.dat', content: crlf([hdRecord(4000001, 'W1AAA', 'A')]) },
    ];
    const summary = await importArchive(nextWeek);

    expect(summary.outcome).toBe('success');
    expect(summary.removedRows).toBe(2);
    expect(await prisma.ulsLicense.findMany({ select: { callsign: true } })).toEqual([
      { callsign: 'W1AAA' },
    ]);
  });

  it('updates a callsign that changed hands between dumps', async () => {
    await importArchive(baseArchive());
    expect((await findUlsLicense(prisma, 'W1AAA'))?.name).toBe('Alice Anderson');

    const nextWeek = [
      { name: 'counts', content: countsMember() },
      { name: 'AM.dat', content: crlf([amRecord(5100000, 'W1AAA', 'G')]) },
      {
        name: 'EN.dat',
        content: crlf([enPerson(5100000, 'W1AAA', 'DANA', 'DAVIS', 'SALEM', 'OR')]),
      },
      { name: 'HD.dat', content: crlf([hdRecord(5100000, 'W1AAA', 'A')]) },
    ];
    await importArchive(nextWeek);

    expect(await findUlsLicense(prisma, 'W1AAA')).toMatchObject({
      name: 'Dana Davis',
      operatorClass: 'GENERAL',
      city: 'SALEM',
      state: 'OR',
    });
  });
});

// ── Import: interruption safety ─────────────────────────────────────────────

describe('runUlsImport — interruption safety', () => {
  it('never publishes rows written before HD.dat confirmed them', async () => {
    // An archive that stops after EN.dat is exactly what a container killed
    // mid-import leaves behind.
    const truncated = [
      { name: 'counts', content: countsMember() },
      { name: 'AM.dat', content: crlf([amRecord(4000001, 'W1AAA', 'E')]) },
      {
        name: 'EN.dat',
        content: crlf([enPerson(4000001, 'W1AAA', 'ALICE', 'ANDERSON', 'BOSTON', 'MA')]),
      },
    ];
    const summary = await importArchive(truncated);

    expect(summary.outcome).toBe('failed');
    expect(summary.error).toContain('HD.dat');
    // The row exists, but is unpublished and therefore invisible.
    const raw = await prisma.ulsLicense.findUnique({ where: { callsign: 'W1AAA' } });
    expect(raw?.status).toBeNull();
    expect(raw?.statusGeneration).toBeNull();
    expect(await findUlsLicense(prisma, 'W1AAA')).toBeNull();
  });

  it('leaves the previous import published when the next one fails', async () => {
    await importArchive(baseArchive());
    expect((await findUlsLicense(prisma, 'W1AAA'))?.name).toBe('Alice Anderson');

    const failed = await importArchive([
      { name: 'counts', content: countsMember() },
      { name: 'AM.dat', content: crlf([amRecord(4000001, 'W1AAA', 'E')]) },
      {
        name: 'EN.dat',
        content: crlf([enPerson(4000001, 'W1AAA', 'ALICE', 'ANDERSON', 'BOSTON', 'MA')]),
      },
    ]);

    expect(failed.outcome).toBe('failed');
    // Nothing was swept, so last week's answers keep working.
    expect(failed.removedRows).toBe(0);
    expect((await findUlsLicense(prisma, 'W1AAA'))?.name).toBe('Alice Anderson');
    expect((await findUlsLicense(prisma, 'W1BBB'))?.name).toBe('Bob Baker');
  });

  it('refuses to publish or sweep an implausibly small dump', async () => {
    await importArchive(baseArchive());

    const tiny = await runUlsImport(prisma, {
      url: URL_,
      openArchive: archiveOpener([
        { name: 'counts', content: countsMember() },
        { name: 'AM.dat', content: crlf([amRecord(4000001, 'W1AAA', 'E')]) },
        {
          name: 'EN.dat',
          content: crlf([enPerson(4000001, 'W1AAA', 'ALICE', 'ANDERSON', 'BOSTON', 'MA')]),
        },
        { name: 'HD.dat', content: crlf([hdRecord(4000001, 'W1AAA', 'A')]) },
      ]),
      // The production floor. One active callsign is nowhere near it.
      log: () => {},
    });

    expect(tiny.outcome).toBe('failed');
    expect(tiny.error).toMatch(/only 1 active callsigns/);
    expect(tiny.removedRows).toBe(0);
    // Last week's three callsigns are all still answering.
    expect(await prisma.ulsLicense.count()).toBe(3);
    expect((await findUlsLicense(prisma, 'W1BBB'))?.name).toBe('Bob Baker');
  });

  it('reports a transport failure on the run row instead of throwing', async () => {
    const summary = await runUlsImport(prisma, {
      url: URL_,
      minActiveCallsigns: 1,
      log: () => {},
      openArchive: () => Promise.reject(new Error('getaddrinfo ENOTFOUND data.fcc.gov')),
    });
    expect(summary.outcome).toBe('failed');
    expect(summary.error).toContain('ENOTFOUND');
    const run = await prisma.ulsImportRun.findFirstOrThrow();
    expect(run.outcome).toBe('failed');
    expect(run.finishedAt).not.toBeNull();
  });

  it('survives a stream that dies mid-transfer', async () => {
    const zip = buildZip(baseArchive());
    const summary = await runUlsImport(prisma, {
      url: URL_,
      minActiveCallsigns: 1,
      log: () => {},
      openArchive: () => {
        const truncated = chunkedStream(zip.subarray(0, Math.floor(zip.length / 2)));
        return Promise.resolve(truncated as unknown as Readable);
      },
    });
    expect(summary.outcome).toBe('failed');
    expect(await findUlsLicense(prisma, 'W1AAA')).toBeNull();
  });

  it('marks a run abandoned by a killed process as failed', async () => {
    await prisma.ulsImportRun.create({
      data: {
        generation: 41,
        startedAt: new Date('2026-08-28T03:00:00Z'),
        outcome: 'running',
        trigger: 'schedule',
        sourceUrl: URL_,
      },
    });

    const marked = await markInterruptedRuns(prisma, new Date('2026-08-29T03:00:00Z'));
    expect(marked).toBe(1);
    const run = await prisma.ulsImportRun.findFirstOrThrow();
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/Interrupted/);
    expect(run.finishedAt).not.toBeNull();
  });

  it('continues the generation counter past an interrupted run', async () => {
    await prisma.ulsImportRun.create({
      data: {
        generation: 7,
        startedAt: new Date('2026-08-28T03:00:00Z'),
        outcome: 'running',
        trigger: 'schedule',
        sourceUrl: URL_,
      },
    });
    const summary = await importArchive(baseArchive());
    expect(summary.generation).toBe(8);
    const rows = await prisma.ulsLicense.findMany();
    expect(rows.every((r) => r.statusGeneration === 8)).toBe(true);
  });

  /**
   * The in-flight mutex is a module-level flag, so anything that escapes
   * runUlsImport without clearing it disables the importer for the LIFE of the
   * process: every weekly tick answers 'busy' and the admin retry button
   * answers 409, with no import running. The run-row bookkeeping at the top
   * (three writes, before any streaming) is the part that can fail on a real
   * club server — SQLITE_BUSY during a net, a full /data volume.
   */
  it('releases the in-flight lock when the run row cannot even be created', async () => {
    const broken = new Proxy(prisma, {
      get(target, prop, receiver): unknown {
        if (prop !== 'ulsImportRun') return Reflect.get(target, prop, receiver);
        const real = Reflect.get(target, prop, receiver) as Record<string, unknown>;
        return new Proxy(real, {
          get(t, p): unknown {
            if (p !== 'create') return Reflect.get(t, p);
            return () => Promise.reject(new Error('SQLITE_FULL: database or disk is full'));
          },
        });
      },
    }) as PrismaClient;

    await expect(
      runUlsImport(broken, {
        url: URL_,
        minActiveCallsigns: 1,
        openArchive: archiveOpener(baseArchive()),
        log: () => {},
      }),
    ).rejects.toThrow(/disk is full/);

    // The very next import must run, not report itself already running.
    expect((await importArchive(baseArchive())).outcome).toBe('success');
  });

  it('refuses to run two imports at once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = runUlsImport(prisma, {
      url: URL_,
      minActiveCallsigns: 1,
      log: () => {},
      openArchive: async () => {
        await gate;
        return chunkedStream(buildZip(baseArchive()));
      },
    });
    await expect(
      runUlsImport(prisma, { url: URL_, minActiveCallsigns: 1, log: () => {} }),
    ).rejects.toThrow(/already running/);
    release();
    expect((await slow).outcome).toBe('success');
  });
});
