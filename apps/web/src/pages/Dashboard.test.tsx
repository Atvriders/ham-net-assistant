import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { Dashboard } from './Dashboard.js';

const repeater = {
  id: 'r1',
  name: 'R1',
  frequency: 146.76,
  offsetKhz: -600,
  toneHz: 100,
  mode: 'FM',
};

const weeklyNet = {
  id: 'n1',
  name: 'Tuesday Net',
  kind: 'weekly',
  repeaterId: 'r1',
  dayOfWeek: 2,
  startLocal: '20:00',
  timezone: 'UTC',
  theme: null,
  scriptMd: '',
  scriptCategory: 'weekly',
  active: true,
  repeater,
  links: [],
};

const endedSession = {
  id: 's1',
  netId: 'n1',
  startedAt: new Date('2026-07-01T20:00:00Z').toISOString(),
  liveAt: new Date('2026-07-01T20:00:00Z').toISOString(),
  endedAt: new Date('2026-07-01T21:00:00Z').toISOString(),
  controlOpId: 'u1',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Routes {
  role?: string;
  nets?: () => Response;
  sessions?: () => Response;
  active?: () => Response;
  onRequest?: (url: string, init?: RequestInit) => void;
}

function mockFetch(routes: Routes = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    routes.onRequest?.(url, init);
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role: routes.role ?? 'ADMIN',
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/nets/active'))
      return routes.active ? routes.active() : json([]);
    if (url.endsWith('/api/nets')) return routes.nets ? routes.nets() : json([]);
    if (url.endsWith('/api/sessions'))
      return routes.sessions ? routes.sessions() : json([]);
    if (url.startsWith('/api/sessions/')) return json({});
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Dashboard />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('Dashboard load failures vs empty states', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a calm retry notice — not the add-your-first-net pitch — when /nets fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        nets: () => json({ error: { code: 'INTERNAL', message: 'Boom' } }, 500),
      }),
    );
    renderPage();

    const notice = await screen.findByTestId('dash-nets-error');
    expect(notice).toHaveTextContent(/Couldn’t load the net schedule/);
    expect(notice).toHaveTextContent('Boom');
    // A dead server must never be reported as "your club has no nets".
    expect(
      screen.queryByText('No weekly nets scheduled.'),
    ).not.toBeInTheDocument();
    // Polite, not alarming: it self-heals on the next poll.
    expect(notice).toHaveAttribute('role', 'status');
  });

  it('still shows the empty state when /nets legitimately returns no nets', async () => {
    vi.stubGlobal('fetch', mockFetch({ nets: () => json([]) }));
    renderPage();

    expect(
      await screen.findByText('No weekly nets scheduled.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('dash-nets-error')).not.toBeInTheDocument();
  });

  it('distinguishes failed loads in the ACTIVE NOW and RECENT sections too', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        nets: () => json([weeklyNet]),
        active: () => json({ error: { code: 'INTERNAL', message: 'A' } }, 500),
        sessions: () => json({ error: { code: 'INTERNAL', message: 'S' } }, 500),
      }),
    );
    renderPage();

    expect(await screen.findByTestId('dash-active-error')).toBeInTheDocument();
    expect(await screen.findByTestId('dash-recent-error')).toBeInTheDocument();
    expect(screen.queryByText('No nets are live.')).not.toBeInTheDocument();
    expect(screen.queryByText('No sessions logged yet.')).not.toBeInTheDocument();
  });
});

describe('Dashboard session delete', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('confirms in-app instead of with window.confirm, then DELETEs', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch({
        sessions: () => json([endedSession]),
        onRequest: (url, init) =>
          requests.push({ url, method: init?.method ?? 'GET' }),
      }),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete session' }),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Delete this session and all its check-ins?'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(
        requests.some(
          (r) => r.method === 'DELETE' && r.url.endsWith('/api/sessions/s1'),
        ),
      ).toBe(true);
    });
    confirmSpy.mockRestore();
  });

  it('keeps the dialog open and shows the reason when the delete fails', async () => {
    // Hand-rolled instead of `mockFetch` so the DELETE specifically 409s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me'))
          return json({
            id: 'u1',
            callsign: 'W1AW',
            name: 'Op',
            email: 'o@x.co',
            role: 'ADMIN',
          });
        if (url.endsWith('/presence/heartbeat')) return json({});
        if (init?.method === 'DELETE')
          return json(
            { error: { code: 'CONFLICT', message: 'Session is still live' } },
            409,
          );
        if (url.endsWith('/api/sessions')) return json([endedSession]);
        return json([]);
      }),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete session' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Session is still live',
    );
    // Still open — the message stays with the action that produced it.
    expect(
      screen.getByText('Delete this session and all its check-ins?'),
    ).toBeInTheDocument();
  });
});
