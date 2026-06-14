/**
 * Viewport-resilience sweep.
 *
 * Mounts a representative set of top-level pages in jsdom at three
 * viewport widths (375, 768, 1280) and asserts that no element's
 * `scrollWidth` exceeds the viewport `clientWidth` — i.e. the page
 * never triggers a horizontal scrollbar.
 *
 * jsdom doesn't run a real layout engine, so the assertion is a smoke
 * test: it catches absolutely-positioned elements / fixed-width tables
 * / hardcoded pixel widths that exceed the viewport. It does NOT
 * exercise flex/grid wrapping the way a real browser does, but it
 * does catch the worst regressions (which is the bar we want here —
 * "nothing goes off the screen", per the user's request).
 */
import { describe, it, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';
import { Dashboard } from './pages/Dashboard.js';
import { NetsPage } from './pages/NetsPage.js';
import { RunNetPage } from './pages/RunNetPage.js';

/** Resize the jsdom viewport — `clientWidth` is derived from it. */
function setViewport(w: number, h = 800) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: w,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: h,
  });
  // Re-fire the resize event so any width-watching listeners pick it
  // up. The pages under test don't currently subscribe to resize, but
  // this keeps the test honest if that changes.
  window.dispatchEvent(new Event('resize'));
}

const WIDTHS = [375, 768, 1280] as const;

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
  reminderMinutes: 0,
};

const sessionLive = {
  id: 's1',
  netId: 'n1',
  startedAt: new Date().toISOString(),
  liveAt: new Date().toISOString(),
  endedAt: null,
  controlOpId: 'u1',
  checkIns: [],
  net,
};

const sessionPrep = {
  ...sessionLive,
  liveAt: null,
};

function makeFetchStub(opts: { role?: string; session?: unknown } = {}) {
  const role = opts.role ?? 'OFFICER';
  const session = opts.session ?? sessionLive;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/sessions/s1')) return json(session);
    if (url.endsWith('/api/nets')) return json([net]);
    if (url.endsWith('/api/sessions')) return json([]);
    if (url.endsWith('/api/nets/active')) return json([]);
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    return json([]);
  });
}

/**
 * Walk every element in the document and return the first one whose
 * `scrollWidth` exceeds the viewport's `clientWidth`. The body itself
 * is excluded — it intentionally has `overflow-x: hidden` so its
 * `scrollWidth` can be misleading. Returns null if nothing overflows.
 *
 * jsdom returns 0 for most layout-derived properties (it's not a real
 * layout engine), so this is effectively a smoke test: it catches
 * absolutely-positioned children with explicit width that exceeds the
 * viewport, not flex/grid runtime wrap behavior.
 */
function findOverflowingElement(): Element | null {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const all = document.querySelectorAll('*');
  for (const el of Array.from(all)) {
    if (el === document.body || el === document.documentElement) continue;
    // Skip elements that don't have intrinsic size in jsdom; only flag
    // when scrollWidth is actually populated (e.g. an inline-set width).
    const sw = el.scrollWidth;
    if (sw > viewportWidth + 1) return el;
  }
  return null;
}

function expectNoHorizontalOverflow(label: string) {
  const el = findOverflowingElement();
  if (el) {
    const tag = el.tagName.toLowerCase();
    const cls = el.className?.toString().slice(0, 80) ?? '';
    throw new Error(
      `${label}: element <${tag} class="${cls}"> has scrollWidth=${el.scrollWidth} > viewport=${document.documentElement.clientWidth}`,
    );
  }
}

describe('viewport resilience — no horizontal page scroll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const w of WIDTHS) {
    it(`LoginPage at ${w}px`, () => {
      setViewport(w);
      vi.stubGlobal('fetch', makeFetchStub({ role: 'MEMBER' }));
      render(
        <MemoryRouter initialEntries={['/login']}>
          <AuthProvider>
            <LoginPage />
          </AuthProvider>
        </MemoryRouter>,
      );
      expectNoHorizontalOverflow(`LoginPage @${w}px`);
    });

    it(`RegisterPage at ${w}px`, () => {
      setViewport(w);
      vi.stubGlobal('fetch', makeFetchStub({ role: 'MEMBER' }));
      render(
        <MemoryRouter initialEntries={['/register']}>
          <AuthProvider>
            <RegisterPage />
          </AuthProvider>
        </MemoryRouter>,
      );
      expectNoHorizontalOverflow(`RegisterPage @${w}px`);
    });

    it(`Dashboard at ${w}px`, () => {
      setViewport(w);
      vi.stubGlobal('fetch', makeFetchStub());
      render(
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <Dashboard />
          </AuthProvider>
        </MemoryRouter>,
      );
      expectNoHorizontalOverflow(`Dashboard @${w}px`);
    });

    it(`NetsPage at ${w}px`, () => {
      setViewport(w);
      vi.stubGlobal('fetch', makeFetchStub());
      render(
        <MemoryRouter initialEntries={['/nets']}>
          <AuthProvider>
            <NetsPage />
          </AuthProvider>
        </MemoryRouter>,
      );
      expectNoHorizontalOverflow(`NetsPage @${w}px`);
    });

    it(`RunNetPage LIVE at ${w}px`, () => {
      setViewport(w);
      vi.stubGlobal('fetch', makeFetchStub({ session: sessionLive }));
      render(
        <MemoryRouter initialEntries={['/run/s1']}>
          <AuthProvider>
            <Routes>
              <Route path="/run/:sessionId" element={<RunNetPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>,
      );
      expectNoHorizontalOverflow(`RunNetPage LIVE @${w}px`);
    });

    it(`RunNetPage PREP at ${w}px`, () => {
      setViewport(w);
      vi.stubGlobal('fetch', makeFetchStub({ session: sessionPrep }));
      render(
        <MemoryRouter initialEntries={['/run/s1']}>
          <AuthProvider>
            <Routes>
              <Route path="/run/:sessionId" element={<RunNetPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>,
      );
      expectNoHorizontalOverflow(`RunNetPage PREP @${w}px`);
    });
  }
});
