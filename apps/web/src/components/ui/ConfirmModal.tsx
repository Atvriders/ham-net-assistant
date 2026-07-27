import React from 'react';
import { Modal } from './Modal.js';
import { Button } from './Button.js';
import './ui.css';

export interface ConfirmModalProps {
  open: boolean;
  title?: React.ReactNode;
  /** Body content — the confirmation question. */
  message: React.ReactNode;
  /** Label for the destructive / proceed button. Default "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Default "Cancel". */
  cancelLabel?: string;
  /** When true, the confirm button takes the `danger` variant. Default true
   *  since most of our existing call sites are deletes. */
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Console-styled replacement for `window.confirm()`. Wraps `<Modal>` with
 * two buttons and a single line of body copy. Kept intentionally minimal
 * because the audit explicitly called for the *exact* legacy strings to be
 * preserved inside a real modal — callers pass them through verbatim as
 * `title` + `message`.
 */
export function ConfirmModal({
  open,
  title = 'Confirm',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 14,
          lineHeight: 1.5,
          color: 'var(--color-fg)',
          padding: 'var(--space-2) 0',
        }}
      >
        {message}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'var(--space-2)',
          marginTop: 'var(--space-4)',
          paddingTop: 'var(--space-3)',
          borderTop: '1px solid var(--color-border)',
        }}
      >
        {/*
          Initial focus goes to the *safe* action on a destructive confirm.
          Modal now honours `autoFocus` instead of overriding it with the
          [ESC] chip, so parking focus on "Delete" would make a stray Enter or
          Space — the keypress that opened this dialog, repeated — destroy the
          net, session or repeater with no undo. Non-destructive confirms keep
          focus on the proceed button, which is the expected default there.
        */}
        <Button variant="secondary" onClick={onClose} autoFocus={destructive}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          onClick={() => {
            onConfirm();
          }}
          autoFocus={!destructive}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
