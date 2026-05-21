import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReminderSettingsPanel } from './ReminderSettingsPanel.js';
import { AuthProvider } from '../auth/AuthProvider.js';

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
    name: 'Tuesday Net',
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

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFetch(opts: {
  user: typeof officer | typeof member | null;
  nets: NetRow[];
  calls: FetchCall[];
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) {
      if (!opts.user) {
        return new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return json(opts.user);
    }
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/repeaters')) return json(repeaters);
    if (url.endsWith('/nets')) return json(opts.nets);
    const patchMatch = url.match(/\/nets\/([^/]+)$/);
    if (patchMatch && method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      opts.calls.push({ url, method, body });
      const id = patchMatch[1]!;
      const found = opts.nets.find((n) => n.id === id);
      if (
        found &&
        body &&
        typeof body === 'object' &&
        'reminderMinutes' in body
      ) {
        found.reminderMinutes = (body as { reminderMinutes: number[] })
          .reminderMinutes;
      }
      return json(found ?? {});
    }
    return json([]);
  });
}

function renderPanel() {
  return render(
    <AuthProvider>
      <ReminderSettingsPanel />
    </AuthProvider>,
  );
}

describe('ReminderSettingsPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists weekly nets and hides impromptu nets', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({
        user: officer,
        nets: [
          netRow({ id: 'n1', name: 'Weekly One', kind: 'weekly' }),
          netRow({ id: 'n2', name: 'Adhoc Two', kind: 'impromptu' }),
        ],
        calls,
      }),
    );
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('Weekly One')).toBeInTheDocument();
    });
    expect(screen.queryByText('Adhoc Two')).not.toBeInTheDocument();
  });

  it('toggle OFF sends PATCH with [] and updates the summary', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({
        user: officer,
        nets: [netRow({ id: 'n1', name: 'Toggle Net', reminderMinutes: [240, 30] })],
        calls,
      }),
    );
    renderPanel();
    const sw = (await screen.findByRole('switch', {
      name: /Reminders for Toggle Net/,
    })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    // The summary cell for this row shows "4h, 30m".
    const rowCells = screen.getAllByText(/4h, 30m/);
    expect(rowCells.length).toBeGreaterThan(0);
    await userEvent.click(sw);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect((patch.body as { reminderMinutes: number[] }).reminderMinutes).toEqual([]);
    await waitFor(() => {
      expect(screen.getByText(/^off$/)).toBeInTheDocument();
    });
  });

  it('toggle ON (from off) sends PATCH with DEFAULT_REMINDER_MINUTES', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({
        user: officer,
        nets: [netRow({ id: 'n1', name: 'Silent Net', reminderMinutes: [] })],
        calls,
      }),
    );
    renderPanel();
    const sw = (await screen.findByRole('switch', {
      name: /Reminders for Silent Net/,
    })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await userEvent.click(sw);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect((patch.body as { reminderMinutes: number[] }).reminderMinutes).toEqual([
      240, 30,
    ]);
  });

  it('does not render anything for non-officer users', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({
        user: member,
        nets: [netRow({ id: 'n1', name: 'Hidden Net' })],
        calls,
      }),
    );
    const { container } = renderPanel();
    // Wait for auth to resolve.
    await waitFor(() => {
      expect(container.querySelector('[role="switch"]')).toBeNull();
    });
    expect(screen.queryByText('Reminder settings')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden Net')).not.toBeInTheDocument();
  });

  it('opens the NetEditModal when Customize is clicked', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({
        user: officer,
        nets: [netRow({ id: 'n1', name: 'Fine Tune Net' })],
        calls,
      }),
    );
    renderPanel();
    await screen.findByText('Fine Tune Net');
    await userEvent.click(
      screen.getByRole('button', { name: 'Customize' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Edit net')).toBeInTheDocument();
    });
  });
});
