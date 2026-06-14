import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function makeSession(checkIns: Array<Record<string, unknown>>) {
  const startedAt = new Date().toISOString();
  return {
    id: 's1',
    netId: 'n1',
    startedAt,
    liveAt: startedAt,
    endedAt: null,
    controlOpId: 'u1',
    checkIns,
    net,
  };
}

function makeMockFetch(initialCheckIns: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const checkIns = [...initialCheckIns];
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
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
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
      return json(makeSession(checkIns));
    if (url.endsWith('/api/sessions/s1/checkins') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        callsign: string;
        nameAtCheckIn: string;
        mode?: 'rf' | 'echolink';
      };
      checkIns.push({
        id: `c${checkIns.length + 1}`,
        sessionId: 's1',
        userId: 'u2',
        callsign: body.callsign,
        nameAtCheckIn: body.nameAtCheckIn,
        checkedInAt: new Date().toISOString(),
        comment: null,
        mode: body.mode ?? 'rf',
        createdById: 'u2',
      });
      return json(checkIns[checkIns.length - 1], 201);
    }
    return json([]);
  });
  return { fn, calls };
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

describe('JoinNetPage EchoLink mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the mode toggle defaulting to RF on the live check-in form', async () => {
    const { fn } = makeMockFetch([]);
    vi.stubGlobal('fetch', fn);
    renderPage();
    const rfBtn = await screen.findByTestId('join-mode-rf');
    const ecBtn = await screen.findByTestId('join-mode-echolink');
    expect(rfBtn).toHaveAttribute('aria-pressed', 'true');
    expect(ecBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it("sends mode 'echolink' on POST when the toggle is switched to ECHOLINK", async () => {
    const { fn, calls } = makeMockFetch([]);
    vi.stubGlobal('fetch', fn);
    renderPage();
    await userEvent.click(await screen.findByTestId('join-mode-echolink'));
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/sessions/s1/checkins'),
      );
      expect(post).toBeDefined();
      expect((post!.body as { mode?: string }).mode).toBe('echolink');
    });
  });

  it('renders an ECHOLINK chip in the roster for echolink check-ins', async () => {
    const { fn } = makeMockFetch([
      {
        id: 'c1',
        sessionId: 's1',
        userId: null,
        callsign: 'KE0VOIP',
        nameAtCheckIn: 'Remote',
        checkedInAt: new Date().toISOString(),
        comment: null,
        mode: 'echolink',
        createdById: 'u9',
      },
    ]);
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('echolink-chip').length).toBeGreaterThanOrEqual(1);
    });
  });
});
