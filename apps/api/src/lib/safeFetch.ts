import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../middleware/error.js';

/**
 * The single SSRF guard for every outbound request this API makes against a
 * user-supplied URL (script import, log import, theme-logo import).
 *
 * WHY one file: the guard used to be copy-pasted into three routes and the
 * copies had already drifted apart. Between them they let an authenticated
 * user read internal HTTP endpoints — the response body is handed straight
 * back to the caller, so it is a read primitive, not just a port scanner:
 *
 *   - `redirect: 'follow'` meant only the SUBMITTED url was checked; the
 *     attacker's own host answered 302 -> http://169.254.169.254/… and fetch
 *     obediently followed it AFTER the check had passed.
 *   - `dns.lookup(...).catch(() => [])` turned a failed lookup into an empty
 *     address list, which then passed the "no address is private" loop.
 *   - `net.isIP('::ffff:169.254.169.254')` is 6, so the IPv4 rules were
 *     skipped entirely for IPv4-mapped addresses.
 *   - 100.64.0.0/10 (RFC 6598 CGNAT) was not covered at all; several hosting
 *     providers put internal services on it.
 *
 * Everything here fails closed: anything we cannot positively classify as a
 * globally routable address is rejected.
 *
 * Residual risk we accept: DNS rebinding. We re-resolve and re-check on every
 * hop, but between our lookup and undici's own lookup the record can change.
 * Closing that hole needs a pinned-IP dispatcher; it is a much narrower window
 * than the redirect hole and is documented rather than fixed here.
 */

/** Statuses that undici would have followed for us under `redirect: 'follow'`. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Non-routable IPv4 space. Anything matching is refused, so the list is
 * deliberately broader than "RFC 1918": link-local carries the cloud metadata
 * service, CGNAT carries provider-internal services, and the reserved blocks
 * have no business being a legitimate import source.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network" — 0.0.0.0 resolves to localhost on Linux
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // RFC 6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

/** Dotted quad -> unsigned 32-bit value, or null when it is not a dotted quad. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Reject "010" and friends: some resolvers read leading zeros as octal,
    // so allowing them would let 0177.0.0.1 mean 127.0.0.1 to the OS but
    // something else to us.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return true;
  for (const [base, prefix] of BLOCKED_V4) {
    const baseValue = parseIpv4(base);
    if (baseValue === null) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

/** Expand any textual IPv6 form into its 8 numeric groups, or null if invalid. */
function ipv6Groups(addr: string): number[] | null {
  let text = addr;
  // Trailing dotted quad (::ffff:1.2.3.4) — fold it into two hex groups first
  // so the rest of the parser only deals with hextets.
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted?.[1] && dotted[2]) {
    const value = parseIpv4(dotted[2]);
    if (value === null) return null;
    text = `${dotted[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * Pull the IPv4 address an IPv6 address actually reaches, for every embedding
 * that resolvers and kernels honour. net.isIP() reports family 6 for all of
 * them, which is exactly how ::ffff:169.254.169.254 walked past a v4-only
 * blocklist.
 */
function embeddedIpv4(g: readonly number[]): string | null {
  const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::ffff:0:0/96 IPv4-mapped
  if (zeroThrough(5) && g[5] === 0xffff) return dotted(g[6]!, g[7]!);
  // 64:ff9b::/96 NAT64 well-known prefix
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return dotted(g[6]!, g[7]!);
  }
  // 2002::/16 6to4 carries the v4 address in groups 1-2
  if (g[0] === 0x2002) return dotted(g[1]!, g[2]!);
  // ::a.b.c.d IPv4-compatible (deprecated but still routed by some stacks).
  // :: and ::1 are handled as their own cases, not as 0.0.0.0 / 0.0.0.1.
  if (zeroThrough(6) && !(g[6] === 0 && (g[7] === 0 || g[7] === 1))) return dotted(g[6]!, g[7]!);
  return null;
}

function isBlockedIpv6(addr: string): boolean {
  const g = ipv6Groups(addr);
  if (!g) return true;
  const embedded = embeddedIpv4(g);
  if (embedded) return isBlockedIpv4(embedded);
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True when `addr` is anything other than a globally routable public IP.
 * The family is derived from the literal rather than trusted from the caller:
 * a resolver reporting family 6 for an IPv4-mapped address must still be
 * judged by the IPv4 rules.
 */
export function isPrivateIp(addr: string): boolean {
  // Strip a zone id (fe80::1%eth0) and any URL brackets before classifying.
  const ip = (addr.split('%')[0] ?? addr).replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not an IP at all → we cannot vouch for it
}

/**
 * Parse `raw`, require http(s), and prove every address it resolves to is
 * public. Throws HttpError(400) otherwise — never returns a "maybe".
 */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
  let parsed: URL;
  try {
    parsed = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new HttpError(400, 'VALIDATION', 'Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'VALIDATION', 'url must use http:// or https://');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new HttpError(400, 'VALIDATION', 'Invalid URL');

  // A literal address never goes through the resolver, so checking it directly
  // is both cheaper and immune to a resolver (or a test stub) claiming the
  // literal maps to something public.
  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) {
      throw new HttpError(400, 'VALIDATION', 'URL resolves to a private/blocked address');
    }
    return parsed;
  }

  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (e) {
    // Fail closed. Swallowing this used to yield an empty list, which then
    // sailed through the "none of these are private" loop.
    throw new HttpError(400, 'VALIDATION', `DNS lookup failed: ${(e as Error).message}`);
  }
  if (addrs.length === 0) {
    throw new HttpError(400, 'VALIDATION', 'DNS lookup returned no addresses');
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new HttpError(400, 'VALIDATION', 'URL resolves to a private/blocked address');
    }
  }
  return parsed;
}

export interface SafeFetchInit {
  /** Whole-operation budget, shared across redirect hops. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Hops allowed after the first response. 0 = reject any redirect. */
  maxRedirects?: number;
}

export interface SafeFetchResult {
  response: Response;
  /** URL that actually produced `response` — use this for extension sniffing. */
  finalUrl: URL;
}

/**
 * fetch() that keeps its SSRF promise across redirects.
 *
 * Redirects are resolved by hand (`redirect: 'manual'`) so every hop goes back
 * through assertPublicUrl. With `redirect: 'follow'` only the first URL was
 * ever checked, and undici would happily deliver the body of an internal
 * service to a caller who controls a public host that answers 302.
 */
export async function safeFetch(
  rawUrl: string | URL,
  init: SafeFetchInit = {},
): Promise<SafeFetchResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, maxRedirects = DEFAULT_MAX_REDIRECTS } = init;
  // One signal for the whole chain: a per-hop timeout would let a redirect
  // chain multiply the time we are willing to hang on to a request.
  const signal = AbortSignal.timeout(timeoutMs);
  let target = await assertPublicUrl(rawUrl);

  for (let hop = 0; ; hop++) {
    const response = await fetch(target.toString(), { signal, redirect: 'manual', headers });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: target };

    const location = response.headers.get('location');
    // Release the socket before we go around again; redirect bodies are junk.
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new HttpError(400, 'VALIDATION', `remote returned ${response.status} with no location`);
    }
    if (hop >= maxRedirects) {
      throw new HttpError(400, 'VALIDATION', `too many redirects (max ${maxRedirects})`);
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new HttpError(400, 'VALIDATION', 'remote sent an invalid redirect target');
    }
    target = await assertPublicUrl(next);
  }
}
