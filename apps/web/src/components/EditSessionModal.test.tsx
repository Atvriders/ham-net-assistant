import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditSessionModal } from './EditSessionModal.js';

const session = {
  id: 's1',
  netId: 'n1',
  netName: 'Tuesday Net',
  startedAt: '2026-05-21T01:00:00.000Z',
  endedAt: null,
  topic: null,
  notes: null,
  controlOpId: null,
  controlOp: null,
  checkIns: [
    {
      id: 'c1',
      callsign: 'W1AW',
      name: 'Op',
      checkedInAt: '2026-05-21T01:05:00.000Z',
      mode: 'rf',
    },
  ],
} as never;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

describe('EditSessionModal validation feedback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces a rejected check-in edit in an alert region', async () => {
    // The message appears far below the Save button on a long session form, so
    // it has to be announced rather than merely turn red.
    stubFetch();
    render(
      <EditSessionModal
        open
        session={session}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const callsign = await screen.findByPlaceholderText('W1AW');
    await userEvent.clear(callsign);
    await userEvent.type(callsign, 'A');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid callsign "A"');
    // Bordered/tinted treatment, so the failure is not carried by colour alone.
    expect(alert).toHaveClass('hna-form-error');
  });
});

/**
 * Adding and reordering check-ins from the Edit session dialog.
 *
 * This dialog is where an officer already REMOVES check-ins, so it is where
 * they look to add and reorder them — the reason those controls moved here.
 * Everything is staged and written on Save, so the assertions are about what
 * reaches the server and in what order: creations before the order PATCH, so
 * every id in that list is real.
 */
describe('EditSessionModal: adding and reordering check-ins', () => {
  const editSession = {
    id: 's1',
    netName: 'Tuesday Net',
    startedAt: '2026-01-06T20:00:00.000Z',
    topic: 'Antennas',
    notes: null,
    controlOpId: null,
    checkIns: [
      { id: 'c1', callsign: 'K0ABC', name: 'Alice', checkedInAt: '2026-01-06T20:01:00.000Z', mode: 'rf' },
      { id: 'c2', callsign: 'W0XYZ', name: 'Bob', checkedInAt: '2026-01-06T20:05:00.000Z', mode: 'rf' },
    ],
  };

  function stub() {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      }
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/control-candidates')) return json([]);
      if (url.includes('/checkins') && method === 'POST') return json({ id: 'c-new' });
      return json({});
    });
    return { fn, calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('does not reorder anything until Save', async () => {
    const { fn, calls } = stub();
    vi.stubGlobal('fetch', fn);
    render(
      <EditSessionModal open session={editSession as never} onClose={() => {}} onSaved={() => {}} />,
    );
    await userEvent.click(await screen.findByTestId('session-move-down-0'));
    // Staged only — Cancel must leave the log untouched.
    expect(calls.find((c) => c.url.includes('/checkins/order'))).toBeUndefined();
  });

  it('creates a new station before sending the order, so every id is real', async () => {
    const { fn, calls } = stub();
    vi.stubGlobal('fetch', fn);
    render(
      <EditSessionModal open session={editSession as never} onClose={() => {}} onSaved={() => {}} />,
    );
    await userEvent.click(await screen.findByTestId('session-add-checkin'));

    // The new row is appended, so it is check-in 3.
    await userEvent.type(screen.getByLabelText('Callsign, check-in 3'), 'KD0MISS');
    await userEvent.type(screen.getByLabelText('Name, check-in 3'), 'Missed Station');
    // Put the new station where it was actually heard: first.
    await userEvent.click(screen.getByTestId('session-move-up-2'));
    await userEvent.click(screen.getByTestId('session-move-up-1'));

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/checkins'));
      const order = calls.find((c) => c.url.includes('/checkins/order'));
      expect(post).toBeDefined();
      expect(order).toBeDefined();
      // Creation must come first — the order list carries the real id.
      expect(calls.indexOf(post!)).toBeLessThan(calls.indexOf(order!));
      expect(order!.body).toEqual({ orderedIds: ['c-new', 'c1', 'c2'] });
    });
  });

  it('never deletes a row that was added and removed in the same sitting', async () => {
    const { fn, calls } = stub();
    vi.stubGlobal('fetch', fn);
    render(
      <EditSessionModal open session={editSession as never} onClose={() => {}} onSaved={() => {}} />,
    );
    await userEvent.click(await screen.findByTestId('session-add-checkin'));
    const removes = screen.getAllByRole('button', { name: /remove/i });
    await userEvent.click(removes[removes.length - 1]!);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      // It never existed server-side; a DELETE would 404.
      expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
    });
  });
});
