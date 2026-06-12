import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RequireRole } from '../auth/RequireRole.js';
import { OfficerToolsPage } from './OfficerToolsPage.js';

const officer = {
  id: 'u1',
  callsign: 'W1AW',
  name: 'Op',
  email: 'o@x.co',
  role: 'OFFICER',
};

const member = {
  id: 'u2',
  callsign: 'KA1ABC',
  name: 'Mem',
  email: 'm@x.co',
  role: 'MEMBER',
};

const repeaters = [
  { id: 'r1', name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
];

interface NetRow {
  id: string;
  name: string;
  kind: 'weekly' | 'impromptu';
  scriptCategory: string;
  reminderMinutes?: number[];
  repeaterId: string;
  dayOfWeek: number;
  startLocal: string;
  timezone: string;
  active: boolean;
  repeater: typeof repeaters[number];
  links: unknown[];
  theme: string | null;
  scriptMd: string | null;
}

function netRow(over: Partial<NetRow>): NetRow {
  return {
    id: 'n1',
    name: 'Weekly Net',
    kind: 'weekly',
    scriptCategory: 'general',
    repeaterId: 'r1',
    dayOfWeek: 2,
    startLocal: '20:00',
    timezone: 'UTC',
    active: true,
    reminderMinutes: [240, 30],
    repeater: repeaters[0]!,
    links: [],
    theme: null,
    scriptMd: null,
    ...over,
  };
}

function makeFetch(user: typeof officer | typeof member | null) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) {
      if (!user) {
        return new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return json(user);
    }
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/repeaters')) return json(repeaters);
    if (url.endsWith('/nets')) return json([netRow({ id: 'n1', name: 'Tuesday Net' })]);
    if (url.endsWith('/api/scripts')) {
      return json([
        {
          id: 's1',
          title: 'Opening',
          category: 'weekly',
          body: '# hello',
          createdById: 'u1',
          createdByCallsign: 'W1AW',
          createdByName: 'Op',
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
      ]);
    }
    return json([]);
  });
}

describe('OfficerToolsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the heading and both panels for an officer', async () => {
    vi.stubGlobal('fetch', makeFetch(officer));
    render(
      <MemoryRouter>
        <AuthProvider>
          <OfficerToolsPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Officer tools' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Reminder settings')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Script library')).toBeInTheDocument();
    });
  });

  it('is reachable via the /officer-tools route gated by RequireRole', async () => {
    vi.stubGlobal('fetch', makeFetch(officer));
    render(
      <MemoryRouter initialEntries={['/officer-tools']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/officer-tools"
              element={
                <RequireRole min="OFFICER">
                  <OfficerToolsPage />
                </RequireRole>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Officer tools' }),
      ).toBeInTheDocument();
    });
  });

  it('blocks members with the friendly Not available card', async () => {
    vi.stubGlobal('fetch', makeFetch(member));
    render(
      <MemoryRouter initialEntries={['/officer-tools']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/officer-tools"
              element={
                <RequireRole min="OFFICER">
                  <OfficerToolsPage />
                </RequireRole>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('Not available')).toBeInTheDocument();
    });
    expect(screen.getByText(/officer/)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Officer tools' }),
    ).not.toBeInTheDocument();
  });
});
