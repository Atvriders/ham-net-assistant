import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetEditModal, netToInput } from './NetEditModal.js';
import type { NetWithRepeater } from './NetEditModal.js';

const repeaters = [
  { id: 'r1', name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
  { id: 'r2', name: 'R2', frequency: 147.0, offsetKhz: 600, mode: 'FM' },
];

const net: NetWithRepeater = {
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
  repeater: repeaters[0] as never,
  links: [],
} as never;

function mockFetch(onPatch: (body: unknown) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/repeaters')) return json(repeaters);
    if (url.endsWith('/api/nets/n1') && init?.method === 'PATCH') {
      onPatch(JSON.parse(String(init.body)));
      return json({ ...net });
    }
    return json([]);
  });
}

describe('NetEditModal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch(() => {}));
  });

  it('seeds the form with the existing net script for editing', async () => {
    render(
      <NetEditModal
        open
        netId="n1"
        initial={netToInput(net)}
        repeaters={repeaters as never}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(await screen.findByText('Edit net')).toBeInTheDocument();
    const scriptBox = screen.getByText('Script (markdown)')
      .closest('.hna-field')!
      .querySelector('textarea')!;
    expect(scriptBox).toHaveValue('Welcome to the net.');
  });

  it('groups the primary and linked repeaters under a Repeaters section', async () => {
    const linkedNet: NetWithRepeater = {
      ...net,
      links: [
        { id: 'l1', repeaterId: 'r2', repeater: repeaters[1] as never },
      ],
    } as never;
    render(
      <NetEditModal
        open
        netId="n1"
        initial={netToInput(linkedNet)}
        repeaters={repeaters as never}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const group = (await screen.findByText('Repeaters')).closest(
      'fieldset',
    )! as HTMLElement;
    const summary = group.querySelector('.hna-repeater-group-summary')!;
    expect(summary.textContent).toContain('Primary');
    expect(summary.textContent).toContain('R1 — 146.760 MHz');
    expect(summary.textContent).toContain('Linked');
    expect(summary.textContent).toContain('R2 — 147.000 MHz');
  });

  it('PATCHes /nets/:id with the edited script and calls onSaved', async () => {
    const patched: unknown[] = [];
    vi.stubGlobal('fetch', mockFetch((b) => patched.push(b)));
    const onSaved = vi.fn();
    render(
      <NetEditModal
        open
        netId="n1"
        initial={netToInput(net)}
        repeaters={repeaters as never}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    const scriptBox = (await screen.findByText('Script (markdown)'))
      .closest('.hna-field')!
      .querySelector('textarea')!;
    await userEvent.clear(scriptBox);
    await userEvent.type(scriptBox, 'Updated script body.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(patched).toHaveLength(1);
    expect((patched[0] as { scriptMd: string }).scriptMd).toBe(
      'Updated script body.',
    );
  });
});
