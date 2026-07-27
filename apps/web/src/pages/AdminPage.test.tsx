import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { AdminPage } from './AdminPage.js';

const adminUser = {
  id: 'u1',
  callsign: 'W1AW',
  name: 'Admin Op',
  email: 'admin@x.co',
  role: 'ADMIN',
  collegeSlug: null,
};

const memberUser = {
  id: 'u2',
  callsign: 'KA1ABC',
  name: 'Member Op',
  email: 'member@x.co',
  role: 'MEMBER',
  collegeSlug: null,
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) return json(adminUser);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/presence/online')) return json([]);
    if (url.endsWith('/api/themes')) return json([]);
    if (url.endsWith('/themes/default')) return json({ slug: 'default' });
    if (url.endsWith('/discord/config'))
      return json({
        enabled: false,
        channelId: '',
        tokenSet: false,
        tokenFromEnv: false,
        channelIdFromEnv: false,
        enabledFromEnv: false,
      });
    if (url.endsWith('/admin/trash')) return json({ sessions: [], checkIns: [] });
    if (url.endsWith('/admin/duplicate-sessions')) return json([]);
    if (url.endsWith('/api/users')) return json([adminUser, memberUser]);
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ThemeProvider>
          <AdminPage />
        </ThemeProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AdminPage role assignment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers a Net Control option in the per-member role select', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderPage();

    // The role <select> for the member row is labelled by callsign.
    const roleSelect = (await screen.findByLabelText(
      'Role for KA1ABC',
    )) as HTMLSelectElement;

    const values = Array.from(roleSelect.options).map((o) => o.value);
    expect(values).toEqual(['MEMBER', 'NET_CONTROL', 'OFFICER', 'ADMIN']);

    // The NET_CONTROL option is labelled with the shared "Net Control" label.
    const netControlOption = within(roleSelect).getByRole('option', {
      name: 'Net Control',
    }) as HTMLOptionElement;
    expect(netControlOption.value).toBe('NET_CONTROL');
  });
});

describe('AdminPage failure reporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Every confirmed admin action used to funnel its failure into
   * `window.alert` — unstyled, event-loop-blocking, suppressible after a
   * couple of firings, and simply absent in a kiosk browser, so a failed
   * destructive action could show the admin nothing at all.
   */
  it('reports a failed confirmed action in an in-app banner, not window.alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const base = mockFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return new Response(
            JSON.stringify({
              error: { code: 'CONFLICT', message: 'Cannot delete the last admin' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return base(input);
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete member' }),
    );

    const banner = await screen.findByTestId('admin-banner');
    expect(banner).toHaveTextContent('Cannot delete the last admin');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(alertSpy).not.toHaveBeenCalled();

    // …and it can be dismissed once read.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('admin-banner')).not.toBeInTheDocument();
    alertSpy.mockRestore();
  });
});
