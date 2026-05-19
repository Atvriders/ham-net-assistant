import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { StatsPage } from './StatsPage.js';

const session = {
  id: 's1',
  netId: 'n1',
  netName: 'W0QQQ All-Safe Check-In',
  startedAt: new Date('2026-05-01T20:00:00.000Z').toISOString(),
  endedAt: new Date('2026-05-01T20:45:00.000Z').toISOString(),
  topic: 'Antennas 101',
  notes: null as string | null,
  controlOpId: 'u1',
  controlOp: { callsign: 'W1AW', name: 'Op' },
  checkIns: [
    { id: 'c1', callsign: 'W1AW', name: 'Op', checkedInAt: new Date().toISOString() },
    { id: 'c2', callsign: 'AB0ZW', name: 'James Klassen', checkedInAt: new Date().toISOString() },
  ],
};

const stats = {
  range: { from: new Date('2026-01-01').toISOString(), to: new Date('2026-06-01').toISOString() },
  totalSessions: 1,
  totalCheckIns: 2,
  perMember: [],
  perNet: [],
  sessions: [session],
};

function mockFetch(role: string, onPatch: (url: string, body: unknown) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.includes('/stats/participation')) return json(stats);
    if (url.endsWith('/users/control-candidates'))
      return json([
        { id: 'u1', callsign: 'W1AW', name: 'Op', role: 'OFFICER' },
        { id: 'u2', callsign: 'KC0GST', name: 'Guest Op', role: 'MEMBER' },
      ]);
    if (init?.method === 'PATCH') {
      onPatch(url, JSON.parse(String(init.body)));
      return json({});
    }
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <StatsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('StatsPage session editing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an Edit button on each session for admins', async () => {
    vi.stubGlobal('fetch', mockFetch('ADMIN', () => {}));
    renderPage();
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('hides the Edit button for non-admins', async () => {
    vi.stubGlobal('fetch', mockFetch('OFFICER', () => {}));
    renderPage();
    await screen.findByText('Sessions');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('opens the edit modal pre-filled and PATCHes the session', async () => {
    const patches: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch('ADMIN', (url, body) => patches.push({ url, body })),
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => {
      expect(screen.getByText('Edit session')).toBeInTheDocument();
    });
    const topicBox = screen.getByDisplayValue('Antennas 101');
    await userEvent.clear(topicBox);
    await userEvent.type(topicBox, 'Severe Weather Net');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches.some((p) => p.url.includes('/sessions/s1'))).toBe(true);
    });
    const sessionPatch = patches.find((p) => p.url.includes('/sessions/s1'))!;
    expect((sessionPatch.body as { topicTitle: string }).topicTitle).toBe(
      'Severe Weather Net',
    );
  });
});
