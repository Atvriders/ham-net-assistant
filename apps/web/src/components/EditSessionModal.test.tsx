import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
