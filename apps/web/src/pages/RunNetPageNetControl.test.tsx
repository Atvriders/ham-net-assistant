import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// One check-in owned by someone else so the pencil/× edit affordance is only
// enabled for a user with run-the-net authority (not a plain member).
const checkIn = {
  id: 'c1',
  sessionId: 's1',
  callsign: 'K1ABC',
  nameAtCheckIn: 'Alice',
  checkedInAt: new Date().toISOString(),
  mode: 'rf',
  comment: null,
  createdById: 'other-op',
};

// A LIVE session whose control operator is NOT the signed-in user, so the
// "Take control" button is eligible to render for run-the-net roles.
function liveSession() {
  const now = new Date().toISOString();
  return {
    id: 's1',
    netId: 'n1',
    startedAt: now,
    liveAt: now,
    endedAt: null,
    controlOpId: 'other-op',
    topicTitle: null,
    topic: null,
    autoOpened: false,
    checkIns: [checkIn],
    net,
  };
}

function mockFetch(role: string) {
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
        role,
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    if (url.endsWith('/api/sessions/s1')) return json(liveSession());
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/run/s1']}>
      <AuthProvider>
        <Routes>
          <Route path="/run/:sessionId" element={<RunNetPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RunNetPage NET_CONTROL role gating', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives a NET_CONTROL operator the run-the-net controls but not Edit net', async () => {
    vi.stubGlobal('fetch', mockFetch('NET_CONTROL'));
    renderPage();

    // Run-the-net authority: take/change/end control + the live topic editor.
    expect(
      await screen.findByRole('button', { name: 'Take control' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Change control' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'End net' }),
    ).toBeInTheDocument();
    // The live topic editor toggle is a run-the-net affordance.
    expect(screen.getByTestId('topic-live-edit-toggle')).toBeInTheDocument();
    // The check-in edit/delete affordance is enabled (labelled for editing).
    expect(screen.getByLabelText('Edit check-in')).toBeInTheDocument();

    // ...but NO club-config access: the "Edit net" button must not appear.
    expect(
      screen.queryByRole('button', { name: 'Edit net' }),
    ).not.toBeInTheDocument();
  });

  it('still shows Edit net to an OFFICER', async () => {
    vi.stubGlobal('fetch', mockFetch('OFFICER'));
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'Edit net' }),
    ).toBeInTheDocument();
    // And the run-the-net controls remain available too.
    expect(
      screen.getByRole('button', { name: 'Take control' }),
    ).toBeInTheDocument();
  });

  it('shows a MEMBER none of the run-the-net controls', async () => {
    vi.stubGlobal('fetch', mockFetch('MEMBER'));
    renderPage();
    // Wait for the console to render (script panel present for everyone).
    await screen.findByText('Script');
    expect(
      screen.queryByRole('button', { name: 'Take control' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change control' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'End net' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('topic-live-edit-toggle')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit net' }),
    ).not.toBeInTheDocument();
    // The pencil renders but is disabled for a member who doesn't own the row,
    // so it carries the "editable for 5 minutes" label, not "Edit check-in".
    expect(screen.queryByLabelText('Edit check-in')).not.toBeInTheDocument();
  });
});
