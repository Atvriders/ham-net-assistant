import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogImportModal } from './LogImportModal.js';

describe('LogImportModal error reporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces a rejected import in an alert region', async () => {
    // Historical-log imports are long-running and destructive-adjacent; a
    // silent failure reads exactly like a successful no-op.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/api/nets')) return json([{ id: 'n1', name: 'Tuesday Net' }]);
        return json(
          { error: { code: 'BAD_REQUEST', message: 'Log text is empty' } },
          400,
        );
      }),
    );
    render(<LogImportModal open onClose={() => {}} onImported={() => {}} />);

    const importButton = await screen.findByRole('button', { name: 'Import' });
    await userEvent.click(importButton);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Log text is empty');
    expect(alert).toHaveClass('hna-form-error');
  });
});
