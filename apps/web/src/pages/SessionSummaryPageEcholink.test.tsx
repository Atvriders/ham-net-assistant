import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { SessionSummaryPage } from './SessionSummaryPage.js';

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
  links: [],
};

const session = {
  id: 's1',
  netId: 'n1',
  startedAt: new Date().toISOString(),
  liveAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  controlOpId: 'u1',
  topicTitle: null,
};

const checkIns = [
  {
    id: 'c1',
    sessionId: 's1',
    userId: null,
    callsign: 'KE0RF1',
    nameAtCheckIn: 'OnAir',
    checkedInAt: new Date(Date.now() - 5_000).toISOString(),
    comment: null,
    mode: 'rf',
    createdById: 'u1',
  },
  {
    id: 'c2',
    sessionId: 's1',
    userId: null,
    callsign: 'KE0VOIP',
    nameAtCheckIn: 'Remote',
    checkedInAt: new Date().toISOString(),
    comment: null,
    mode: 'echolink',
    createdById: 'u1',
  },
];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role: 'OFFICER',
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/sessions/s1/summary')) {
      return json({
        session,
        net,
        repeater,
        checkIns,
        stats: { count: checkIns.length },
      });
    }
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/sessions/s1/summary']}>
      <AuthProvider>
        <Routes>
          <Route
            path="/sessions/:sessionId/summary"
            element={<SessionSummaryPage />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('SessionSummaryPage EchoLink chip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders exactly one ECHOLINK chip — only on the echolink row, not the RF row', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('echolink-chip').length).toBe(1);
    });
    // The chip lives in the row with the EchoLink callsign. displayCallsign
    // substitutes a slashed-zero glyph (Ø) for the digit 0, so match on the
    // surrounding visitor name to identify the right row instead.
    const chip = screen.getByTestId('echolink-chip');
    const row = chip.closest('tr');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Remote');
  });
});
