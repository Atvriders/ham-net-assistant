import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useLiveNets } from './useLiveNets.js';

const repeater = { id: 'r1', name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' };

function row(id: string, liveAt: string | null, name = 'Net') {
  return {
    id,
    netId: 'n1',
    startedAt: new Date().toISOString(),
    liveAt,
    endedAt: null,
    controlOpId: 'u1',
    notes: null,
    autoOpened: false,
    net: { id: 'n1', name, repeater },
  };
}

function stub(rows: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/nets/active')) return json(rows);
    return json([]);
  });
}

function Probe() {
  const { liveCount, prepCount } = useLiveNets({ intervalMs: 1000 });
  return <span data-testid="probe">{`live=${liveCount} prep=${prepCount}`}</span>;
}

describe('useLiveNets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits active sessions into live vs prep', async () => {
    vi.stubGlobal(
      'fetch',
      stub([row('s1', new Date().toISOString()), row('p1', null), row('p2', null)]),
    );
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe')).toHaveTextContent('live=1 prep=2');
    });
  });

  it('reports zero when there are no active sessions', async () => {
    vi.stubGlobal('fetch', stub([]));
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe')).toHaveTextContent('live=0 prep=0');
    });
  });
});
