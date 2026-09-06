import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import { enrichEmptyNames, lookupCallsignName } from '../../src/lib/callsignNameLookup.js';

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
  await prisma.user.deleteMany();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockCallook(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function seedUls(callsign: string, name: string) {
  return prisma.ulsLicense.create({
    data: { callsign, usi: 4000001, name, status: 'A', statusGeneration: 1 },
  });
}

function seedUser(callsign: string, name: string) {
  return prisma.user.create({
    data: {
      callsign,
      name,
      email: `${callsign.toLowerCase()}@club.test`,
      passwordHash: 'x',
    },
  });
}

describe('lookupCallsignName — resolution order', () => {
  it('prefers a club member row over everything else', async () => {
    await seedUser('W1AAA', 'Ali From The Club');
    await seedUls('W1AAA', 'Alice Anderson');
    const fetchSpy = mockCallook({ status: 'VALID', name: 'REMOTE NAME' });

    expect(await lookupCallsignName(prisma, 'W1AAA', new Map())).toBe('Ali From The Club');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the local FCC mirror before going out to callook', async () => {
    await seedUls('W1AAA', 'Alice Anderson');
    const fetchSpy = mockCallook({ status: 'VALID', name: 'SHOULD NOT BE USED' });

    expect(await lookupCallsignName(prisma, 'W1AAA', new Map())).toBe('Alice Anderson');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to callook when the mirror has no row', async () => {
    const fetchSpy = mockCallook({ status: 'VALID', name: 'BOB BAKER' });
    expect(await lookupCallsignName(prisma, 'W1ZZZ', new Map())).toBe('Bob Baker');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive about the callsign it is given', async () => {
    await seedUls('W1AAA', 'Alice Anderson');
    const fetchSpy = mockCallook({ status: 'VALID', name: 'NOPE' });
    expect(await lookupCallsignName(prisma, 'w1aaa', new Map())).toBe('Alice Anderson');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores an unpublished mirror row and falls through', async () => {
    await prisma.ulsLicense.create({
      data: { callsign: 'W1AAA', usi: 4000001, name: 'Half Imported' },
    });
    mockCallook({ status: 'VALID', name: 'BOB BAKER' });
    expect(await lookupCallsignName(prisma, 'W1AAA', new Map())).toBe('Bob Baker');
  });

  it('returns null when nothing anywhere knows the callsign', async () => {
    mockCallook({ status: 'INVALID' });
    expect(await lookupCallsignName(prisma, 'W1ZZZ', new Map())).toBeNull();
  });
});

describe('enrichEmptyNames', () => {
  /**
   * This is the bulk path: the log importer and the admin name-backfill call it
   * with hundreds of callsigns. Before the mirror existed every one of them was
   * an outbound request to a third party.
   */
  it('fills a batch from the mirror with no network traffic at all', async () => {
    await seedUls('W1AAA', 'Alice Anderson');
    await seedUls('W1BBB', 'Bob Baker');
    await seedUls('W1CCC', 'Carol Clark');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await enrichEmptyNames(prisma, [
      { callsign: 'W1AAA', name: '' },
      { callsign: 'W1BBB', name: '' },
      { callsign: 'W1CCC', name: '' },
    ]);

    expect(result.lookedUp).toBe(3);
    expect(result.items.map((i) => i.name)).toEqual([
      'Alice Anderson',
      'Bob Baker',
      'Carol Clark',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves names that are already present alone', async () => {
    await seedUls('W1AAA', 'Alice Anderson');
    const result = await enrichEmptyNames(prisma, [{ callsign: 'W1AAA', name: 'Already Known' }]);
    expect(result.lookedUp).toBe(0);
    expect(result.items[0]!.name).toBe('Already Known');
  });

  it('only reaches callook for the callsigns the mirror misses', async () => {
    await seedUls('W1AAA', 'Alice Anderson');
    const fetchSpy = mockCallook({ status: 'VALID', name: 'BOB BAKER' });

    const result = await enrichEmptyNames(prisma, [
      { callsign: 'W1AAA', name: '' },
      { callsign: 'W1ZZZ', name: '' },
    ]);

    expect(result.items.map((i) => i.name)).toEqual(['Alice Anderson', 'Bob Baker']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
