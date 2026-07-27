import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('RepeatersPage delete', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Officer view of one repeater, with a scriptable DELETE response. */
  function mockFetchWithDelete(
    deleteResponse: () => Response,
    onRequest?: (url: string, init?: RequestInit) => void,
  ) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      onRequest?.(url, init);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/auth/me')) return json(officer);
      if (url.endsWith('/presence/heartbeat')) return json({});
      if (init?.method === 'DELETE') return deleteResponse();
      if (url.endsWith('/repeaters'))
        return json([repRow({ id: 'r1', name: 'Repeater Alpha' })]);
      return json([]);
    });
  }

  it('confirms in-app and warns that dependent nets block the delete', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    vi.stubGlobal(
      'fetch',
      mockFetchWithDelete(
        () =>
          new Response(null, { status: 204, headers: { 'content-type': 'text/plain' } }),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    // No browser dialog — the app's own modal, naming the repeater.
    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete Repeater Alpha (146.760 MHz)?');
    // The warning has to be in the dialog, before the click — the API refuses
    // to delete a repeater that nets or logs still reference.
    expect(dialog).toHaveTextContent(/can’t\s+be deleted/);
    confirmSpy.mockRestore();
  });

  it('surfaces the server 409 naming the dependents instead of a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchWithDelete(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'CONFLICT',
                message: 'In use by 2 net(s): Tuesday Net, Sunday Swap',
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    // The modal's own confirm button is the second "Delete" control.
    const confirmButton = screen
      .getAllByRole('button', { name: 'Delete' })
      .at(-1)!;
    await userEvent.click(confirmButton);

    const err = await screen.findByTestId('repeater-delete-error');
    expect(err).toHaveTextContent('In use by 2 net(s): Tuesday Net, Sunday Swap');
    // Dialog stays open so the operator can read which nets are in the way.
    expect(screen.getByText(/A repeater that a net/)).toBeInTheDocument();
  });

  it('removes the repeater from the list on a successful delete', async () => {
    let deleted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/auth/me')) return json(officer);
        if (url.endsWith('/presence/heartbeat')) return json({});
        if (init?.method === 'DELETE') {
          deleted = true;
          return json({ ok: true });
        }
        if (url.endsWith('/repeaters'))
          return json(
            deleted ? [] : [repRow({ id: 'r1', name: 'Repeater Alpha' })],
          );
        return json([]);
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete' }).at(-1)!,
    );
    await waitFor(() => {
      expect(screen.getByText('No repeaters yet')).toBeInTheDocument();
    });
  });
});
