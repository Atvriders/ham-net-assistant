import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function mockFetch(messages: ReturnType<typeof makeMessage>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
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
