import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RunNetPage } from './RunNetPage.js';

/**
 * A deleted or mistyped session id used to leave the net-control operator on
 * "Loading session…" forever: the page destructured only `data` from the fetch
 * hook, so a 404 was indistinguishable from a slow first load.
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

const session = {
  id: 's1',
  netId: 'n1',
  startedAt: new Date().toISOString(),
  liveAt: new Date().toISOString(),
  endedAt: null,
  controlOpId: 'u1',
  checkIns: [],
  net,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `sessionResponse` decides what GET /sessions/s1 answers on each call. */
function mockFetch(sessionResponse: () => Response, netsBody: unknown = [net]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role: 'OFFICER',
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/sessions/s1')) return sessionResponse();
    if (url.endsWith('/api/nets')) return json(netsBody);
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/run/s1']}>
      <AuthProvider>
        <Routes>
          <Route path="/run/:sessionId" element={<RunNetPage />} />
          <Route path="/" element={<div>DASHBOARD</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RunNetPage session load failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders an error with the server message — not a spinner — when the session 404s', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404),
      ),
    );
    renderPage();

    expect(await screen.findByTestId('runnet-load-error')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Couldn’t load this session/,
    );
    expect(screen.getByText('Session not found')).toBeInTheDocument();
    expect(screen.queryByTestId('runnet-loading')).not.toBeInTheDocument();
  });

  it('offers a Retry that loads the console once the server answers', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        fail
          ? json({ error: { code: 'INTERNAL', message: 'Boom' } }, 500)
          : json(session),
      ),
    );
    renderPage();

    await screen.findByTestId('runnet-load-error');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Net status' })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('runnet-load-error')).not.toBeInTheDocument();
  });

  it('escapes to the dashboard instead of stranding the operator', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404),
      ),
    );
    renderPage();

    await screen.findByTestId('runnet-load-error');
    await userEvent.click(
      screen.getByRole('button', { name: 'Back to dashboard' }),
    );
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });

  it('reports a session whose net no longer exists rather than loading forever', async () => {
    // Session payload without an inlined net → the page falls back to /nets,
    // which no longer lists it.
    const orphan = { ...session, net: undefined };
    vi.stubGlobal('fetch', mockFetch(() => json(orphan), []));
    renderPage();

    expect(await screen.findByTestId('runnet-load-error')).toBeInTheDocument();
    expect(
      screen.getByText(/references a net that no longer exists/),
    ).toBeInTheDocument();
  });

  it('still shows the loading state while the first request is in flight', async () => {
    // A session request that never settles is a genuine "loading", and must
    // not be mistaken for the error state.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me'))
          return json({
            id: 'u1',
            callsign: 'W1AW',
            name: 'Op',
            email: 'o@x.co',
            role: 'OFFICER',
          });
        if (url.endsWith('/api/sessions/s1')) return new Promise<Response>(() => {});
        return json([]);
      }),
    );
    renderPage();

    expect(await screen.findByTestId('runnet-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('runnet-load-error')).not.toBeInTheDocument();
  });

  it('keeps the console on screen when a later poll fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch(() => {
        calls += 1;
        return calls === 1
          ? json(session)
          : json({ error: { code: 'INTERNAL', message: 'Boom' } }, 500);
      }),
    );
    renderPage();

    const strip = await screen.findByRole('region', { name: 'Net status' });
    // Force the second (failing) fetch the same way the poll would.
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    // The live console must survive one dropped request.
    expect(strip).toBeInTheDocument();
    expect(screen.queryByTestId('runnet-load-error')).not.toBeInTheDocument();
  });
});
