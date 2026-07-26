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

/** Build a session payload in PREP (liveAt null) or LIVE (liveAt set) state. */
function makeSession(opts: {
  live: boolean;
  topicTitle?: string | null;
  net?: typeof net;
}) {
  const startedAt = new Date().toISOString();
  return {
    id: 's1',
    netId: 'n1',
    startedAt,
    liveAt: opts.live ? startedAt : null,
    endedAt: null,
    controlOpId: 'u1',
    topicTitle: opts.topicTitle ?? null,
    topic: null,
    autoOpened: false,
    checkIns: [],
    net: opts.net ?? net,
  };
}

/** Two OPEN topic suggestions, oldest-first; index 0 is the recommendation. */
const recommendedTopics = [
  {
    id: 't1',
    title: 'Field Day planning',
    status: 'OPEN',
    createdByCallsign: 'K1ABC',
    recommended: true,
  },
  {
    id: 't2',
    title: 'Antenna projects',
    status: 'OPEN',
    createdByCallsign: 'W2XYZ',
    recommended: false,
  },
];

/**
 * Mock fetch driver — captures POST calls so individual tests can assert that
 * START NET fires POST /api/sessions/s1/start. The session state is mutable so
 * the page can re-fetch the same URL and see liveAt transition from null → set.
 */
function makeMockFetch(opts: {
  role: string;
  live: boolean;
  topics?: typeof recommendedTopics;
  initialTopic?: string | null;
  net?: typeof net;
}) {
  let live = opts.live;
  // Mutable so a PATCH that sets a topic is reflected on the next GET refresh.
  let topicTitle: string | null = opts.initialTopic ?? null;
  const calls: { url: string; method: string; body?: unknown }[] = [];
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
        role: opts.role,
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/api/repeaters')) return json([repeater]);
    if (url.endsWith('/api/topics/recommended'))
      return json(opts.topics ?? []);
    if (url.endsWith('/api/sessions/s1/start') && method === 'POST') {
      live = true;
      return json(makeSession({ live: true, topicTitle, net: opts.net }));
    }
    // PATCH a topic suggestion's status (mark USED) — captured in `calls`.
    if (/\/api\/topics\/[^/]+\/status$/.test(url) && method === 'PATCH') {
      return json({});
    }
    if (url.endsWith('/api/sessions/s1') && method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if ('topicTitle' in body) topicTitle = body.topicTitle || null;
      return json(makeSession({ live, topicTitle, net: opts.net }));
    }
    if (url.endsWith('/api/sessions/s1'))
      return json(makeSession({ live, topicTitle, net: opts.net }));
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

describe('RunNetPage prep/draft state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the PREP chip and "NOT YET STARTED" copy when liveAt is null', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(
      await screen.findByTestId('prep-not-started-label'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Elapsed time')).not.toBeInTheDocument();
  });

  it('shows a START NET button for OFFICERs in PREP', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(
      await screen.findByTestId('start-net-button'),
    ).toBeInTheDocument();
  });

  it('clicking START NET POSTs to /api/sessions/:id/start', async () => {
    const { fn, calls } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const startBtn = await screen.findByTestId('start-net-button');
    await userEvent.click(startBtn);
    await waitFor(() => {
      expect(
        calls.find(
          (c) =>
            c.method === 'POST' && c.url.endsWith('/api/sessions/s1/start'),
        ),
      ).toBeDefined();
    });
  });

  it('check-in Add button is disabled in PREP', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const addBtn = await screen.findByTestId('checkin-add-button');
    expect(addBtn).toBeDisabled();
    expect(
      screen.getByTestId('prep-checkin-hint'),
    ).toBeInTheDocument();
  });

  it('renders LIVE UI (elapsed timer, enabled add button) when liveAt is set', async () => {
    const { fn } = makeMockFetch({ role: 'OFFICER', live: true });
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('prep-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('start-net-button')).not.toBeInTheDocument();
    const addBtn = screen.getByTestId('checkin-add-button');
    expect(addBtn).not.toBeDisabled();
  });

  it('hides START NET for MEMBER role', async () => {
    const { fn } = makeMockFetch({ role: 'MEMBER', live: false });
    vi.stubGlobal('fetch', fn);
    renderPage();
    // The PREP chip should still render (everyone sees prep state) but the
    // START button is officer-gated.
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(
      screen.queryByTestId('start-net-button'),
    ).not.toBeInTheDocument();
  });

  it('renders the TOPIC picker in prep with the recommended suggestion flagged', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    // Section caption + "no topic yet" current line.
    expect(await screen.findByTestId('topic-current')).toBeInTheDocument();
    expect(screen.getByText('No topic set yet.')).toBeInTheDocument();
    // Both suggestions render; only the oldest carries the RECOMMENDED chip.
    await waitFor(() => {
      expect(screen.getByText('Field Day planning')).toBeInTheDocument();
    });
    expect(screen.getByText('Antenna projects')).toBeInTheDocument();
    const chips = screen.getAllByTestId('topic-recommended-chip');
    expect(chips).toHaveLength(1);
    // The chip sits on the recommended (first) suggestion's row.
    expect(screen.getByTestId('topic-use-t1')).toBeInTheDocument();
  });

  it('clicking "Use" PATCHes the session with topicTitle+topicId and marks the suggestion USED', async () => {
    const { fn, calls } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const useBtn = await screen.findByTestId('topic-use-t1');
    await userEvent.click(useBtn);
    await waitFor(() => {
      const patchSession = calls.find(
        (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
      );
      expect(patchSession?.body).toEqual({
        topicTitle: 'Field Day planning',
        topicId: 't1',
      });
    });
    // The suggestion is marked USED via the status route.
    expect(
      calls.find(
        (c) =>
          c.method === 'PATCH' &&
          c.url.endsWith('/api/topics/t1/status'),
      )?.body,
    ).toEqual({ status: 'USED' });
    // The chosen topic now shows as current (read-only line refreshed).
    await waitFor(() => {
      expect(
        screen.getByTestId('topic-readonly').textContent,
      ).toContain('Field Day planning');
    });
  });

  it('the custom-topic input PATCHes the session with topicTitle only', async () => {
    const { fn, calls } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const input = await screen.findByLabelText('Custom topic');
    await userEvent.type(input, 'Grid square hunting');
    await userEvent.click(screen.getByTestId('topic-set-custom-button'));
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
      );
      expect(patch?.body).toEqual({ topicTitle: 'Grid square hunting' });
    });
    // No topicId on a free-text topic.
    const patch = calls.find(
      (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
    );
    expect(patch?.body).not.toHaveProperty('topicId');
  });

  it('hides the TOPIC picker once the net is LIVE (read-only topic only)', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    // Wait for the live UI to settle.
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    // Picker affordances are gone in LIVE: no suggestions list, no custom input,
    // no Use buttons.
    expect(
      screen.queryByTestId('topic-suggestions'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Custom topic')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topic-use-t1')).not.toBeInTheDocument();
  });

  it('does not show the TOPIC picker for MEMBER role in prep', async () => {
    const { fn } = makeMockFetch({
      role: 'MEMBER',
      live: false,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('topic-current')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topic-use-t1')).not.toBeInTheDocument();
  });
});

describe('RunNetPage live topic editor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a compact "Add topic" affordance for OFFICERs in LIVE with no topic, picker hidden until opened', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    // Live UI settled.
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    // Compact display + "Add topic" toggle (no topic set yet).
    const toggle = await screen.findByTestId('topic-live-edit-toggle');
    expect(toggle).toHaveTextContent('Add topic');
    expect(screen.getByTestId('topic-readonly')).toHaveTextContent(
      'No topic set yet.',
    );
    // The picker stays hidden until the officer opens the editor.
    expect(screen.queryByTestId('topic-suggestions')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Custom topic')).not.toBeInTheDocument();
  });

  it('labels the toggle "Edit topic" when a topic is already set in LIVE', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      topics: recommendedTopics,
      initialTopic: 'Existing topic',
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    const toggle = await screen.findByTestId('topic-live-edit-toggle');
    expect(toggle).toHaveTextContent('Edit topic');
    expect(screen.getByTestId('topic-readonly')).toHaveTextContent(
      'Existing topic',
    );
  });

  it('opening the LIVE editor reveals the picker (suggestions + custom input)', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const toggle = await screen.findByTestId('topic-live-edit-toggle');
    await userEvent.click(toggle);
    // Picker appears inline: suggestions (with the recommended chip) + custom.
    expect(await screen.findByTestId('topic-suggestions')).toBeInTheDocument();
    expect(screen.getByText('Field Day planning')).toBeInTheDocument();
    expect(screen.getAllByTestId('topic-recommended-chip')).toHaveLength(1);
    expect(screen.getByLabelText('Custom topic')).toBeInTheDocument();
    // Toggle now offers to collapse the editor.
    expect(toggle).toHaveTextContent('Done');
  });

  it('using a suggestion in LIVE PATCHes topicTitle+topicId, marks it USED, and collapses the editor', async () => {
    const { fn, calls } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const toggle = await screen.findByTestId('topic-live-edit-toggle');
    await userEvent.click(toggle);
    const useBtn = await screen.findByTestId('topic-use-t1');
    await userEvent.click(useBtn);
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
      );
      expect(patch?.body).toEqual({
        topicTitle: 'Field Day planning',
        topicId: 't1',
      });
    });
    // Suggestion marked USED.
    expect(
      calls.find(
        (c) =>
          c.method === 'PATCH' && c.url.endsWith('/api/topics/t1/status'),
      )?.body,
    ).toEqual({ status: 'USED' });
    // Editor collapses back to the compact display; new topic shows read-only.
    await waitFor(() => {
      expect(screen.queryByTestId('topic-live-editor')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('topic-readonly')).toHaveTextContent(
      'Field Day planning',
    );
  });

  it('the custom-topic input in LIVE PATCHes topicTitle only and collapses the editor', async () => {
    const { fn, calls } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      topics: recommendedTopics,
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const toggle = await screen.findByTestId('topic-live-edit-toggle');
    await userEvent.click(toggle);
    const input = await screen.findByLabelText('Custom topic');
    await userEvent.type(input, 'Grid square hunting');
    await userEvent.click(screen.getByTestId('topic-set-custom-button'));
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
      );
      expect(patch?.body).toEqual({ topicTitle: 'Grid square hunting' });
    });
    const patch = calls.find(
      (c) => c.method === 'PATCH' && c.url.endsWith('/api/sessions/s1'),
    );
    expect(patch?.body).not.toHaveProperty('topicId');
    // Editor collapsed after the change.
    await waitFor(() => {
      expect(screen.queryByTestId('topic-live-editor')).not.toBeInTheDocument();
    });
  });

  it('does not show the live topic edit affordance for MEMBER role', async () => {
    const { fn } = makeMockFetch({
      role: 'MEMBER',
      live: true,
      topics: recommendedTopics,
      initialTopic: 'Members read this',
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    // Read-only topic is visible, but no edit toggle / picker for members.
    expect(screen.getByTestId('topic-readonly')).toHaveTextContent(
      'Members read this',
    );
    expect(
      screen.queryByTestId('topic-live-edit-toggle'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('topic-suggestions')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Custom topic')).not.toBeInTheDocument();
  });
});

/** UTC `HH:mm` for `minutes` from now — pairs with `timezone: 'UTC'`. */
function startLocalMinutesFromNow(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

describe('RunNetPage 5-minute announcement banner', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the banner in PREP when a weekly start is within 5 minutes', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      net: { ...net, startLocal: startLocalMinutesFromNow(3), timezone: 'UTC' },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const banner = await screen.findByTestId('five-minute-banner');
    expect(banner).toHaveTextContent('5-MINUTE ANNOUNCEMENT');
    expect(banner).toHaveTextContent('NET STARTS AT');
  });

  it('does not show the banner when the start is farther out', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      net: { ...net, startLocal: startLocalMinutesFromNow(45), timezone: 'UTC' },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('never shows the banner for impromptu nets', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      net: {
        ...net,
        kind: 'impromptu',
        startLocal: startLocalMinutesFromNow(3),
        timezone: 'UTC',
      },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('does not show the banner once the session is LIVE, even inside the window', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      net: { ...net, startLocal: startLocalMinutesFromNow(3), timezone: 'UTC' },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });
});

describe('RunNetPage auto-start countdown strip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the countdown in PREP when the weekly start is farther than 5 minutes out', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      net: { ...net, startLocal: startLocalMinutesFromNow(45), timezone: 'UTC' },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    const strip = await screen.findByTestId('prep-countdown');
    expect(strip).toHaveTextContent('AUTO-START IN');
    // Calm state — the flashing 5-minute treatment hasn't kicked in yet.
    expect(strip).not.toHaveClass('hna-fivemin');
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
    // The manual START button stays available throughout.
    expect(screen.getByTestId('start-net-button')).toBeInTheDocument();
  });

  it('shows no countdown for impromptu nets', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: false,
      net: {
        ...net,
        kind: 'impromptu',
        startLocal: startLocalMinutesFromNow(45),
        timezone: 'UTC',
      },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    expect(await screen.findByTestId('prep-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('prep-countdown')).not.toBeInTheDocument();
  });

  it('shows no countdown once the session is LIVE', async () => {
    const { fn } = makeMockFetch({
      role: 'OFFICER',
      live: true,
      net: { ...net, startLocal: startLocalMinutesFromNow(45), timezone: 'UTC' },
    });
    vi.stubGlobal('fetch', fn);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('prep-countdown')).not.toBeInTheDocument();
  });
});
