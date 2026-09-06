import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UlsMirrorCard } from './UlsMirrorCard.js';

const base = {
  enabled: true, dayOfWeek: 5, hour: 3, running: false, tableRows: 812345,
  lastRun: null as unknown, lastSuccess: null as unknown,
};

function stub(status: Record<string, unknown>, onPost?: () => void) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.includes('/admin/uls/import')) {
      onPost?.();
      return json({ started: true }, 202);
    }
    if (url.includes('/admin/uls')) return json(status);
    return json({});
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('UlsMirrorCard', () => {
  it('shows how many callsigns are on file', async () => {
    vi.stubGlobal('fetch', stub({ ...base }));
    render(<UlsMirrorCard />);
    expect(await screen.findByTestId('uls-rows')).toHaveTextContent('812,345');
  });

  it('starts an import when the button is pressed', async () => {
    let posted = false;
    vi.stubGlobal('fetch', stub({ ...base }, () => { posted = true; }));
    render(<UlsMirrorCard />);
    await userEvent.click(await screen.findByRole('button', { name: /load names from fcc uls/i }));
    await waitFor(() => expect(posted).toBe(true));
  });

  it('reports a failed run instead of leaving the club guessing', async () => {
    vi.stubGlobal('fetch', stub({
      ...base,
      lastRun: {
        outcome: 'failed', trigger: 'scheduled', startedAt: '2026-09-04T03:00:00.000Z',
        finishedAt: null, sourceFileDate: null, callsigns: null,
        error: 'connection reset',
      },
    }));
    render(<UlsMirrorCard />);
    expect(await screen.findByTestId('uls-last-error')).toHaveTextContent('connection reset');
  });

  it('disables the button while a run is in flight', async () => {
    vi.stubGlobal('fetch', stub({ ...base, running: true }));
    render(<UlsMirrorCard />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /loading from fcc/i })).toBeDisabled(),
    );
    expect(screen.getByTestId('uls-running')).toBeInTheDocument();
  });

  it('explains itself when the server has the import switched off', async () => {
    vi.stubGlobal('fetch', stub({ ...base, enabled: false }));
    render(<UlsMirrorCard />);
    expect(await screen.findByTestId('uls-disabled')).toHaveTextContent(/155 MB/);
    expect(screen.getByRole('button', { name: /load names from fcc uls/i })).toBeDisabled();
  });

  it('stays blank instead of taking the Admin page down on an odd payload', async () => {
    // The whole Admin page renders this card; a malformed answer from one
    // endpoint must not white-screen the others.
    vi.stubGlobal('fetch', stub({} as Record<string, unknown>));
    render(<UlsMirrorCard />);
    expect(await screen.findByTestId('uls-rows')).toHaveTextContent('0');
  });
});
