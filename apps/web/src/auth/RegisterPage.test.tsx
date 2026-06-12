import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './AuthProvider.js';
import { RegisterPage } from './RegisterPage.js';

function makeFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/auth/me')) {
      return json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    }
    if (url.endsWith('/auth/config')) return json({ inviteCodeRequired: false });
    return json({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RegisterPage step 1', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces both licensed and unlicensed choices as equally-weighted buttons', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderPage();
    const licensed = screen.getByRole('button', {
      name: /Continue with callsign/,
    });
    const unlicensed = screen.getByRole('button', {
      name: /Continue without callsign/,
    });
    // Both must be present and interactive (enabled) on initial load.
    expect(licensed).toBeInTheDocument();
    expect(unlicensed).toBeInTheDocument();
    expect(licensed).toBeEnabled();
    expect(unlicensed).toBeEnabled();
    // Both should be primary buttons (no secondary/danger variant class).
    expect(licensed.className).not.toMatch(/secondary|danger/);
    expect(unlicensed.className).not.toMatch(/secondary|danger/);
    // Both choice cards' headings must be visible.
    expect(screen.getByText('I have a callsign')).toBeInTheDocument();
    expect(screen.getByText("I'm not licensed yet")).toBeInTheDocument();
  });
});
