import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmModal } from './ConfirmModal.js';

describe('ConfirmModal', () => {
  it('names the dialog and exposes both actions to assistive tech', () => {
    render(
      <ConfirmModal
        open
        title="Delete saved script"
        message='Delete saved script "Opening"?'
        confirmLabel="Delete"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByRole('dialog', { name: 'Delete saved script' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // The close control must be reachable, not buried in an aria-hidden header.
    expect(
      screen.getByRole('button', { name: 'Close dialog' }),
    ).toBeInTheDocument();
  });

  it('parks initial focus on Cancel for a destructive confirm', async () => {
    // Now that Modal honours autoFocus, focusing "Delete" would let a stray
    // Enter destroy the record with no undo.
    render(
      <ConfirmModal
        open
        message="Delete this net?"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
  });

  it('parks initial focus on the proceed button when not destructive', async () => {
    render(
      <ConfirmModal
        open
        destructive={false}
        message="Publish this script?"
        confirmLabel="Publish"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
    });
  });

  it('closes on Escape without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmModal
        open
        message="Delete this net?"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
