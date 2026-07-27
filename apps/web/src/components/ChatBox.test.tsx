import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../auth/AuthProvider.js';
import { ChatBox } from './ChatBox.js';

const SESSION_ID = 's-current';

function makeMessage(over: Partial<{
  id: string;
  sessionId: string;
  body: string;
  callsign: string;
  nameAtMessage: string;
  userId: string | null;
  createdAt: string;
}>) {
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2)}`,
    sessionId: over.sessionId ?? SESSION_ID,
    userId: over.userId ?? null,
    callsign: over.callsign ?? 'W1AW',
    nameAtMessage: over.nameAtMessage ?? 'Op',
    body: over.body ?? 'hi',
    createdAt: over.createdAt ?? new Date().toISOString(),
    reactions: [],
  };
}

function mockFetch(
  messages: ReturnType<typeof makeMessage>[],
  onPost?: (body: string) => void,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (
      url.endsWith(`/api/sessions/${SESSION_ID}/messages`) &&
      init?.method === 'POST'
    ) {
      const parsed = JSON.parse(String(init.body)) as { body: string };
      onPost?.(parsed.body);
      messages.push(makeMessage({ body: parsed.body }));
      return json(messages[messages.length - 1]);
    }
    if (url.endsWith('/auth/me'))
      return json({
        id: 'u1',
        callsign: 'W1AW',
        name: 'Op',
        email: 'o@x.co',
        role: 'OFFICER',
      });
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/discord/status')) return json({ enabled: false });
    if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) return json(messages);
    return json([]);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatBox 24h backfill', () => {
  it('renders backfill messages before the current-session messages and shows the divider', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const messages = [
      makeMessage({ id: 'b1', sessionId: 'prev', body: 'old context', createdAt: past }),
      makeMessage({ id: 'c1', sessionId: SESSION_ID, body: 'first live', createdAt: now }),
    ];
    vi.stubGlobal('fetch', mockFetch(messages));

    render(
      <AuthProvider>
        <ChatBox sessionId={SESSION_ID} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('old context')).toBeInTheDocument();
    });
    expect(screen.getByText('first live')).toBeInTheDocument();
    expect(screen.getByTestId('net-started-divider')).toBeInTheDocument();

    // Backfill bubble appears before the live bubble in DOM order.
    const backfill = screen.getByText('old context');
    const live = screen.getByText('first live');
    expect(
      backfill.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('scrolls the chat list to the bottom on initial render', async () => {
    // Make the JSDOM elements report a non-zero scrollHeight so we can verify
    // the effect set scrollTop = scrollHeight on the list container.
    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return 1000; },
    });
    const messages = [
      makeMessage({ id: 'b1', sessionId: 'prev', body: 'old', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
      makeMessage({ id: 'c1', sessionId: SESSION_ID, body: 'live', createdAt: new Date().toISOString() }),
    ];
    vi.stubGlobal('fetch', mockFetch(messages));

    const { container } = render(
      <AuthProvider>
        <ChatBox sessionId={SESSION_ID} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('live')).toBeInTheDocument();
    });

    // The scrollable list container is the only descendant with overflowY:auto
    // that hosts the message bubbles; locate via the divider's parent.
    const divider = screen.getByTestId('net-started-divider');
    const list = divider.parentElement as HTMLDivElement;
    expect(list).toBeTruthy();
    expect(list.scrollTop).toBe(list.scrollHeight);
    expect(container).toBeTruthy();
  });

  it('omits the divider when there is no backfill', async () => {
    const messages = [
      makeMessage({ id: 'c1', sessionId: SESSION_ID, body: 'just current' }),
    ];
    vi.stubGlobal('fetch', mockFetch(messages));

    render(
      <AuthProvider>
        <ChatBox sessionId={SESSION_ID} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('just current')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('net-started-divider')).not.toBeInTheDocument();
  });
});

/**
 * Compose-box focus.
 *
 * The compose textarea is `disabled` while a send is in flight, and a browser
 * moves focus to <body> when the focused element becomes disabled — so
 * Enter-to-send worked for the first message of a net and then went dead until
 * the operator clicked back into the box. jsdom does NOT reproduce that blur,
 * so these tests hold the POST open, blur the box themselves (standing in for
 * the browser), and only then let the request settle. Without the restore in
 * ChatBox they fail; with it, focus comes back.
 */
describe('ChatBox compose focus', () => {
  /** A fetch mock whose POST resolves only when the returned `release` runs. */
  function gatedFetch(response: () => Response, onPost?: (body: string) => void) {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me'))
        return json({
          id: 'u1',
          callsign: 'W1AW',
          name: 'Op',
          email: 'o@x.co',
          role: 'OFFICER',
        });
      if (url.endsWith('/presence/heartbeat')) return json({});
      if (url.endsWith('/discord/status')) return json({ enabled: false });
      if (init?.method === 'POST') {
        onPost?.((JSON.parse(String(init.body)) as { body: string }).body);
        await gate;
        return response();
      }
      return json([]);
    });
    return { fetchMock, release: () => release() };
  }

  it('returns focus to the compose box after a send so Enter keeps working', async () => {
    const sent: string[] = [];
    const { fetchMock, release } = gatedFetch(
      () =>
        new Response(JSON.stringify(makeMessage({ body: 'first' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      (b) => sent.push(b),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <ChatBox sessionId={SESSION_ID} />
      </AuthProvider>,
    );

    const box = await screen.findByLabelText('New chat message');
    await userEvent.click(box);
    await userEvent.type(box, 'first{Enter}');
    await waitFor(() => expect(sent).toEqual(['first']));
    // Stand in for the browser moving focus off the newly-disabled textarea
    // (jsdom keeps it there; a real browser hands focus to <body>).
    await waitFor(() => expect(box).toBeDisabled());
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).not.toBe(box);

    release();
    await waitFor(() => expect(document.activeElement).toBe(box));

    // …and the next Enter-send lands without clicking back into the box.
    await userEvent.keyboard('second{Enter}');
    await waitFor(() => expect(sent).toEqual(['first', 'second']));
  });

  it('returns focus after a FAILED send so the operator can retry the same text', async () => {
    const { fetchMock, release } = gatedFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'Send failed' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <ChatBox sessionId={SESSION_ID} />
      </AuthProvider>,
    );

    const box = await screen.findByLabelText('New chat message');
    await userEvent.click(box);
    await userEvent.type(box, 'oops{Enter}');
    await waitFor(() => expect(box).toBeDisabled());
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('Send failed');
    await waitFor(() => expect(document.activeElement).toBe(box));
    // The text survives, so the retry is one keystroke away.
    expect(box).toHaveValue('oops');
  });
});
