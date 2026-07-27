import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RunNetPage } from './RunNetPage.js';

/**
 * Console chrome: the measured sticky offsets, the destructive-keystroke
 * removal, and the overflow disclosure's keyboard contract.
 */

const repeater = {
  id: 'r1',
  name: 'R1',
  frequency: 146.76,
  offsetKhz: -600,
  toneHz: 100,
  mode: 'FM',
};

const net = {
  id: 'n1',
  name: 'Tuesday Net',
  kind: 'weekly',
  repeaterId: 'r1',
  dayOfWeek: 2,
  startLocal: '20:00',
  timezone: 'UTC',
  theme: null,
  scriptMd: 'Welcome to the net.',
  scriptCategory: 'weekly',
  active: true,
  repeater,
  links: [],
};

const checkIn = {
  id: 'c1',
  callsign: 'KA1AAA',
  nameAtCheckIn: 'Alpha',
  checkedInAt: new Date().toISOString(),
  mode: 'rf' as const,
  createdById: 'u1',
};

const session = {
  id: 's1',
  netId: 'n1',
  startedAt: new Date().toISOString(),
  liveAt: new Date().toISOString(),
  endedAt: null,
  controlOpId: 'u1',
  checkIns: [checkIn],
  net,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(onRequest?: (url: string, init?: RequestInit) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    onRequest?.(url, init);
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role: 'OFFICER',
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/sessions/s1')) return json(session);
    if (url.endsWith('/api/nets')) return json([net]);
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/run/s1']}>
      <AuthProvider>
        <Routes>
          <Route path="/run/:sessionId" element={<RunNetPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/**
 * Stand in for a laid-out app shell: jsdom has no layout engine, so element
 * heights have to be faked per element class.
 */
function stubHeights(heights: { nav: number; status: number }) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const height = this.classList.contains('hna-shell__nav')
      ? heights.nav
      : this.classList.contains('hna-runnet-status')
        ? heights.status
        : 0;
    return {
      x: 0,
      y: 0,
      width: 0,
      height,
      top: 0,
      right: 0,
      bottom: height,
      left: 0,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Minimal ResizeObserver double whose callbacks can be fired on demand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(private cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  fire() {
    this.cb();
  }
}

function mountShellNav(): HTMLElement {
  const nav = document.createElement('header');
  nav.className = 'hna-shell__nav';
  document.body.appendChild(nav);
  return nav;
}

describe('RunNetPage sticky-chrome measurements', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('.hna-shell__nav').forEach((n) => n.remove());
    document.documentElement.style.removeProperty('--nav-h');
    document.documentElement.style.removeProperty('--runnet-status-h');
    FakeResizeObserver.instances = [];
  });

  it('publishes the measured nav and status-strip heights', async () => {
    const restore = stubHeights({ nav: 210, status: 96 });
    try {
      mountShellNav();
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      vi.stubGlobal('fetch', mockFetch());
      renderPage();
      await screen.findByRole('region', { name: 'Net status' });

      await waitFor(() => {
        expect(
          document.documentElement.style.getPropertyValue('--nav-h'),
        ).toBe('210px');
      });
      // A 210px nav is the phone case the hard-coded 56px got wrong.
      expect(
        document.documentElement.style.getPropertyValue('--runnet-status-h'),
      ).toBe('96px');
    } finally {
      restore();
    }
  });

  it('re-measures when the nav wraps to a different height', async () => {
    const heights = { nav: 210, status: 96 };
    const restore = stubHeights(heights);
    try {
      mountShellNav();
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      vi.stubGlobal('fetch', mockFetch());
      renderPage();
      await screen.findByRole('region', { name: 'Net status' });
      await waitFor(() => {
        expect(
          document.documentElement.style.getPropertyValue('--nav-h'),
        ).toBe('210px');
      });

      // Viewport widened → the nav tail no longer wraps.
      heights.nav = 64;
      FakeResizeObserver.instances.forEach((ro) => ro.fire());
      await waitFor(() => {
        expect(
          document.documentElement.style.getPropertyValue('--nav-h'),
        ).toBe('64px');
      });
    } finally {
      restore();
    }
  });

  it('falls back to resize events when ResizeObserver is unavailable', async () => {
    // jsdom has no ResizeObserver at all — the same as a handful of older
    // mobile browsers. The offsets must still be measured, and nothing may
    // throw.
    expect(
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver,
    ).toBeUndefined();
    const heights = { nav: 180, status: 90 };
    const restore = stubHeights(heights);
    try {
      mountShellNav();
      vi.stubGlobal('fetch', mockFetch());
      renderPage();
      await screen.findByRole('region', { name: 'Net status' });
      await waitFor(() => {
        expect(
          document.documentElement.style.getPropertyValue('--nav-h'),
        ).toBe('180px');
      });

      heights.nav = 72;
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => {
        expect(
          document.documentElement.style.getPropertyValue('--nav-h'),
        ).toBe('72px');
      });
    } finally {
      restore();
    }
  });

  it('leaves the CSS fallback in place when nothing has a measurable height', async () => {
    // Plain jsdom: every rect is 0. Writing `--nav-h: 0px` would slide the
    // status strip under the nav, so the property must stay unset.
    mountShellNav();
    vi.stubGlobal('fetch', mockFetch());
    renderPage();
    await screen.findByRole('region', { name: 'Net status' });
    expect(document.documentElement.style.getPropertyValue('--nav-h')).toBe('');
  });

  it('clears the properties when the console unmounts', async () => {
    const restore = stubHeights({ nav: 210, status: 96 });
    try {
      mountShellNav();
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      vi.stubGlobal('fetch', mockFetch());
      const view = renderPage();
      await screen.findByRole('region', { name: 'Net status' });
      await waitFor(() => {
        expect(
          document.documentElement.style.getPropertyValue('--nav-h'),
        ).toBe('210px');
      });
      view.unmount();
      expect(document.documentElement.style.getPropertyValue('--nav-h')).toBe('');
    } finally {
      restore();
    }
  });
});

describe('RunNetPage check-in keyboard safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not delete the last check-in on a bare Backspace in an empty callsign field', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch((url, init) =>
        requests.push({ url, method: init?.method ?? 'GET' }),
      ),
    );
    renderPage();

    const callsign = await screen.findByLabelText('Callsign');
    await userEvent.click(callsign);
    await userEvent.keyboard('{Backspace}{Backspace}');

    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    // The visible, labelled Undo is the only path to that deletion.
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});

describe('RunNetPage overflow disclosure', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a disclosure, not an ARIA menu, and closes on Escape with focus restored', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderPage();

    const trigger = await screen.findByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // role="menu" promises arrow-key navigation this never implemented.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(document.getElementById('run-overflow-panel')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('run-overflow-panel')).not.toBeInTheDocument();
    // Focus must land back on the trigger, not on <body>.
    expect(document.activeElement).toBe(trigger);
  });
});
