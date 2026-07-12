import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { NetsPage } from './NetsPage.js';

const repeaters = [
  { id: 'r1', name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
];

const netRow = {
  id: 'n1',
  name: 'Weekly Net',
  kind: 'weekly',
  scriptCategory: 'general',
  repeaterId: 'r1',
  dayOfWeek: 3,
  startLocal: '20:00',
  timezone: 'UTC',
  theme: null,
  scriptMd: null,
  active: true,
  reminderMinutes: [240, 30],
  repeater: repeaters[0],
  links: [],
};

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
    if (url.endsWith('/nets/active')) return json([]);
    if (url.endsWith('/repeaters')) return json(repeaters);
    if (url.endsWith('/nets')) return json([netRow]);
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <NetsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('NetsPage NET_CONTROL role gating', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets a NET_CONTROL operator open a net but not add or edit nets', async () => {
    vi.stubGlobal('fetch', mockFetch('NET_CONTROL'));
    renderPage();
    // The per-net run-the-net action is available.
    expect(
      await screen.findByRole('button', { name: 'Open net' }),
    ).toBeInTheDocument();
    // ...but the config actions (add / per-net edit / manage repeaters) are not.
    expect(
      screen.queryByRole('button', { name: 'Add net' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Manage repeaters' }),
    ).not.toBeInTheDocument();
  });

  it('gives an OFFICER the open, add, and edit actions', async () => {
    vi.stubGlobal('fetch', mockFetch('OFFICER'));
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'Open net' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add net' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
  });

  it('shows a MEMBER neither the run nor the config actions', async () => {
    vi.stubGlobal('fetch', mockFetch('MEMBER'));
    renderPage();
    await screen.findByText('Weekly Net');
    expect(
      screen.queryByRole('button', { name: 'Open net' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add net' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
  });
});
