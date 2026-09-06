/**
 * Reorder mode in the check-in log — for a station heard early but logged
 * late. The contract asserted here is what the operator sees and what the
 * server is told: the FULL oldest-first id list, so a retry or a second
 * operator cannot interleave into an order nobody chose.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RunNetPage } from './RunNetPage.js';

const repeater = { id: 'r1', name: 'W0QQQ', frequency: 145.41, offsetKhz: -600, toneHz: 100, mode: 'FM' };
const net = {
  id: 'n1', name: 'Tuesday Net', kind: 'weekly', repeaterId: 'r1', dayOfWeek: 2,
  startLocal: '20:00', timezone: 'UTC', theme: null, scriptMd: 'Welcome.',
  scriptCategory: 'weekly', active: true, repeater, links: [],
};

/** API returns check-ins NEWEST-first; the log displays them oldest-first. */
function checkIns() {
  const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 20, min)).toISOString();
  return [
    { id: 'c3', callsign: 'N0QRP', nameAtCheckIn: 'Carol', checkedInAt: t(10), comment: null, mode: 'rf', createdById: 'u1' },
    { id: 'c2', callsign: 'W0XYZ', nameAtCheckIn: 'Bob', checkedInAt: t(5), comment: null, mode: 'rf', createdById: 'u1' },
    { id: 'c1', callsign: 'K0ABC', nameAtCheckIn: 'Alice', checkedInAt: t(1), comment: null, mode: 'rf', createdById: 'u1' },
  ];
}

function makeFetch(role = 'OFFICER') {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/me'))
      return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role });
    if (url.includes('/recent-checkins')) return json([]);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.includes('/presence')) return json([]);
    if (url.includes('/users/directory')) return json([]);
    if (url.includes('/topics/recommended')) return json([]);
    if (url.includes('/api/repeaters')) return json([repeater]);
    if (url.includes('/messages')) return json([]);
    if (url.includes('/api/sessions/s1')) {
      const startedAt = new Date(Date.UTC(2026, 0, 1, 20, 0)).toISOString();
      return json({
        id: 's1', netId: 'n1', startedAt, liveAt: startedAt, endedAt: null,
        controlOpId: 'u1', topicTitle: null, topic: null, autoOpened: false,
        checkIns: checkIns(), net,
      });
    }
    return json({});
  });
  return { fn, calls };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/run/s1']}>
      <AuthProvider>
        <Routes><Route path="/run/:sessionId" element={<RunNetPage />} /></Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('check-in reordering', () => {
  it('is off by default and shows no move controls', async () => {
    const { fn } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('reorder-toggle')).toHaveTextContent('REORDER');
    expect(screen.queryByTestId('move-up-N0QRP')).toBeNull();
  });

  it('sends the whole oldest-first order when a station moves up', async () => {
    const { fn, calls } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();

    await userEvent.click(await screen.findByTestId('reorder-toggle'));
    // Displayed oldest-first: K0ABC(#01), W0XYZ(#02), N0QRP(#03).
    // N0QRP was actually heard first — move it to the top.
    await userEvent.click(await screen.findByTestId('move-up-N0QRP'));

    await waitFor(() => {
      const patch = calls.find((c) => c.url.includes('/checkins/order'));
      expect(patch).toBeDefined();
      expect(patch!.method).toBe('PATCH');
      // Full list, oldest-first, with N0QRP moved one place earlier.
      expect(patch!.body).toEqual({ orderedIds: ['c1', 'c3', 'c2'] });
    });
  });

  it('cannot move the first row up or the last row down', async () => {
    const { fn } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    await userEvent.click(await screen.findByTestId('reorder-toggle'));
    expect(await screen.findByTestId('move-up-K0ABC')).toBeDisabled();
    expect(screen.getByTestId('move-down-N0QRP')).toBeDisabled();
  });

  it('tells the operator the timestamps are not being rewritten', async () => {
    const { fn } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    await userEvent.click(await screen.findByTestId('reorder-toggle'));
    expect(await screen.findByTestId('reorder-hint')).toHaveTextContent(
      /times are kept as recorded/i,
    );
  });

  it('is not offered to a plain member', async () => {
    const { fn } = makeFetch('MEMBER');
    vi.stubGlobal('fetch', fn);
    renderPage();
    await screen.findByText(/ROSTER/);
    expect(screen.queryByTestId('reorder-toggle')).toBeNull();
  });
});
