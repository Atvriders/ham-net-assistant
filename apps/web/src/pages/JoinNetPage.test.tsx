import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { JoinNetPage } from './JoinNetPage.js';

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
  scriptMd: null,
  scriptCategory: 'weekly',
  active: true,
  repeater,
  links: [],
};

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

function mockFetch(opts: { live: boolean }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u2',
        callsign: 'KA1ABC',
        name: 'Mem',
        email: 'm@x.co',
        role: 'MEMBER',
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/nets/n1/active-session'))
      return json(makeSession({ live: opts.live }));
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/nets/n1/join']}>
      <AuthProvider>
        <Routes>
          <Route path="/nets/:netId/join" element={<JoinNetPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('JoinNetPage prep state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the PREPARING card and hides the check-in button when liveAt is null', async () => {
    vi.stubGlobal('fetch', mockFetch({ live: false }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('join-preparing-card')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument();
    expect(screen.getByTestId('join-prep-chip')).toBeInTheDocument();
  });

  it('shows the check-in button (live UI) when liveAt is set', async () => {
    vi.stubGlobal('fetch', mockFetch({ live: true }));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Check in' }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('join-preparing-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('join-prep-chip')).not.toBeInTheDocument();
  });
});
