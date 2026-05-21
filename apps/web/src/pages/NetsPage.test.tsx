import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { NetsPage } from './NetsPage.js';

interface NetRow {
  id: string;
  name: string;
  kind: string;
  scriptCategory: string;
  reminderMinutes?: number[];
}

const officer = {
  id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role: 'OFFICER',
};

const repeaters = [
  { id: 'r1', name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
];

function netRow(over: Partial<NetRow>): NetRow & Record<string, unknown> {
  return {
    id: 'n1', name: 'Weekly Net', kind: 'weekly', scriptCategory: 'general',
    repeaterId: 'r1', dayOfWeek: 3, startLocal: '20:00', timezone: 'UTC',
    theme: null, scriptMd: null, active: true,
    reminderMinutes: [240, 30],
    repeater: repeaters[0], links: [],
    ...over,
  };
}

function mockFetch(nets: ReturnType<typeof netRow>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) return json(officer);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/nets/active')) return json([]);
    if (url.endsWith('/repeaters')) return json(repeaters);
    if (url.endsWith('/nets')) return json(nets);
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

describe('NetsPage script category', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch([
      netRow({ id: 'n1', name: 'General Net', scriptCategory: 'general' }),
      netRow({ id: 'n2', name: 'Weekly-Script Net', scriptCategory: 'weekly' }),
    ]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the script category badge for each net', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Script: General')).toBeInTheDocument();
    });
    expect(screen.getByText('Script: Weekly')).toBeInTheDocument();
  });

  it('filters nets by script category', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('General Net')).toBeInTheDocument();
    });
    // The category filter is the only select offering an "All categories" option.
    const filter = screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from((el as HTMLSelectElement).options).some(
          (o) => o.value === 'all',
        ),
      ) as HTMLSelectElement;
    expect(filter).toBeDefined();
    await userEvent.selectOptions(filter, 'weekly');
    expect(screen.queryByText('General Net')).not.toBeInTheDocument();
    expect(screen.getByText('Weekly-Script Net')).toBeInTheDocument();
  });

  it('opens the shared edit modal pre-filled when Edit is clicked', async () => {
    renderPage();
    await screen.findByText('General Net');
    const [editButton] = await screen.findAllByRole('button', { name: 'Edit' });
    await userEvent.click(editButton!);
    await waitFor(() => {
      expect(screen.getByText('Edit net')).toBeInTheDocument();
    });
    const nameInput = screen.getByDisplayValue('General Net');
    expect(nameInput).toBeInTheDocument();
  });

  it('shows the configured reminder lead times on each weekly net card', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', mockFetch([
      netRow({ id: 'n1', name: 'Quad Net', reminderMinutes: [1440, 60] }),
      netRow({ id: 'n2', name: 'Silent Net', reminderMinutes: [] }),
    ]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Quad Net')).toBeInTheDocument();
    });
    expect(screen.getByText(/Reminders:\s*1d, 1h/)).toBeInTheDocument();
    expect(screen.getByText(/Reminders:\s*off/)).toBeInTheDocument();
  });

  it('offers a script category selector in the net form', async () => {
    renderPage();
    const addBtn = await screen.findByRole('button', { name: 'Add net' });
    await userEvent.click(addBtn);
    // Within the modal form, find the select whose options are exactly the
    // three script categories (weekly/general/impromptu).
    await waitFor(() => {
      expect(screen.getByText('New net')).toBeInTheDocument();
    });
    const selector = screen
      .getAllByRole('combobox')
      .find((el) => {
        const vals = Array.from((el as HTMLSelectElement).options).map(
          (o) => o.value,
        );
        return (
          vals.length === 3 &&
          vals.includes('weekly') &&
          vals.includes('general') &&
          vals.includes('impromptu')
        );
      }) as HTMLSelectElement;
    expect(selector).toBeDefined();
    expect(selector.value).toBe('general');
    await userEvent.selectOptions(selector, 'impromptu');
    expect(selector.value).toBe('impromptu');
  });
});
