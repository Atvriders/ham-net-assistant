import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import { isPrivateIp, assertPublicUrl, safeFetch } from '../../src/lib/safeFetch.js';
import { HttpError } from '../../src/middleware/error.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockDns(...addresses: string[]) {
  vi.spyOn(dns, 'lookup').mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never,
  );
}

/** 302 with a Location, i.e. what an attacker-controlled host answers. */
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('isPrivateIp', () => {
  const blocked = [
    ['loopback v4', '127.0.0.1'],
    ['this-network', '0.0.0.0'],
    ['RFC1918 10/8', '10.1.2.3'],
    ['RFC1918 172.16/12', '172.20.0.1'],
    ['RFC1918 192.168/16', '192.168.1.1'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['CGNAT 100.64/10', '100.64.1.1'],
    ['CGNAT upper bound', '100.127.255.255'],
    ['broadcast', '255.255.255.255'],
    ['multicast', '224.0.0.1'],
    ['loopback v6', '::1'],
    ['unspecified v6', '::'],
    ['link-local v6', 'fe80::1'],
    ['link-local v6 with zone', 'fe80::1%eth0'],
    ['unique-local v6', 'fd00::1'],
    ['IPv4-mapped metadata (dotted)', '::ffff:169.254.169.254'],
    ['IPv4-mapped loopback (dotted)', '::ffff:127.0.0.1'],
    ['IPv4-mapped metadata (hex)', '::ffff:a9fe:a9fe'],
    ['NAT64 metadata', '64:ff9b::a9fe:a9fe'],
    ['6to4 metadata', '2002:a9fe:a9fe::1'],
    ['octal-looking v4', '0177.0.0.1'],
    ['not an address at all', 'localhost'],
  ] as const;
  for (const [label, addr] of blocked) {
    it(`blocks ${label} (${addr})`, () => {
      expect(isPrivateIp(addr)).toBe(true);
    });
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.0', '2606:4700:4700::1111'];
  for (const addr of allowed) {
    it(`allows public ${addr}`, () => {
      expect(isPrivateIp(addr)).toBe(false);
    });
  }
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects a bare private IP without consulting DNS', async () => {
    const spy = vi.spyOn(dns, 'lookup');
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when DNS lookup throws', async () => {
    // The old guard did `.catch(() => [])`, so a failed lookup produced an
    // empty address list that then passed the "nothing private here" loop.
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('https://nope.example/x')).rejects.toMatchObject({ status: 400 });
  });

  it('fails closed when DNS returns no addresses', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([] as never);
    await expect(assertPublicUrl('https://empty.example/x')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects when ANY resolved address is private (multi-record host)', async () => {
    mockDns('93.184.216.34', '10.0.0.5');
    await expect(assertPublicUrl('https://mixed.example/x')).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a host that resolves entirely to public addresses', async () => {
    mockDns('93.184.216.34');
    const u = await assertPublicUrl('https://example.com/doc.txt');
    expect(u.hostname).toBe('example.com');
  });
});

describe('safeFetch redirect handling', () => {
  it('re-validates each hop and refuses a redirect into private space', async () => {
    mockDns('93.184.216.34');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(redirect('http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch('https://example.com/doc')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION',
    });
    // The internal host must never have been contacted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://example.com/doc');
  });

  it('refuses a redirect whose host resolves privately (DNS-level SSRF)', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation((async (host: string) =>
      host === 'example.com'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }]) as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(redirect('https://evil.example/steal'));
    await expect(safeFetch('https://example.com/doc')).rejects.toMatchObject({ status: 400 });
  });

  it('follows a public redirect and reports the final URL', async () => {
    mockDns('93.184.216.34');
    let hop = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      hop += 1;
      return hop === 1
        ? redirect('https://example.com/final.docx')
        : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const { response, finalUrl } = await safeFetch('https://example.com/doc');
    expect(response.status).toBe(200);
    expect(finalUrl.pathname).toBe('/final.docx');
  });

  it('resolves relative Location headers against the current hop', async () => {
    mockDns('93.184.216.34');
    let hop = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      hop += 1;
      return hop === 1 ? redirect('/moved/here.txt') : new Response('ok', { status: 200 });
    });
    const { finalUrl } = await safeFetch('https://example.com/a/b');
    expect(finalUrl.toString()).toBe('https://example.com/moved/here.txt');
  });

  it('caps the redirect chain', async () => {
    mockDns('93.184.216.34');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(redirect('https://example.com/loop'));
    await expect(safeFetch('https://example.com/loop')).rejects.toMatchObject({ status: 400 });
    // 1 initial + 3 allowed hops, then we stop.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('maxRedirects:0 refuses any redirect at all', async () => {
    mockDns('93.184.216.34');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(redirect('https://example.com/elsewhere'));
    await expect(
      safeFetch('https://example.com/logo.png', { maxRedirects: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a 3xx with no Location rather than returning it as content', async () => {
    mockDns('93.184.216.34');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302 }));
    await expect(safeFetch('https://example.com/doc')).rejects.toMatchObject({ status: 400 });
  });

  it('asks undici for manual redirects so nothing is followed behind our back', async () => {
    mockDns('93.184.216.34');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    await safeFetch('https://example.com/doc');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
  });
});
