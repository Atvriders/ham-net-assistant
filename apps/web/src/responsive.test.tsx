/**
 * Fixed-width audit — the honest replacement for the old "viewport
 * resilience" sweep.
 *
 * WHAT THE OLD FILE DID: it mounted five pages at 375 / 768 / 1280px and
 * asserted that no element's `scrollWidth` exceeded the viewport. jsdom has no
 * layout engine — `scrollWidth` is 0 for every element, including a 5000px
 * div — so `sw > viewportWidth + 1` could never be true. Eighteen tests, none
 * of which could fail, under a docstring claiming they caught hardcoded pixel
 * widths. It also never awaited any fetch, so most of those pages were still
 * showing "Loading…" when the (impossible) assertion ran.
 *
 * WHAT THIS FILE DOES INSTEAD: it audits something jsdom really implements —
 * inline style declarations. Any element that pins a `width` / `min-width`
 * wider than the narrowest supported viewport (360px) must sit inside a
 * horizontal scroll container, which is exactly the convention the app already
 * follows for its wide tables (`.hna-table-scroll`, `overflow-x: auto`). A new
 * `style={{ minWidth: 900 }}` on a page body — the regression the old file
 * claimed to catch — fails this suite.
 *
 * The audit's teeth are themselves under test: `detects a naked wide element`
 * and `accepts the same element inside a scroll container` are canaries that
 * fail if the predicate ever stops discriminating. Real horizontal-overflow
 * behavior (flex/grid wrapping, intrinsic content width) needs a real layout
 * engine and belongs in a browser-based test, not here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { Dashboard } from './pages/Dashboard.js';
import { NetsPage } from './pages/NetsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { RunNetPage } from './pages/RunNetPage.js';

/** Narrowest phone this app supports; anything wider must be able to scroll. */
const NARROWEST_VIEWPORT = 360;

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
  checkIns: [
    {
      id: 'c1',
      callsign: 'KA1AAA',
      nameAtCheckIn: 'Alpha Anderson',
      checkedInAt: new Date().toISOString(),
      mode: 'rf' as const,
      createdById: 'u1',
    },
  ],
  net,
};

const sessionPrep = { ...sessionLive, liveAt: null };

const adminUser = {
  id: 'u1',
  callsign: 'W1AW',
  name: 'Op',
  email: 'o@x.co',
  role: 'ADMIN',
  collegeSlug: null,
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
    if (url.endsWith('/auth/me')) return json({ ...adminUser, role });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/presence/online')) return json([]);
    if (url.endsWith('/api/sessions/s1')) return json(session);
    if (url.endsWith('/api/nets/active')) return json([]);
    if (url.endsWith('/api/nets')) return json([net]);
    if (url.endsWith('/api/sessions')) return json([]);
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    if (url.endsWith('/api/users')) return json([adminUser]);
    if (url.endsWith('/api/themes')) return json([]);
    if (url.endsWith('/themes/default')) return json({ slug: 'default' });
    if (url.endsWith('/admin/trash')) return json({ sessions: [], checkIns: [] });
    if (url.endsWith('/admin/duplicate-sessions')) return json([]);
    if (url.endsWith('/discord/config'))
      return json({
        enabled: false,
        channelId: '',
        tokenSet: false,
        tokenFromEnv: false,
        channelIdFromEnv: false,
        enabledFromEnv: false,
      });
    return json([]);
  });
}

/** Parse `"720px"` / `"720"` into a number; anything relative returns null. */
function pxValue(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)(px)?$/.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * True when this element can scroll its overflow horizontally — either via an
 * inline overflow declaration or the app's `.hna-table-scroll` convention
 * (which sets `overflow-x: auto` in ui.css; stylesheets aren't loaded in
 * jsdom, so the class is the check).
 */
function isHorizontalScroller(el: HTMLElement): boolean {
  if (el.classList.contains('hna-table-scroll')) return true;
  const { overflowX, overflow } = el.style;
  return /(auto|scroll)/.test(`${overflowX} ${overflow}`);
}

/** `<tag class="…">` — enough to find the offender in a failure message. */
function describeEl(el: HTMLElement): string {
  const cls = el.getAttribute('class');
  return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ''}>`;
}

interface WideElement {
  el: HTMLElement;
  property: 'width' | 'min-width';
  px: number;
  scrollable: boolean;
}

/**
 * Every element pinned wider than the narrowest supported viewport, flagged
 * with whether some ancestor can scroll it horizontally.
 */
function findWideElements(root: ParentNode): WideElement[] {
  const found: WideElement[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const candidates: Array<['width' | 'min-width', number | null]> = [
      ['width', pxValue(el.style.width)],
      ['min-width', pxValue(el.style.minWidth)],
    ];
    for (const [property, px] of candidates) {
      if (px === null || px <= NARROWEST_VIEWPORT) continue;
      let scrollable = false;
      for (
        let node: HTMLElement | null = el.parentElement;
        node && node !== document.body;
        node = node.parentElement
      ) {
        if (isHorizontalScroller(node)) {
          scrollable = true;
          break;
        }
      }
      found.push({ el, property, px, scrollable });
    }
  }
  return found;
}

function expectNoNakedWideElements(label: string, root: ParentNode) {
  const naked = findWideElements(root).filter((w) => !w.scrollable);
  if (naked.length > 0) {
    const list = naked
      .map((w) => `${describeEl(w.el)} ${w.property}: ${w.px}px`)
      .join('; ');
    throw new Error(
      `${label}: ${naked.length} element(s) pinned wider than ${NARROWEST_VIEWPORT}px ` +
        `with no horizontally scrollable ancestor — ${list}`,
    );
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the fixed-width audit itself', () => {
  it('detects a naked wide element', () => {
    const { container } = render(<div style={{ minWidth: 900 }} />);
    const naked = findWideElements(container).filter((w) => !w.scrollable);
    expect(naked).toHaveLength(1);
    expect(naked[0]!.px).toBe(900);
    expect(() => expectNoNakedWideElements('fixture', container)).toThrow(
      /pinned wider than 360px/,
    );
  });

  it('accepts the same element inside a scroll container', () => {
    const { container } = render(
      <div className="hna-table-scroll" style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 900 }} />
      </div>,
    );
    expect(findWideElements(container)).toHaveLength(1);
    expect(findWideElements(container)[0]!.scrollable).toBe(true);
    expect(() => expectNoNakedWideElements('fixture', container)).not.toThrow();
  });

  it('ignores widths a phone can actually honour', () => {
    const { container } = render(<div style={{ width: 320 }} />);
    expect(findWideElements(container)).toHaveLength(0);
  });
});

describe('pages pin no width a phone cannot scroll', () => {
  it('LoginPage', async () => {
    vi.stubGlobal('fetch', makeFetchStub({ role: 'MEMBER' }));
    const { container } = render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /sign in/i });
    expectNoNakedWideElements('LoginPage', container);
  });

  it('RegisterPage', async () => {
    vi.stubGlobal('fetch', makeFetchStub({ role: 'MEMBER' }));
    const { container } = render(
      <MemoryRouter initialEntries={['/register']}>
        <AuthProvider>
          <RegisterPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByLabelText(/callsign/i);
    expectNoNakedWideElements('RegisterPage', container);
  });

  it('Dashboard', async () => {
    vi.stubGlobal('fetch', makeFetchStub());
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Dashboard />
        </AuthProvider>
      </MemoryRouter>,
    );
    // Wait for real content — the old suite audited a "Loading…" screen.
    await screen.findByText('Tuesday Net');
    expectNoNakedWideElements('Dashboard', container);
  });

  it('NetsPage', async () => {
    vi.stubGlobal('fetch', makeFetchStub());
    const { container } = render(
      <MemoryRouter initialEntries={['/nets']}>
        <AuthProvider>
          <NetsPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Tuesday Net');
    expectNoNakedWideElements('NetsPage', container);
  });

  it('RunNetPage (LIVE)', async () => {
    vi.stubGlobal('fetch', makeFetchStub({ session: sessionLive }));
    const { container } = render(
      <MemoryRouter initialEntries={['/run/s1']}>
        <AuthProvider>
          <Routes>
            <Route path="/run/:sessionId" element={<RunNetPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('region', { name: 'Net status' });
    expectNoNakedWideElements('RunNetPage LIVE', container);
  });

  it('RunNetPage (PREP)', async () => {
    vi.stubGlobal('fetch', makeFetchStub({ session: sessionPrep }));
    const { container } = render(
      <MemoryRouter initialEntries={['/run/s1']}>
        <AuthProvider>
          <Routes>
            <Route path="/run/:sessionId" element={<RunNetPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByTestId('prep-chip');
    expectNoNakedWideElements('RunNetPage PREP', container);
  });

  it('AdminPage keeps its deliberately wide tables inside scrollers', async () => {
    vi.stubGlobal('fetch', makeFetchStub({ role: 'ADMIN' }));
    const { container } = render(
      <MemoryRouter initialEntries={['/admin']}>
        <AuthProvider>
          <ThemeProvider>
            <AdminPage />
          </ThemeProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByLabelText('Role for W1AW');
    // Positive control: this page really does pin a table wider than a phone,
    // so the audit is exercised against production markup and not just the
    // fixtures above.
    const wide = findWideElements(container);
    expect(wide.length).toBeGreaterThan(0);
    expectNoNakedWideElements('AdminPage', container);
  });
});
