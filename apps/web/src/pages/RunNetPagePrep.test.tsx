import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RunNetPage } from './RunNetPage.js';

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

/** Build a session payload in PREP (liveAt null) or LIVE (liveAt set) state. */
function makeSession(opts: { live: boolean }) {
  const startedAt = new Date().toISOString();
  return {
    id: 's1',
    netId: 'n1',
    startedAt,
    liveAt: opts.live ? startedAt : null,
    endedAt: null,
    controlOpId: 'u1',
    checkIns: [],
    net,
  };
}

/**
 * Mock fetch driver — captures POST calls so individual tests can assert that
 * START NET fires POST /api/sessions/s1/start. The session state is mutable so
 * the page can re-fetch the same URL and see liveAt transition from null → set.
 */
function makeMockFetch(opts: { role: string; live: boolean }) {
  let live = opts.live;
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role: opts.role,
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    if (url.endsWith('/api/sessions/s1/start') && method === 'POST') {
      live = true;
      return json(makeSession({ live: true }));
    }
    if (url.endsWith('/api/sessions/s1')) return json(makeSession({ live }));
    return json([]);
  });
  return { fn, calls };
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

describe('RunNetPage prep/draft state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the PREP chip and "NOT YET STARTED" copy when liveAt is null', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(
      await screen.findByTestId('prep-not-started-label'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Elapsed time')).not.toBeInTheDocument();
  });

  it('shows a START NET button for OFFICERs in PREP', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(
      await screen.findByTestId('start-net-button'),
    ).toBeInTheDocument();
  });

  it('clicking START NET POSTs to /api/sessions/:id/start', async () => {
    const { fn, calls } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const startBtn = await screen.findByTestId('start-net-button');
    await userEvent.click(startBtn);
    await waitFor(() => {
      expect(
        calls.find(
          (c) =>
            c.method === 'POST' && c.url.endsWith('/api/sessions/s1/start'),
        ),
      ).toBeDefined();
    });
  });

  it('check-in Add button is disabled in PREP', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const addBtn = await screen.findByTestId('checkin-add-button');
    expect(addBtn).toBeDisabled();
    expect(
      screen.getByTestId('prep-checkin-hint'),
    ).toBeInTheDocument();
  });

  it('renders LIVE UI (elapsed timer, enabled add button) when liveAt is set', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: true });
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('prep-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('start-net-button')).not.toBeInTheDocument();
    const addBtn = screen.getByTestId('checkin-add-button');
    expect(addBtn).not.toBeDisabled();
  });

  it('hides START NET for MEMBER role', async () => {
    const { fn } = makeMockFetch({ role: 'MEMBER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    // The PREP chip should still render (everyone sees prep state) but the
    // START button is officer-gated.
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(
      screen.queryByTestId('start-net-button'),
    ).not.toBeInTheDocument();
  });
});
