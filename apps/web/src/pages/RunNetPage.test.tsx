import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('RunNetPage roster log order and name display', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // As returned by the API: newest first (descending checkedInAt).
  const initialCheckIns = [
    {
      id: 'c3',
      callsign: 'KC3CCC',
      nameAtCheckIn: 'Charlie Chesterfield-Worthington',
      checkedInAt: '2026-07-18T20:12:00Z',
      mode: 'rf' as const,
      createdById: 'u1',
    },
    {
      id: 'c2',
      callsign: 'KB2BBB',
      nameAtCheckIn: 'Bravo Middleton',
      checkedInAt: '2026-07-18T20:06:00Z',
      mode: 'rf' as const,
      createdById: 'u1',
    },
    {
      id: 'c1',
      callsign: 'KA1AAA',
      nameAtCheckIn: 'Alpha Anderson',
      checkedInAt: '2026-07-18T20:01:00Z',
      mode: 'rf' as const,
      createdById: 'u1',
    },
  ];

  /** Mutable mock: POST /checkins unshifts (API keeps newest-first order). */
  function makeRosterMockFetch() {
    const checkIns = [...initialCheckIns];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
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
      if (url.endsWith('/api/sessions/s1/checkins') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          callsign: string;
          nameAtCheckIn: string;
        };
        const newCi = {
          id: `c${checkIns.length + 1}`,
          callsign: body.callsign,
          nameAtCheckIn: body.nameAtCheckIn,
          checkedInAt: new Date().toISOString(),
          mode: 'rf' as const,
          createdById: 'u1',
        };
        checkIns.unshift(newCi);
        return json(newCi, 201);
      }
      if (url.endsWith('/api/sessions/s1'))
        return json({ ...session, checkIns });
      return json([]);
    });
    return fn;
  }

  it('lists check-ins OLDEST first — #01 at the top, newest at the bottom', async () => {
    vi.stubGlobal('fetch', makeRosterMockFetch());
    renderPage();
    const log = await screen.findByRole('log', { name: 'Check-in log' });
    await waitFor(() => {
      expect(within(log).getAllByRole('listitem')).toHaveLength(3);
    });
    const rows = within(log).getAllByRole('listitem');
    // Oldest (first to check in) at the top, numbered #01.
    expect(rows[0]).toHaveTextContent('#01');
    expect(rows[0]).toHaveTextContent('KA1AAA');
    expect(rows[1]).toHaveTextContent('#02');
    expect(rows[1]).toHaveTextContent('KB2BBB');
    // Newest at the bottom with the highest number.
    expect(rows[2]).toHaveTextContent('#03');
    expect(rows[2]).toHaveTextContent('KC3CCC');
  });

  it('appends a newly added check-in at the BOTTOM with the next number', async () => {
    vi.stubGlobal('fetch', makeRosterMockFetch());
    renderPage();
    const log = await screen.findByRole('log', { name: 'Check-in log' });
    await waitFor(() => {
      expect(within(log).getAllByRole('listitem')).toHaveLength(3);
    });
    await userEvent.type(screen.getByLabelText('Callsign'), 'KD4DDD');
    await userEvent.type(screen.getByLabelText('Name'), 'Delta');
    await userEvent.click(screen.getByTestId('checkin-add-button'));
    await waitFor(() => {
      expect(within(log).getAllByRole('listitem')).toHaveLength(4);
    });
    const rows = within(log).getAllByRole('listitem');
    expect(rows[3]).toHaveTextContent('#04');
    expect(rows[3]).toHaveTextContent('KD4DDD');
    // The oldest row is untouched at the top.
    expect(rows[0]).toHaveTextContent('#01');
    expect(rows[0]).toHaveTextContent('KA1AAA');
  });

  it('does not scroll the roster on initial load — only when a NEW check-in arrives', async () => {
    // jsdom has no scrollIntoView; install a spy so the effect's guard passes.
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      vi.stubGlobal('fetch', makeRosterMockFetch());
      renderPage();
      const log = await screen.findByRole('log', { name: 'Check-in log' });
      await waitFor(() => {
        expect(within(log).getAllByRole('listitem')).toHaveLength(3);
      });
      // Opening a session that already has check-ins must not jump the page.
      expect(scrollSpy).not.toHaveBeenCalled();
      await userEvent.type(screen.getByLabelText('Callsign'), 'KD4DDD');
      await userEvent.type(screen.getByLabelText('Name'), 'Delta');
      await userEvent.click(screen.getByTestId('checkin-add-button'));
      await waitFor(() => {
        expect(within(log).getAllByRole('listitem')).toHaveLength(4);
      });
      // The newly appended bottom row gets nudged into view.
      await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('puts the full name in the name cell title so hover always reveals it', async () => {
    vi.stubGlobal('fetch', makeRosterMockFetch());
    renderPage();
    const log = await screen.findByRole('log', { name: 'Check-in log' });
    await waitFor(() => {
      expect(within(log).getAllByRole('listitem')).toHaveLength(3);
    });
    const nameCell = within(log).getByTitle('Charlie Chesterfield-Worthington');
    expect(nameCell).toHaveClass('hna-roster__name');
    expect(nameCell).toHaveTextContent('Charlie Chesterfield-Worthington');
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
