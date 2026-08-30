/**
 * The phone operator dock.
 *
 * jsdom has no layout and its matchMedia is a stub, so "narrow" is asserted by
 * driving matchMedia directly — the same seam useMediaQuery reads. The point of
 * these tests is the DOM contract the CSS depends on: which controls exist,
 * which are removed (not merely painted away) while collapsed, and that the
 * dock never engages where it would cover the script for no benefit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { RunNetPage } from './RunNetPage.js';

const repeater = {
  id: 'r1',
  name: 'W0QQQ 145.41',
  frequency: 145.41,
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
  scriptMd: 'Welcome.',
  scriptCategory: 'weekly',
  active: true,
  repeater,
  links: [],
};

/** matchMedia stub: `narrow` decides the (max-width: 1023px) answer. */
function stubViewport(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: narrow && q.includes('1023'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia,
  );
}

function makeFetch(opts: { live: boolean; recent?: Array<{ callsign: string; name: string }> }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me'))
      return json({ id: 'u1', callsign: 'W1AW', name: 'Op', email: 'o@x.co', role: 'OFFICER' });
    if (url.includes('/recent-checkins')) return json(opts.recent ?? []);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.includes('/presence')) return json([]);
    if (url.includes('/users/directory')) return json([]);
    if (url.includes('/topics/recommended')) return json([]);
    if (url.includes('/api/repeaters')) return json([repeater]);
    if (url.includes('/messages')) return json([]);
    if (url.includes('/api/sessions/s1')) {
      const startedAt = new Date().toISOString();
      return json({
        id: 's1',
        netId: 'n1',
        startedAt,
        liveAt: opts.live ? startedAt : null,
        endedAt: null,
        controlOpId: 'u1',
        topicTitle: null,
        topic: null,
        autoOpened: false,
        checkIns: [],
        net,
      });
    }
    return json({});
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('operator dock (narrow viewport)', () => {
  it('collapses to callsign + Add, taking the rest out of the a11y tree', async () => {
    stubViewport(true);
    vi.stubGlobal('fetch', makeFetch({ live: true }));
    renderPage();

    // The entry an operator needs mid-net is there…
    expect(await screen.findByLabelText('Callsign')).toBeVisible();
    expect(screen.getByTestId('checkin-add-button')).toBeInTheDocument();

    // …and the rest is collapsed with the `hidden` attribute, so it leaves the
    // accessibility tree and the tab order (role queries ignore hidden nodes)
    // while the nodes themselves stay mounted. That distinction is deliberate:
    // unmounting them would discard a half-typed comment every time the
    // operator collapsed the dock to see more of the script.
    expect(screen.queryByRole('textbox', { name: /^name$/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /comment/i })).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveAttribute('value', '');
  });

  it('[ MORE ] reveals name, mode and comment', async () => {
    stubViewport(true);
    vi.stubGlobal('fetch', makeFetch({ live: true }));
    renderPage();

    const toggle = await screen.findByTestId('dock-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Comment (optional)')).toBeInTheDocument();
    expect(screen.getByTestId('dock-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not dock during PREP — a disabled bar would just cover the script', async () => {
    stubViewport(true);
    vi.stubGlobal('fetch', makeFetch({ live: false }));
    renderPage();

    await screen.findByLabelText('Callsign');
    const form = document.querySelector('.hna-checkin-form');
    expect(form).not.toBeNull();
    expect(form!.className).not.toContain('hna-checkin-form--dock');
  });

  it('leaves the full form intact on a desktop viewport', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', makeFetch({ live: true }));
    renderPage();

    expect(await screen.findByLabelText('Callsign')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Comment (optional)')).toBeInTheDocument();
    expect(screen.queryByTestId('dock-toggle')).toBeNull();
  });
});

describe('recent check-ins rail', () => {
  it('fills the entry from a tapped chip', async () => {
    stubViewport(true);
    vi.stubGlobal(
      'fetch',
      makeFetch({ live: true, recent: [{ callsign: 'KF0WBD', name: 'Bret Flanders' }] }),
    );
    renderPage();

    const chip = await screen.findByTestId('recent-chip-KF0WBD');
    await userEvent.click(chip);

    await waitFor(() => {
      expect(screen.getByLabelText('Callsign')).toHaveValue('KF0WBD');
    });
    // Collapsed, the resolved name is the confirmation that the right station
    // is about to be logged.
    expect(await screen.findByTestId('dock-resolved-name')).toHaveTextContent(
      'Bret Flanders',
    );
  });

  it('renders nothing when this net has no regulars yet', async () => {
    stubViewport(true);
    vi.stubGlobal('fetch', makeFetch({ live: true, recent: [] }));
    renderPage();
    await screen.findByLabelText('Callsign');
    expect(screen.queryByTestId('recent-callsigns')).toBeNull();
  });
});
