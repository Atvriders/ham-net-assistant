import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
