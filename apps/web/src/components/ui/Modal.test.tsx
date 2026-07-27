import React, { useId, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal.js';

/**
 * Two stacked dialogs, mirroring NetEditModal: the outer one holds an
 * in-progress form and stays mounted while a nested picker is open.
 */
function StackedDialogs() {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const draftId = useId();
  return (
    <>
      <Modal open={outerOpen} onClose={() => setOuterOpen(false)} title="Edit net">
        <label htmlFor={draftId}>Script draft</label>
        <input
          id={draftId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" onClick={() => setInnerOpen(true)}>
          Use saved script
        </button>
      </Modal>
      <Modal open={innerOpen} onClose={() => setInnerOpen(false)} title="Use a saved script">
        <button type="button">Use this script</button>
      </Modal>
    </>
  );
}

function TriggerAndModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open editor
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Editor">
        <button type="button">Alpha</button>
        <button type="button">Omega</button>
      </Modal>
    </>
  );
}

describe('Modal dialog semantics', () => {
  it('exposes role=dialog, aria-modal and a name from the header title', () => {
    render(
      <Modal open onClose={() => {}} title="Edit net">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit net' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('names the dialog from a caller-supplied titleId', () => {
    render(
      <Modal open onClose={() => {}} titleId="my-title">
        <h2 id="my-title">Edit check-in</h2>
      </Modal>,
    );
    expect(
      screen.getByRole('dialog', { name: 'Edit check-in' }),
    ).toBeInTheDocument();
  });

  it('keeps the close button in the accessibility tree with a readable name', async () => {
    // Regression: the header was `aria-hidden`, which removed the dialog's
    // only close control from the a11y tree (axe aria-hidden-focus, Serious).
    // `getByRole` ignores aria-hidden subtrees, so this query is the assertion.
    const user = userEvent.setup();
    let closed = 0;
    render(
      <Modal open onClose={() => { closed += 1; }} titleId="t">
        <h2 id="t">No header title</h2>
      </Modal>,
    );
    const close = screen.getByRole('button', { name: 'Close dialog' });
    await user.click(close);
    expect(closed).toBe(1);
  });
});

describe('Modal Escape handling', () => {
  it('closes the dialog on Escape', async () => {
    const user = userEvent.setup();
    let closed = 0;
    render(
      <Modal open onClose={() => { closed += 1; }} title="Editor">
        <button type="button">Alpha</button>
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(closed).toBe(1);
  });

  it('closes only the innermost dialog and preserves the outer form state', async () => {
    // P1-10: every Modal listened on `window`, so one Escape fired every open
    // modal's onClose and took the unsaved net script down with the picker.
    const user = userEvent.setup();
    render(<StackedDialogs />);

    await user.type(screen.getByLabelText('Script draft'), 'CQ CQ CQ');
    await user.click(screen.getByRole('button', { name: 'Use saved script' }));
    expect(
      screen.getByRole('dialog', { name: 'Use a saved script' }),
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Use a saved script' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: 'Edit net' })).toBeInTheDocument();
    expect(screen.getByLabelText('Script draft')).toHaveValue('CQ CQ CQ');
  });

  it('hands Escape back to the outer dialog once the inner one is gone', async () => {
    const user = userEvent.setup();
    render(<StackedDialogs />);
    await user.click(screen.getByRole('button', { name: 'Use saved script' }));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Use a saved script' }),
      ).not.toBeInTheDocument();
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit net' })).not.toBeInTheDocument();
    });
  });
});

describe('Modal focus management', () => {
  it('focuses the first meaningful control, not the [ESC] chip', async () => {
    render(
      <Modal open onClose={() => {}} title="Editor">
        <button type="button">Alpha</button>
        <button type="button">Omega</button>
      </Modal>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveFocus();
    });
  });

  it('leaves focus where the content put it with autoFocus', async () => {
    render(
      <Modal open onClose={() => {}} title="Edit check-in">
        <label htmlFor="cs">Callsign</label>
        {/* Mirrors EditCheckInModal's autoFocus callsign field. */}
        <input id="cs" autoFocus />
        <button type="button">Save</button>
      </Modal>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Callsign')).toHaveFocus();
    });
    // And it must still be there after the deferred trap focus would have run.
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.getByLabelText('Callsign')).toHaveFocus();
  });

  it('traps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Modal open onClose={() => {}} title="Editor">
        <button type="button">Alpha</button>
        <button type="button">Omega</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Editor' });
    const close = within(dialog).getByRole('button', { name: 'Close dialog' });
    const omega = within(dialog).getByRole('button', { name: 'Omega' });

    // Tab off the last control wraps to the first (the [ESC] chip).
    omega.focus();
    await user.tab();
    expect(close).toHaveFocus();

    // Shift-Tab off the first control wraps back to the last.
    await user.tab({ shift: true });
    expect(omega).toHaveFocus();
  });

  it('returns focus to the element that opened the dialog', async () => {
    const user = userEvent.setup();
    render(<TriggerAndModal />);
    const trigger = screen.getByRole('button', { name: 'Open editor' });
    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveFocus();
    });
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});
