import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RunNetPage } from './RunNetPage.js';

const repeater = {
  id: 'r1',
  name: 'R1',
  frequency: 146.76,
  offsetKhz: -600,
  toneHz: 100,
  mode: 'FM',
};

const net = {
  id: 'n1',
  name: 'Tuesday Net',
  kind: 'weekly',
  repeaterId: 'r1',
  dayOfWeek: 2,
  startLocal: '20:00',
  timezone: 'UTC',
  theme: null,
  scriptMd: 'Welcome to the net.',
  scriptCategory: 'weekly',
  active: true,
  repeater,
  links: [],
};

const session = {
  id: 's1',
  netId: 'n1',
  startedAt: new Date().toISOString(),
  // Existing tests assume the session is already live, so seed liveAt so the
  // RunNetPage renders the live UI (not the new PREP state).
  liveAt: new Date().toISOString(),
  endedAt: null,
  controlOpId: 'u1',
  checkIns: [],
  net,
};

function mockFetch(role: string, onPatch: (b: unknown) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role,
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    if (url.endsWith('/api/sessions/s1')) return json(session);
    if (url.endsWith('/api/nets/n1') && init?.method === 'PATCH') {
      onPatch(JSON.parse(String(init.body)));
      return json(net);
    }
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/run/s1']}>
      <AuthProvider>
        <Routes>
          <Route path="/run/:sessionId" element={<RunNetPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RunNetPage script tab edit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an Edit net button on the script panel for officers', async () => {
    vi.stubGlobal('fetch', mockFetch('OFFICER', () => {}));
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'Edit net' }),
    ).toBeInTheDocument();
  });

  it('opens the net edit modal pre-filled and PATCHes the net', async () => {
    const patched: unknown[] = [];
    vi.stubGlobal('fetch', mockFetch('OFFICER', (b) => patched.push(b)));
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit net' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Edit net', { selector: 'h2' })).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('Tuesday Net')).toBeInTheDocument();
    // The script editor defaults to WYSIWYG; switch to raw markdown so the
    // test can drive a textarea directly. ScriptEditor is now lazy-loaded,
    // so await its tabs before clicking.
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Raw markdown' }),
    );
    const scriptBox = screen.getByTestId('script-raw') as HTMLTextAreaElement;
    await userEvent.clear(scriptBox);
    await userEvent.type(scriptBox, 'Revised script.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect((patched[0] as { scriptMd: string }).scriptMd).toBe(
      'Revised script.',
    );
  });

  it('hides the Edit net button for members', async () => {
    vi.stubGlobal('fetch', mockFetch('MEMBER', () => {}));
    renderPage();
    await screen.findByText('Script');
    expect(
      screen.queryByRole('button', { name: 'Edit net' }),
    ).not.toBeInTheDocument();
  });
});

describe('RunNetPage script markdown render', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a markdown script formatted (heading + list), not raw syntax', async () => {
    const mdNet = { ...net, scriptMd: '# Topic\n\n- one\n- two' };
    const mdSession = { ...session, net: mdNet };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/auth/me'))
          return json({
            id: 'u1',
            callsign: 'W1AW',
            name: 'Op',
            email: 'o@x.co',
            role: 'OFFICER',
          });
        if (url.endsWith('/presence/heartbeat')) return json({});
        if (url.endsWith('/api/repeaters')) return json([repeater]);
        if (url.endsWith('/api/sessions/s1')) return json(mdSession);
        return json([]);
      }),
    );
    renderPage();

    // The heading and list items render as real HTML elements.
    const heading = await screen.findByRole('heading', { name: 'Topic' });
    expect(heading.tagName).toBe('H1');
    expect(screen.getByText('one').tagName).toBe('LI');
    expect(screen.getByText('two').tagName).toBe('LI');

    // The raw markdown characters must NOT appear as visible text.
    expect(screen.queryByText('# Topic')).not.toBeInTheDocument();
    expect(screen.queryByText('- one')).not.toBeInTheDocument();
  });
});
