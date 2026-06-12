import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { TopicsPage } from './TopicsPage.js';

const member = {
  id: 'u1',
  callsign: 'KA1ABC',
  name: 'Mem',
  email: 'm@x.co',
  role: 'MEMBER',
};

interface TopicRow {
  id: string;
  title: string;
  details: string | null;
  status: 'OPEN' | 'USED' | 'DISMISSED';
  createdById: string;
  createdByCallsign: string;
  createdByName: string;
  createdAt: string;
}

function topicRow(over: Partial<TopicRow>): TopicRow {
  return {
    id: 't1',
    title: 'Sample topic',
    details: null,
    status: 'OPEN',
    createdById: 'u1',
    createdByCallsign: 'KA1ABC',
    createdByName: 'Mem',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...over,
  };
}

function mockFetch(topics: TopicRow[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) return json(member);
    if (url.endsWith('/presence/heartbeat')) return json({});
    if (url.endsWith('/topics')) return json(topics);
    return json([]);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <TopicsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('TopicsPage empty state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders an empty-state Card when there are no topics', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText('No topic suggestions yet'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Propose one with the form above/),
    ).toBeInTheDocument();
  });

  it('replaces the empty state with the list once topics arrive', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([topicRow({ id: 't1', title: 'Antenna tuning' })]),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Antenna tuning')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('No topic suggestions yet'),
    ).not.toBeInTheDocument();
  });
});
