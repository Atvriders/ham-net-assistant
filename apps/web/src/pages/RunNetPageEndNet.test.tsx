import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

function liveSession() {
  const now = new Date().toISOString();
  return {
    id: 's1',
    netId: 'n1',
    startedAt: now,
    liveAt: now,
    endedAt: null,
    controlOpId: 'u1',
    topicTitle: null,
    topic: null,
    autoOpened: false,
    checkIns: [],
    net,
  };
}

/**
 * Fetch driver whose PATCH /api/sessions/s1 behaviour is programmable:
 *   - `patchBehavior()` decides how the next end PATCH resolves.
 * Every non-GET call is captured for assertions.
 */
function makeMockFetch(patchBehavior: () => 'fail' | 'ok' | 'hang', deferred?: { promise: Promise<Response> }) {
  const calls: { url: string; method: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ url, method });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role: 'OFFICER' });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    if (url.endsWith('/api/sessions/s1') && method === 'PATCH') {
      const behavior = patchBehavior();
      if (behavior === 'hang') return deferred!.promise;
      if (behavior === 'fail')
        return json({ error: { code: 'INTERNAL', message: 'Server exploded' } }, 500);
      return json({ ...liveSession(), endedAt: new Date().toISOString() });
    }
    if (url.endsWith('/api/sessions/s1')) return json(liveSession());
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
          <Route
            path="/sessions/:sessionId/summary"
            element={<div data-testid="summary-page">SUMMARY</div>}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Open the end-of-net review modal from the status strip. */
async function openReviewModal() {
  const stripEnd = await screen.findByRole('button', { name: 'End net' });
  await userEvent.click(stripEnd);
  return within(await screen.findByRole('dialog'));
}

describe('RunNetPage end-net flow (3-click bug)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the error and keeps the modal open when the end PATCH fails, then navigates to the summary on retry', async () => {
    // First end PATCH fails, the retry succeeds.
    let attempts = 0;
    const { fn } = makeMockFetch(() => (++attempts === 1 ? 'fail' : 'ok'));
    vi.stubGlobal('fetch', fn);
    renderPage();

    const modal = await openReviewModal();

    // First attempt: PATCH rejects → the operator must SEE the failure and the
    // modal must stay open (no silent no-op that invites a re-click).
    await userEvent.click(modal.getByRole('button', { name: 'End net' }));
    expect(await modal.findByRole('alert')).toHaveTextContent('Server exploded');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-page')).not.toBeInTheDocument();

    // Retry: PATCH succeeds → navigate to the session summary.
    await userEvent.click(modal.getByRole('button', { name: 'End net' }));
    expect(await screen.findByTestId('summary-page')).toBeInTheDocument();
  });

  it('disables the End net button and shows "Ending…" while the PATCH is in flight, firing exactly one PATCH per click', async () => {
    let resolve!: (r: Response) => void;
    const deferred = {
      promise: new Promise<Response>((r) => {
        resolve = r;
      }),
    };
    const { fn, calls } = makeMockFetch(() => 'hang', deferred);
    vi.stubGlobal('fetch', fn);
    renderPage();

    const modal = await openReviewModal();
    const endBtn = modal.getByRole('button', { name: 'End net' });
    await userEvent.click(endBtn);

    // In-flight: the danger button is disabled and relabelled.
    await waitFor(() => {
      expect(modal.getByRole('button', { name: 'Ending…' })).toBeDisabled();
    });

    // A second click while pending must not fire a second PATCH (no double-end,
    // no duplicate "net ended" Discord post).
    await userEvent.click(modal.getByRole('button', { name: 'Ending…' }));
    const endPatches = calls.filter(
      (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
    );
    expect(endPatches).toHaveLength(1);

    // Let the hung request settle so the test tears down cleanly.
    resolve(
      new Response(
        JSON.stringify({ ...liveSession(), endedAt: new Date().toISOString() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('summary-page')).toBeInTheDocument();
    });
  });
});
