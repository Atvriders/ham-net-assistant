/**
 * Editing a past net's log from the Stats page.
 *
 * Same contract as the summary page — the shared useLogEditing hook — so these
 * tests are about the Stats-specific part: one session's log opens at a time,
 * and the controls are officer-only on a page members can read.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { StatsPage } from './StatsPage.js';

function stats() {
  const t = (m: number) => new Date(Date.UTC(2026, 0, 6, 20, m)).toISOString();
  return {
    range: { from: t(0), to: t(60) },
    totalSessions: 1,
    totalCheckIns: 3,
    perMember: [],
    perNet: [],
    sessions: [
      {
        id: 's1', netId: 'n1', netName: 'Tuesday Net', startedAt: t(0), endedAt: t(60),
        topic: null, notes: null, controlOpId: null, controlOp: null,
        checkIns: [
          { id: 'c1', callsign: 'K0ABC', name: 'Alice', checkedInAt: t(1), mode: 'rf' },
          { id: 'c2', callsign: 'W0XYZ', name: 'Bob', checkedInAt: t(5), mode: 'rf' },
          { id: 'c3', callsign: 'N0QRP', name: 'Carol', checkedInAt: t(10), mode: 'rf' },
        ],
      },
    ],
  };
}

function makeFetch(role = 'OFFICER') {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/me')) return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role });
    if (url.includes('/presence')) return json([]);
    if (url.includes('/stats/participation')) return json(stats());
    return json({});
  });
  return { fn, calls };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider><StatsPage /></AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Stats page: editing a past net log', () => {
  it('reorders a past net and sends the full order', async () => {
    const { fn, calls } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();

    await userEvent.click(await screen.findByTestId('stats-edit-log-s1'));
    // N0QRP is logged last but was heard first — move it up.
    await userEvent.click(await screen.findByTestId('stats-move-up-N0QRP'));

    await waitFor(() => {
      const patch = calls.find((c) => c.url.includes('/checkins/order'));
      expect(patch).toBeDefined();
      expect(patch!.url).toContain('/sessions/s1/');
      expect(patch!.body).toEqual({ orderedIds: ['c1', 'c3', 'c2'] });
    });
  });

  it('adds a missed station to that past net', async () => {
    const { fn, calls } = makeFetch();
    vi.stubGlobal('fetch', fn);
    renderPage();

    await userEvent.click(await screen.findByTestId('stats-edit-log-s1'));
    await userEvent.click(screen.getByTestId('stats-add-checkin-s1'));
    await userEvent.type(await screen.findByLabelText('Callsign'), 'KD0MISS');
    await userEvent.type(screen.getByLabelText('Name'), 'Missed Station');
    await userEvent.click(screen.getByRole('button', { name: /add to log/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/checkins'));
      expect(post).toBeDefined();
      expect(post!.url).toContain('/sessions/s1/checkins');
      expect(post!.body).toMatchObject({ callsign: 'KD0MISS' });
    });
  });

  it('shows no editing controls to a member', async () => {
    const { fn } = makeFetch('MEMBER');
    vi.stubGlobal('fetch', fn);
    renderPage();
    await screen.findByText('Tuesday Net');
    expect(screen.queryByTestId('stats-edit-log-s1')).toBeNull();
  });
});
