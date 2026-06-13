import React, { useEffect, useId, useRef } from 'react';
import './ui.css';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 'default' caps at ~560px (login/confirm); 'wide' stretches near full-screen for editors. */
  size?: 'default' | 'wide';
  /** Optional id of the element naming the dialog (mirrors as `aria-labelledby`). */
  titleId?: string;
  /** Optional visible title to render in the instrument-panel header bar. */
  title?: React.ReactNode;
}

/**
 * Calibrated console modal.
 *
 * Visual: dark backdrop (light blur), 2px outer border, amber corner brackets,
 * and an instrument-panel header bar across the top with a `▮▮▮` marker, the
 * (optional) title in Big Shoulders Display, and an `[ESC]` close chip.
 *
 * Accessibility:
 *   - Escape key closes (preserved).
 *   - Backdrop click closes — but only if the user's mousedown didn't originate
 *     inside the dialog (prevents accidental discard on drag-select).
 *   - Focus trap while open; on close, focus returns to the previously-focused
 *     element.
 *   - `aria-labelledby` is wired automatically when `title` is provided
 *     (internally generated id) or when an explicit `titleId` is passed.
 */
export function Modal({
  open,
  onClose,
  size = 'default',
  titleId,
  title,
  children,
}: React.PropsWithChildren<ModalProps>) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const mouseDownInsideRef = useRef(false);
  const autoTitleId = useId();
  const effectiveTitleId = titleId ?? (title ? autoTitleId : undefined);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap + return-focus
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Defer until rendered
    const t = window.setTimeout(() => {
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusables[0] ?? root;
      first.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === 'function') {
        try {
          prev.focus();
        } catch {
          /* prev may have unmounted */
        }
      }
    };
  }, [open]);

  if (!open) return null;
  const cls = size === 'wide' ? 'hna-modal hna-modal--wide' : 'hna-modal';

  return (
    <div
      className="hna-modal-backdrop"
      onMouseDown={(e) => {
        // Track whether the press started inside the dialog so a release on
        // the backdrop after a drag-select does not close the modal.
        mouseDownInsideRef.current = !!(
          dialogRef.current && e.target instanceof Node && dialogRef.current.contains(e.target)
        );
      }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && !mouseDownInsideRef.current) {
          onClose();
        }
        mouseDownInsideRef.current = false;
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={cls}
        role="dialog"
        aria-modal="true"
        aria-labelledby={effectiveTitleId}
        tabIndex={-1}
      >
        <div className="hna-modal-header" aria-hidden={title ? undefined : true}>
          <span className="hna-modal-header__marker" aria-hidden="true" />
          {title ? (
            <span
              id={effectiveTitleId}
              className="hna-modal-header__title"
            >
              {title}
            </span>
          ) : (
            <span className="hna-modal-header__title" />
          )}
          <button
            type="button"
            className="hna-modal-close"
            onClick={onClose}
            aria-label="Close dialog (Escape)"
          >
            [ ESC ]
          </button>
        </div>
        {children}
        <span className="hna-modal-corner-bl" aria-hidden="true" />
        <span className="hna-modal-corner-br" aria-hidden="true" />
      </div>
    </div>
  );
}
