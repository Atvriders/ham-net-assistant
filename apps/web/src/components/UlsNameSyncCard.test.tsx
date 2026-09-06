/**
 * The destructive-action guard rails, from the operator's side.
 *
 * This card rewrites a club's whole log, so the tests that matter are the ones
 * about NOT doing that by accident: nothing is written before a preview, the
 * confirmation phrase is required, and an unloaded ULS mirror is refused with
 * an instruction rather than a shrug.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UlsNameSyncCard } from './UlsNameSyncCard.js';

const preview = {
  ulsRows: 824000,
  checkIns: {
    scanned: 120, changing: 2, unchanged: 100, noUlsName: 18,
    samples: [
      { callsign: 'KF0WBD', from: 'Bret', to: 'Bret N Flanders', rows: 4 },
      { callsign: 'W0XYZ', from: '', to: 'Robert Sample', rows: 1 },
    ],
  },
  users: { scanned: 0, changing: 0, unchanged: 0, noUlsName: 0, samples: [] },
};

function stub(previewBody: unknown = preview) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/name-sync/preview')) return json(previewBody);
    if (url.includes('/name-sync')) {
      return json({
        snapshot: '/data/backups/pre-name-sync-2026-09-06.db',
        checkInsUpdated: 5, usersUpdated: 0, callsignsAffected: 2, skippedNoUlsName: 18,
      });
    }
    return json({});
  });
  return { fn, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('UlsNameSyncCard', () => {
  it('lists every sample when one callsign was logged under several names', async () => {
    // The sample list is what the admin actually reads before typing the
    // confirmation, so it has to show each (callsign, old name) pair the
    // server planned — including two rows for the same station.
    const { fn } = stub({
      ...preview,
      checkIns: {
        scanned: 9, changing: 9, unchanged: 0, noUlsName: 0,
        samples: [
          { callsign: 'KF0WBD', from: 'Bret', to: 'Bret N Flanders', rows: 5 },
          { callsign: 'KF0WBD', from: 'Brett', to: 'Bret N Flanders', rows: 3 },
          { callsign: 'KF0WBD', from: 'KF0WBD', to: 'Bret N Flanders', rows: 1 },
        ],
      },
    });
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);

    await userEvent.click(screen.getByTestId('name-sync-preview'));
    await screen.findByTestId('name-sync-preview-result');

    expect(screen.getByText('Bret')).toBeTruthy();
    expect(screen.getByText('Brett')).toBeTruthy();
    expect(screen.getAllByText('Bret N Flanders')).toHaveLength(3);
  });

  it('writes nothing until a preview has been seen and confirmed', async () => {
    const { fn, calls } = stub();
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);

    await userEvent.click(screen.getByTestId('name-sync-preview'));
    await screen.findByTestId('name-sync-preview-result');
    // Preview is a GET; nothing has been written.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    // The button stays disabled until the phrase matches exactly.
    const apply = screen.getByTestId('name-sync-apply');
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByTestId('name-sync-confirm-input'), 'replace names');
    expect(apply).toBeDisabled();
  });

  it('shows what would change, before and after', async () => {
    const { fn } = stub();
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);
    await userEvent.click(screen.getByTestId('name-sync-preview'));
    const panel = await screen.findByTestId('name-sync-preview-result');
    expect(panel).toHaveTextContent('Bret N Flanders');
    // A blank current name is shown as such rather than as an empty cell.
    expect(panel).toHaveTextContent('(blank)');
    // The count of rows left alone is stated, not hidden.
    expect(panel).toHaveTextContent('18');
  });

  it('applies once confirmed, and reports where the snapshot went', async () => {
    const { fn, calls } = stub();
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);
    await userEvent.click(screen.getByTestId('name-sync-preview'));
    await userEvent.type(await screen.findByTestId('name-sync-confirm-input'), 'REPLACE NAMES');
    await userEvent.click(screen.getByTestId('name-sync-apply'));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post).toBeDefined();
      expect(post!.body).toEqual({ includeUsers: false, confirm: 'REPLACE NAMES' });
    });
    const result = await screen.findByTestId('name-sync-result');
    // Knowing a backup exists is useless without knowing where it is.
    expect(result).toHaveTextContent('/data/backups/pre-name-sync-2026-09-06.db');
  });

  it('refuses to offer the action when the ULS data was never loaded', async () => {
    const { fn } = stub({ ...preview, ulsRows: 0 });
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);
    await userEvent.click(screen.getByTestId('name-sync-preview'));
    const panel = await screen.findByTestId('name-sync-preview-result');
    expect(panel).toHaveTextContent(/has not been loaded/i);
    expect(screen.queryByTestId('name-sync-apply')).toBeNull();
  });

  it('says so plainly when there is nothing to do', async () => {
    const { fn } = stub({
      ...preview,
      checkIns: { ...preview.checkIns, changing: 0, samples: [] },
    });
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);
    await userEvent.click(screen.getByTestId('name-sync-preview'));
    expect(await screen.findByTestId('name-sync-nothing')).toBeInTheDocument();
  });

  it('asks for member accounts explicitly — the log is the default', async () => {
    const { fn } = stub();
    vi.stubGlobal('fetch', fn);
    render(<UlsNameSyncCard />);
    expect(screen.getByTestId('name-sync-include-users')).not.toBeChecked();
    await userEvent.click(screen.getByTestId('name-sync-preview'));
    await screen.findByTestId('name-sync-preview-result');
    expect(fn.mock.calls.some((c) => String(c[0]).includes('includeUsers=false'))).toBe(true);
  });
});
