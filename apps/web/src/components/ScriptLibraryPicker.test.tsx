import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetEditModal, netToInput } from './NetEditModal.js';
import type { NetWithRepeater } from './NetEditModal.js';

const repeaters = [
  { id: 'r1', name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
];

const baseNet: NetWithRepeater = {
  id: 'n1',
  name: 'Tuesday Net',
  kind: 'weekly',
  repeaterId: 'r1',
  dayOfWeek: 2,
  startLocal: '20:00',
  timezone: 'UTC',
  theme: null,
  scriptMd: '',
  scriptCategory: 'weekly',
  reminderMinutes: [240, 30],
  active: true,
  repeater: repeaters[0] as never,
  links: [],
} as never;

const savedScripts = [
  {
    id: 's1',
    title: 'Opening boilerplate',
    category: 'weekly',
    body: '# Welcome to the net',
    createdById: 'u1',
    createdByCallsign: 'W1AW',
    createdByName: 'Op',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  },
  {
    id: 's2',
    title: 'Closing remarks',
    category: 'general',
    body: 'Thanks all',
    createdById: 'u1',
    createdByCallsign: 'W1AW',
    createdByName: 'Op',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  },
];

function makeFetch(opts: {
  scriptCalls: { method: string; body: unknown }[];
  patchCalls?: { body: unknown }[];
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/repeaters')) return json(repeaters);
    if (url.includes('/api/scripts')) {
      opts.scriptCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'GET') {
        // Return either filtered or all based on query
        const m = url.match(/category=([^&]+)/);
        if (m) {
          return json(savedScripts.filter((s) => s.category === m[1]));
        }
        return json(savedScripts);
      }
      if (method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return json({
          id: 'snew',
          title: body.title,
          category: body.category ?? 'general',
          body: body.body,
          createdById: 'u1',
          createdByCallsign: 'W1AW',
          createdByName: 'Op',
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
        }, 201);
      }
    }
    if (url.endsWith('/api/nets/n1') && method === 'PATCH') {
      opts.patchCalls?.push({ body: JSON.parse(String(init?.body)) });
      return json({ ...baseNet });
    }
    return json([]);
  });
}

describe('NetEditModal saved-script library', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the picker, lists saved scripts and loads body on selection', async () => {
    const scriptCalls: { method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', makeFetch({ scriptCalls }));
    render(
      <NetEditModal
        open
        netId="n1"
        initial={netToInput(baseNet)}
        repeaters={repeaters as never}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByText('Edit net');
    await userEvent.click(
      screen.getByRole('button', { name: /Use saved script/i }),
    );
    await waitFor(() => {
      expect(screen.getByText('Use a saved script')).toBeInTheDocument();
    });
    // Switch the filter to "all" so both scripts show. Scope to the picker
    // dialog so the NetEditModal's own "Script category" select (now
    // programmatically labelled via htmlFor) isn't ambiguous.
    const pickerDialog = screen.getByRole('dialog', { name: /Use a saved script/i });
    const select = within(pickerDialog).getByLabelText(/Category/i) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'all');
    await waitFor(() => {
      expect(screen.getByText('Opening boilerplate')).toBeInTheDocument();
      expect(screen.getByText('Closing remarks')).toBeInTheDocument();
    });
    // Pick "Closing remarks"
    const closing = screen.getByText('Closing remarks').closest('li')!;
    await userEvent.click(
      closing.querySelector('button')! as HTMLButtonElement,
    );
    // Loaded title is shown
    await waitFor(() => {
      expect(screen.getByTestId('loaded-script-title').textContent).toContain(
        'Closing remarks',
      );
    });
    // Switch to raw markdown to inspect the editor body. Wait for the
    // lazy-loaded ScriptEditor chunk to mount its tabs.
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Raw markdown' }),
    );
    expect(
      (screen.getByTestId('script-raw') as HTMLTextAreaElement).value,
    ).toBe('Thanks all');
  });

  it('Save as saved script POSTs to /scripts with editor body, title, category', async () => {
    const scriptCalls: { method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', makeFetch({ scriptCalls }));
    // Seed window.prompt
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockReturnValue('My library entry');
    const fixtureNet: NetWithRepeater = {
      ...baseNet,
      scriptMd: 'Body to save',
    } as never;
    render(
      <NetEditModal
        open
        netId="n1"
        initial={netToInput(fixtureNet)}
        repeaters={repeaters as never}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByText('Edit net');
    await userEvent.click(
      screen.getByRole('button', { name: /Save as saved script/i }),
    );
    await waitFor(() => {
      const post = scriptCalls.find((c) => c.method === 'POST');
      expect(post).toBeTruthy();
      const body = post!.body as { title: string; body: string; category: string };
      expect(body.title).toBe('My library entry');
      expect(body.body).toBe('Body to save');
      expect(body.category).toBe('weekly');
    });
    expect(screen.getByTestId('save-script-status').textContent).toMatch(
      /Saved as/,
    );
    promptSpy.mockRestore();
  });
});
