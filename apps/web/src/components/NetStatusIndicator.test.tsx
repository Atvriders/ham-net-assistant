import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NetStatusIndicator } from './NetStatusIndicator.js';

const repeater = {
  id: 'r1',
  name: 'R1',
  frequency: 146.76,
  offsetKhz: -600,
  mode: 'FM',
};

function liveSession(id = 's1', name = 'Tuesday Net') {
  return {
    id,
    netId: 'n1',
    startedAt: new Date().toISOString(),
    liveAt: new Date().toISOString(),
    endedAt: null,
    controlOpId: 'u1',
    notes: null,
    autoOpened: false,
    net: { id: 'n1', name, repeater },
  };
}

function prepSession(id = 'p1', name = 'Prep Net') {
  return { ...liveSession(id, name), liveAt: null };
}

/**
 * Stub `fetch` for `/api/nets/active`. `getRows` is read on every call so a
 * test can flip the response between polls (e.g. to drive the 0 -> 1 ping).
 */
function stubActive(getRows: () => unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/nets/active')) return json(getRows());
    return json([]);
  });
}

function renderIndicator() {
  return render(
    <MemoryRouter>
      <NetStatusIndicator />
    </MemoryRouter>,
  );
}

describe('NetStatusIndicator', () => {
  beforeEach(() => {
    // No Notification API by default — exercises the guarded fallback.
    vi.stubGlobal('Notification', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a LIVE chip linking to the running net when one net is live', async () => {
    vi.stubGlobal('fetch', stubActive(() => [liveSession('s9', 'Net Nine')]));
    renderIndicator();
    const live = await screen.findByTestId('net-status-live');
    expect(live).toHaveTextContent('1 LIVE');
    expect(live).toHaveAttribute('href', '/run/s9');
    expect(screen.queryByTestId('net-status-prep')).toBeNull();
  });

  it('links multiple live nets to the dashboard', async () => {
    vi.stubGlobal('fetch', stubActive(() => [liveSession('s1'), liveSession('s2', 'Two')]));
    renderIndicator();
    const live = await screen.findByTestId('net-status-live');
    expect(live).toHaveTextContent('2 LIVE');
    expect(live).toHaveAttribute('href', '/');
  });

  it('shows a PREP chip (and no LIVE) when only prep sessions exist', async () => {
    vi.stubGlobal('fetch', stubActive(() => [prepSession('p7', 'Prep Seven')]));
    renderIndicator();
    const prep = await screen.findByTestId('net-status-prep');
    expect(prep).toHaveTextContent('1 PREP');
    expect(prep).toHaveAttribute('href', '/run/p7');
    expect(screen.queryByTestId('net-status-live')).toBeNull();
  });

  it('renders nothing when there are no active sessions', async () => {
    vi.stubGlobal('fetch', stubActive(() => []));
    const { container } = renderIndicator();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="net-status-indicator"]')).toBeNull();
    });
  });

  it('fires the ping pulse + a Notification on the 0 -> 1 live transition', async () => {
    // Mock the Notification API as granted; capture constructions.
    const ctor = vi.fn();
    const NotificationMock = ctor as unknown as { permission: string };
    NotificationMock.permission = 'granted';
    vi.stubGlobal('Notification', NotificationMock);

    let rows: unknown[] = [];
    vi.stubGlobal('fetch', stubActive(() => rows));

    // Short real-timer poll cadence so the 0 -> 1 transition happens fast.
    render(
      <MemoryRouter>
        <NetStatusIndicator intervalMs={30} />
      </MemoryRouter>,
    );

    // First poll: no live nets, indicator absent.
    await waitFor(() => {
      expect(screen.queryByTestId('net-status-live')).toBeNull();
    });

    // A net starts — the next poll picks it up and pings.
    rows = [liveSession('s5', 'Fresh Net')];

    const live = await screen.findByTestId('net-status-live');
    // The pulse is applied by the 0→1 transition effect, which under React 19
    // can commit a tick after the chip itself appears — assert eventually.
    // (The pulse stays up for 2400ms, far beyond waitFor's window.)
    await waitFor(() => {
      expect(live).toHaveAttribute('data-pinging', 'true');
      expect(live.className).toContain('is-pinging');
    });
    // Best-effort Web Notification fired with the net name.
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith('Net started', { body: 'Fresh Net' });
  });

  it('does not fire a Notification when permission is not granted', async () => {
    const ctor = vi.fn();
    const NotificationMock = ctor as unknown as { permission: string };
    NotificationMock.permission = 'denied';
    vi.stubGlobal('Notification', NotificationMock);

    let rows: unknown[] = [];
    vi.stubGlobal('fetch', stubActive(() => rows));

    render(
      <MemoryRouter>
        <NetStatusIndicator intervalMs={30} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('net-status-live')).toBeNull();
    });
    rows = [liveSession('s6', 'Quiet Net')];

    const live = await screen.findByTestId('net-status-live');
    // In-app pulse still fires (eventually — see the transition-effect note
    // in the granted-permission test)...
    await waitFor(() => {
      expect(live.className).toContain('is-pinging');
    });
    // ...but no desktop Notification when permission was denied.
    expect(ctor).not.toHaveBeenCalled();
  });
});
