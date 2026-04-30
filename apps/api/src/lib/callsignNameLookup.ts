import type { PrismaClient } from '@prisma/client';

/**
 * Resolve a name for a callsign. Order:
 *   1. Existing User row (callsign field).
 *   2. callook.info FCC lookup.
 * Returns null when nothing found.
 *
 * Caches results in-memory for the lifetime of the caller (passed cache map).
 */
export async function lookupCallsignName(
  prisma: PrismaClient,
  callsign: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = callsign.toUpperCase();
  if (cache.has(key)) return cache.get(key)!;

  // 1. Local users
  const user = await prisma.user.findFirst({
    where: { callsign: key },
    select: { name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (user?.name && user.name !== 'N0CALL') {
    cache.set(key, user.name);
    return user.name;
  }

  // 2. callook.info
  try {
    const remote = await fetch(`https://callook.info/${key}/json`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'HamNetAssistant/1.0' },
    });
    if (!remote.ok) {
      cache.set(key, null);
      return null;
    }
    const data = (await remote.json()) as {
      status?: string;
      name?: string;
    };
    if (data.status !== 'VALID' || !data.name) {
      cache.set(key, null);
      return null;
    }
    // callook returns "FIRST MIDDLE LAST"; produce "First Last"
    const parts = data.name.trim().split(/\s+/).filter(Boolean);
    let pretty: string;
    if (parts.length === 1) {
      pretty = titleCase(parts[0]!);
    } else if (parts.length >= 2) {
      pretty = `${titleCase(parts[0]!)} ${titleCase(parts[parts.length - 1]!)}`;
    } else {
      pretty = '';
    }
    cache.set(key, pretty || null);
    return pretty || null;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Enrich a list of (callsign, name) entries by filling in names that are
 * empty using lookupCallsignName. Concurrency-bounded so we don't hammer
 * callook with hundreds of parallel requests on a big import.
 *
 * Pass a shared `cache` map across multiple invocations (e.g. one per
 * session in the same import) to avoid duplicate lookups.
 */
export async function enrichEmptyNames(
  prisma: PrismaClient,
  items: Array<{ callsign: string; name: string }>,
  opts: { concurrency?: number; cache?: Map<string, string | null> } = {},
): Promise<{ items: Array<{ callsign: string; name: string }>; lookedUp: number }> {
  const cache = opts.cache ?? new Map<string, string | null>();
  const concurrency = opts.concurrency ?? 4;
  const targets: Array<{ index: number; callsign: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!it.name || !it.name.trim()) targets.push({ index: i, callsign: it.callsign });
  }
  let lookedUp = 0;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const idx = cursor++;
      const t = targets[idx]!;
      const found = await lookupCallsignName(prisma, t.callsign, cache);
      if (found) {
        items[t.index] = { callsign: t.callsign, name: found };
        lookedUp += 1;
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, targets.length));
  if (targets.length === 0) return { items, lookedUp: 0 };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { items, lookedUp };
}
