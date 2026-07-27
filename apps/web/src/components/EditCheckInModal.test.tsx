import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CheckIn } from '@hna/shared';
import { EditCheckInModal } from './EditCheckInModal.js';

function makeCheckIn(mode: 'rf' | 'echolink'): CheckIn {
  return {
    id: 'c1',
    sessionId: 's1',
    userId: null,
    callsign: 'KE0RF1',
    nameAtCheckIn: 'OnAir',
    checkedInAt: new Date().toISOString(),
    comment: null,
    mode,
    createdById: 'u1',
  };
}

describe('EditCheckInModal mode round-trip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pre-selects the current mode from the check-in row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    render(
      <EditCheckInModal
        open
        checkIn={makeCheckIn('echolink')}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const select = await screen.findByTestId('edit-checkin-mode');
    expect((select as HTMLSelectElement).value).toBe('echolink');
  });

  it('PATCHes the selected mode back to the API on save', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const onSaved = vi.fn();
    render(
      <EditCheckInModal
        open
        checkIn={makeCheckIn('rf')}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    const select = await screen.findByTestId('edit-checkin-mode');
    await userEvent.selectOptions(select, 'echolink');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url.endsWith('/api/checkins/c1'),
      );
      expect(patch).toBeDefined();
      expect((patch!.body as { mode?: string }).mode).toBe('echolink');
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('announces a rejected callsign in an alert region', async () => {
    // Previously this message was a plain red <div>: screen-reader users got
    // no signal at all that Save had refused, and colour was the only visual
    // cue that the line was an error.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    render(
      <EditCheckInModal
        open
        checkIn={makeCheckIn('rf')}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const callsign = screen.getByLabelText('Callsign');
    await userEvent.clear(callsign);
    await userEvent.type(callsign, 'A');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid callsign');
    expect(alert).toHaveClass('hna-form-error');
  });

  it('keeps initial focus on the autoFocus callsign field', async () => {
    // The dialog's focus trap used to steal focus back to the [ESC] chip.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    render(
      <EditCheckInModal
        open
        checkIn={makeCheckIn('rf')}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Callsign')).toHaveFocus();
    });
  });
});
