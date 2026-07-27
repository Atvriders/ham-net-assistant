import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RegisterInput } from '@hna/shared';
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

/**
 * The password floor lives in @hna/shared and is enforced by the API. If the
 * form's own `minLength` drifts below it, the browser lets a short password
 * through and the only feedback the user gets is a generic 400 from the server
 * — so this asserts the two agree, reading the real bound out of the schema
 * rather than hard-coding 12 in a second place.
 */
describe('RegisterPage password rule', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The `min` bound declared on RegisterInput.password: the shortest length the
   * schema accepts. Probed rather than hard-coded so this test keeps following
   * the schema if the floor is ever raised. Capped at 128, the schema's max.
   */
  function sharedPasswordMin(): number {
    for (let n = 1; n <= 128; n += 1) {
      if (RegisterInput.shape.password.safeParse('a'.repeat(n)).success) return n;
    }
    throw new Error('RegisterInput.password rejected every length from 1 to 128');
  }

  it('matches the shared schema floor so the browser blocks what the API would reject', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderPage();
    // Step 1 -> step 2: the unlicensed path needs no callsign lookup.
    await userEvent.click(
      await screen.findByRole('button', { name: /Continue without callsign/ }),
    );
    const password = await screen.findByLabelText('Password');
    await waitFor(() => expect(password).toHaveAttribute('minLength'));

    const min = sharedPasswordMin();
    expect(min).toBeGreaterThan(1); // guard against a schema that lost its floor
    expect(Number(password.getAttribute('minLength'))).toBe(min);

    // And the rule is stated in text, not left to the browser's default popup.
    expect(password).toHaveAccessibleDescription(new RegExp(`${min} characters`));
  });
});
