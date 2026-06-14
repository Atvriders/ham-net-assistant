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

function makeSession(checkIns: Array<{
  id: string;
  callsign: string;
  nameAtCheckIn: string;
  checkedInAt: string;
  mode: 'rf' | 'echolink';
}>) {
  const startedAt = new Date().toISOString();
  return {
    id: 's1',
    netId: 'n1',
    startedAt,
    liveAt: startedAt,
    endedAt: null,
    controlOpId: 'u1',
    checkIns,
    net,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function makeMockFetch(initialCheckIns: ReturnType<typeof makeSession>['checkIns']) {
  const calls: FetchCall[] = [];
  const checkIns = [...initialCheckIns];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    }
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
        mode?: 'rf' | 'echolink';
      };
      const newCi = {
        id: `c${checkIns.length + 1}`,
        callsign: body.callsign,
        nameAtCheckIn: body.nameAtCheckIn,
        checkedInAt: new Date().toISOString(),
        mode: body.mode ?? 'rf',
      };
      checkIns.unshift(newCi);
      return json(newCi, 201);
    }
    if (url.endsWith('/api/sessions/s1')) return json(makeSession(checkIns));
    return json([]);
  });
  return { fn, calls };
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

describe('RunNetPage EchoLink mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the EchoLink chip in the roster for an echolink check-in', async () => {
    const { fn } = makeMockFetch([
      {
        id: 'c0',
        callsign: 'KE0VOIP',
        nameAtCheckIn: 'Remote',
        checkedInAt: new Date().toISOString(),
        mode: 'echolink',
      },
      {
        id: 'c1',
        callsign: 'KE0RF1',
        nameAtCheckIn: 'OnAir',
        checkedInAt: new Date().toISOString(),
        mode: 'rf',
      },
    ]);
    vi.stubGlobal('fetch', fn);
    renderPage();
    // The EchoLink row gets a chip; the RF row does not.
    await waitFor(() => {
      expect(screen.getAllByTestId('echolink-chip').length).toBe(1);
    });
  });

  it("mode toggle defaults to 'rf' and the RF chip is the pressed state", async () => {
    const { fn } = makeMockFetch([]);
    vi.stubGlobal('fetch', fn);
    renderPage();
    const rfBtn = await screen.findByTestId('checkin-mode-rf');
    const ecBtn = await screen.findByTestId('checkin-mode-echolink');
    expect(rfBtn).toHaveAttribute('aria-pressed', 'true');
    expect(ecBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it("switching the toggle to ECHOLINK sends mode: 'echolink' on POST and resets to RF after submit", async () => {
    const { fn, calls } = makeMockFetch([]);
    vi.stubGlobal('fetch', fn);
    renderPage();
    // Switch to EchoLink.
    await userEvent.click(await screen.findByTestId('checkin-mode-echolink'));
    expect(screen.getByTestId('checkin-mode-echolink')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Fill the check-in form.
    const csInput = screen.getByLabelText('Callsign');
    await userEvent.type(csInput, 'KE0VOIP');
    const nameInput = screen.getByLabelText('Name');
    await userEvent.type(nameInput, 'Remote');
    await userEvent.click(screen.getByTestId('checkin-add-button'));
    // Confirm the POST body carried mode: 'echolink'.
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/sessions/s1/checkins'),
      );
      expect(post).toBeDefined();
      expect((post!.body as { mode?: string }).mode).toBe('echolink');
    });
    // After submit the toggle resets to RF so the next check-in defaults to
    // the FCC-friendly common case.
    await waitFor(() => {
      expect(screen.getByTestId('checkin-mode-rf')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});
