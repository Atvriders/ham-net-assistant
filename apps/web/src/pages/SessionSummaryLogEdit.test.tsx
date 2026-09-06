/**
 * Editing a FINISHED log: add a station that was heard but missed, and put the
 * log back into the order it was heard.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { SessionSummaryPage } from './SessionSummaryPage.js';

const repeater = { id: 'r1', name: 'W0QQQ', frequency: 145.41, offsetKhz: -600, toneHz: null, mode: 'FM' };
const net = { id: 'n1', name: 'Tuesday Net', repeaterId: 'r1', dayOfWeek: 2, startLocal: '20:00', timezone: 'UTC' };

function summary() {
  const t = (m: number) => new Date(Date.UTC(2026, 0, 6, 20, m)).toISOString();
  return {
    session: {
      id: 's1', netId: 'n1', startedAt: t(0), liveAt: t(0), endedAt: t(60),
      controlOpId: null, notes: null, topicTitle: null, topic: null,
    },
    net, repeater,
    checkIns: [
      { id: 'c1', sessionId: 's1', userId: null, callsign: 'K0ABC', nameAtCheckIn: 'Alice', checkedInAt: t(1), comment: null, mode: 'rf', sequence: 1 },
      { id: 'c2', sessionId: 's1', userId: null, callsign: 'W0XYZ', nameAtCheckIn: 'Bob', checkedInAt: t(5), comment: null, mode: 'rf', sequence: 2 },
      { id: 'c3', sessionId: 's1', userId: null, callsign: 'N0QRP', nameAtCheckIn: 'Carol', checkedInAt: t(10), comment: null, mode: 'rf', sequence: 3 },
    ],
  };
}

function makeFetch(role = 'OFFICER') {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/me')) return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role });
    if (url.includes('/presence')) return json([]);
    if (url.includes('/summary')) return json(summary());
    return json({});
  });
  return { fn, calls };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/sessions/s1/summary']}>
      <AuthProvider>
        <Routes><Route path="/sessions/:sessionId/summary" element={<SessionSummaryPage />} /></Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('editing a finished log', () => {
  it('is off by default — the page reads as a record, not a form', async () => {
    const { fn } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('edit-log-toggle')).toHaveTextContent('Edit log');
    expect(screen.queryByTestId('add-checkin-button')).toBeNull();
    expect(screen.queryByTestId('summary-move-up-N0QRP')).toBeNull();
  });

  it('offers adding a missed station and says times are preserved', async () => {
    const { fn } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    await userEvent.click(await screen.findByTestId('edit-log-toggle'));
    expect(screen.getByTestId('add-checkin-button')).toBeInTheDocument();
    expect(screen.getByTestId('edit-log-hint')).toHaveTextContent(/times stay as recorded/i);
  });

  it('sends the full order when a station is moved', async () => {
    const { fn, calls } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    await userEvent.click(await screen.findByTestId('edit-log-toggle'));
    // N0QRP is last but was heard first — move it up one.
    await userEvent.click(await screen.findByTestId('summary-move-up-N0QRP'));
    await waitFor(() => {
      const patch = calls.find((c) => c.url.includes('/checkins/order'));
      expect(patch).toBeDefined();
      expect(patch!.body).toEqual({ orderedIds: ['c1', 'c3', 'c2'] });
    });
  });

  it('posts a missed station to the finished session', async () => {
    const { fn, calls } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();
    await userEvent.click(await screen.findByTestId('edit-log-toggle'));
    await userEvent.click(screen.getByTestId('add-checkin-button'));

    await userEvent.type(await screen.findByLabelText('Callsign'), 'KD0MISS');
    await userEvent.type(screen.getByLabelText('Name'), 'Missed Station');
    await userEvent.click(screen.getByRole('button', { name: /add to log/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/checkins'));
      expect(post).toBeDefined();
      expect(post!.body).toMatchObject({ callsign: 'KD0MISS', nameAtCheckIn: 'Missed Station' });
    });
  });

  it('is not offered to a plain member', async () => {
    const { fn } = makeFetch('MEMBER');
    vi.stubGlobal('fetch', fn);
    renderPage();
    // Wait for the log itself: callsigns render with a slashed zero, so key
    // off a name instead.
    await screen.findByText('Alice');
    expect(screen.queryByTestId('edit-log-toggle')).toBeNull();
  });
});
