import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RepeatersPage } from './RepeatersPage.js';

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

interface RepeaterRow {
  id: string;
  name: string;
  frequency: number;
  offsetKhz: number;
  mode: string;
  toneHz: number | null;
  coverage: string | null;
  latitude: number | null;
  longitude: number | null;
}

function repRow(over: Partial<RepeaterRow>): RepeaterRow {
  return {
    id: 'r1',
    name: 'R1',
    frequency: 146.76,
    offsetKhz: -600,
    mode: 'FM',
    toneHz: null,
    coverage: null,
    latitude: null,
    longitude: null,
    ...over,
  };
}

function mockFetch(
  user: typeof officer | typeof member,
  reps: RepeaterRow[],
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) return json(user);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/repeaters')) return json(reps);
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <RepeatersPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RepeatersPage empty state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the officer empty-state Card with discovery + add buttons', async () => {
    vi.stubGlobal('fetch', mockFetch(officer, []));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No repeaters yet')).toBeInTheDocument();
    });
    // The Card body has its own buttons (in addition to the top toolbar).
    const discoverButtons = screen.getAllByRole('button', {
      name: /Discover local repeaters/,
    });
    expect(discoverButtons.length).toBeGreaterThanOrEqual(2);
    const addButtons = screen.getAllByRole('button', { name: 'Add repeater' });
    expect(addButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('renders a softer member message when there are no repeaters', async () => {
    vi.stubGlobal('fetch', mockFetch(member, []));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText('No repeaters listed yet'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText('No repeaters yet'),
    ).not.toBeInTheDocument();
  });

  it('replaces the empty state with the list once repeaters arrive', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(officer, [repRow({ id: 'r1', name: 'Repeater Alpha' })]),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Repeater Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('No repeaters yet')).not.toBeInTheDocument();
  });
});
