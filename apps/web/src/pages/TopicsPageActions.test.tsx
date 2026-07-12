import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { TopicsPage } from './TopicsPage.js';

const officer = {
  id: 'u1',
  callsign: 'W1AW',
  name: 'Op',
  email: 'o@x.co',
  role: 'OFFICER',
};

const openTopic = {
  id: 't1',
  title: 'Antenna tuning',
  details: null,
  status: 'OPEN' as const,
  createdById: 'u9',
  createdByCallsign: 'K1ABC',
  createdByName: 'Al',
  createdAt: '2026-05-01T00:00:00.000Z',
};

/** GET /topics succeeds; PATCH /topics/:id/status fails once with a 400. */
function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) return json(officer);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (/\/topics\/[^/]+\/status$/.test(url) && method === 'PATCH')
      return json({ error: { code: 'VALIDATION', message: 'Cannot mark used' } }, 400);
    if (url.endsWith('/topics')) return json([openTopic]);
    return json([]);
  });
}

describe('TopicsPage per-topic action errors (systemic guard)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the error instead of swallowing it when a status change fails', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(
      <MemoryRouter>
        <AuthProvider>
          <TopicsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const markUsed = await screen.findByRole('button', { name: 'Mark used' });
    await userEvent.click(markUsed);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot mark used');
    });
    // The chip stays OPEN (the change didn't apply) and the button re-enables.
    expect(screen.getByRole('button', { name: 'Mark used' })).not.toBeDisabled();
  });
});
