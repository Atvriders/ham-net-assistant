import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScriptLibraryPanel } from './ScriptLibraryPanel.js';
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

const scripts = [
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
];

function makeFetch(user: typeof officer | typeof member | null) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
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
    if (url.endsWith('/api/scripts') && (init?.method ?? 'GET') === 'GET') {
      return json(scripts);
    }
    return json([]);
  });
}

describe('ScriptLibraryPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists saved scripts for an officer', async () => {
    vi.stubGlobal('fetch', makeFetch(officer));
    render(
      <AuthProvider>
        <ScriptLibraryPanel />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('Script library')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Opening')).toBeInTheDocument();
    });
    expect(screen.getByText('weekly')).toBeInTheDocument();
  });

  it('renders nothing for a regular member', async () => {
    vi.stubGlobal('fetch', makeFetch(member));
    const { container } = render(
      <AuthProvider>
        <ScriptLibraryPanel />
      </AuthProvider>,
    );
    // Wait for auth resolution; the panel must not appear at all.
    await waitFor(() => {
      expect(container.textContent ?? '').not.toContain('Script library');
    });
    expect(screen.queryByText('Script library')).toBeNull();
    expect(screen.queryByText('Opening')).toBeNull();
  });
});

describe('ScriptLibraryPanel error reporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces a rejected save in an alert region', async () => {
    // The save error sits under a tall script editor the officer has usually
    // scrolled past, so it must announce itself instead of quietly turning red.
    vi.stubGlobal('fetch', makeFetch(officer));
    render(
      <AuthProvider>
        <ScriptLibraryPanel />
      </AuthProvider>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'New script' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Title is required.');
    expect(alert).toHaveClass('hna-form-error');
  });

  it('names the editor dialog once, from its in-body heading', async () => {
    vi.stubGlobal('fetch', makeFetch(officer));
    render(
      <AuthProvider>
        <ScriptLibraryPanel />
      </AuthProvider>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'New script' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'New saved script' }),
    ).toBeInTheDocument();
    // Exactly one visible heading — the header bar must not repeat it.
    expect(screen.getAllByText('New saved script')).toHaveLength(1);
  });
});
