import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScriptImportModal } from './ScriptImportModal.js';

describe('ScriptImportModal error reporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces a failed URL import in an alert region', async () => {
    // A failed fetch leaves the dialog visually unchanged apart from this
    // line — without role="alert" nothing tells the user the import died.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'BAD_REQUEST', message: 'Could not fetch that document' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(
      <ScriptImportModal open onClose={() => {}} onImport={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'From URL' }));
    await userEvent.type(
      screen.getByPlaceholderText(/docs\.google\.com/i),
      'https://example.test/doc',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fetch' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not fetch that document');
    expect(alert).toHaveClass('hna-form-error');
  });
});
