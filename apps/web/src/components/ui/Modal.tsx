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

/**
 * Stack of currently-open modals, innermost last.
 *
 * Every Modal binds its key handler to `window`, and `stopPropagation()` does
 * nothing between listeners registered on the *same* target. Before this
 * stack existed, one Escape press inside a nested dialog fired **every** open
 * modal's `onClose`: in the net editor that closed the script picker *and*
 * the editor holding an unsaved script, destroying the operator's work with
 * no undo. Gating on "am I the top of the stack" makes the intended
 * innermost-wins behaviour explicit instead of relying on event plumbing that
 * cannot deliver it.
 */
const modalStack: object[] = [];

/**
 * Is `el` actually reachable by a user right now?
 *
 * The previous check was `el.offsetParent !== null`, which is layout-derived
 * and therefore *always* null under jsdom — the focus trap silently believed
 * every dialog was empty in tests, so the behaviour could never be covered.
 * `getComputedStyle` + `hidden` works in a real browser and in jsdom.
 */
function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.closest('[hidden]')) return false;
  const style =
    typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(el)
      : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) {
    return false;
  }
  return true;
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && isVisible(el),
  );
}

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
 *   - `role="dialog"` + `aria-modal="true"`, named through `aria-labelledby`
 *     (generated id when `title` is given, or the caller's `titleId`).
 *   - Escape closes — but only the topmost dialog (see `modalStack`).
 *   - Backdrop click closes — but only if the user's mousedown didn't originate
 *     inside the dialog (prevents accidental discard on drag-select).
 *   - Focus trap while open: Tab / Shift-Tab cycle within the dialog.
 *   - Initial focus lands on the first *meaningful* control rather than the
 *     `[ESC]` chip, and content that claimed focus itself (React `autoFocus`)
 *     keeps it.
 *   - On close, focus returns to the element that opened the dialog.
 *
 * The header bar is decorative chrome, but it holds the only close button, so
 * it must never be `aria-hidden`: marking it hidden dropped that button out of
 * the accessibility tree (axe `aria-hidden-focus`, Serious) and left
 * screen-reader users in a dialog with no announced way out. Only the purely
 * ornamental marker / corner spans carry `aria-hidden`.
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
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const mouseDownInsideRef = useRef(false);
  // Identity for this modal's slot in `modalStack` — a ref so the entry keeps
  // the same identity across re-renders.
  const tokenRef = useRef<object>({});
  const autoTitleId = useId();
  const effectiveTitleId = titleId ?? (title ? autoTitleId : undefined);

  // Call sites pass inline arrows, so `onClose` changes identity on every
  // parent render. Reading it through a ref keeps it out of the key-handler
  // effect's dependency list — otherwise each render would pop and re-push
  // this modal, reordering the stack and potentially floating an *outer*
  // dialog above the nested one the user is actually looking at.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Stack registration + Escape / focus-trap key handling.
  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;
    modalStack.push(token);
    const isTopmost = () => modalStack[modalStack.length - 1] === token;

    const onKey = (e: KeyboardEvent) => {
      // A dialog underneath another one is inert: neither Escape nor the Tab
      // trap belongs to it while something is stacked on top.
      if (!isTopmost()) return;

      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const root = dialogRef.current;
      if (!root) return;
      const focusables = getFocusable(root);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (!root.contains(active)) {
        // Focus escaped the dialog (e.g. the focused control unmounted and the
        // browser fell back to <body>) — pull it back in instead of letting
        // Tab wander into the page behind the modal.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = modalStack.lastIndexOf(token);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, [open]);

  // Initial focus + return-focus.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Deferred so the dialog subtree has mounted and React has applied any
    // `autoFocus` in the content.
    const t = window.setTimeout(() => {
      const root = dialogRef.current;
      if (!root) return;
      // Content that claimed focus for itself wins. Overriding it yanked
      // callers like EditCheckInModal's `autoFocus` callsign field back onto
      // the `[ESC]` chip.
      if (root.contains(document.activeElement)) return;
      // Skip the close chip: landing there tells a screen-reader user nothing
      // about the dialog's purpose. It stays in the Tab cycle.
      const meaningful = getFocusable(root).filter(
        (el) => el !== closeButtonRef.current,
      );
      (meaningful[0] ?? closeButtonRef.current ?? root).focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      const prev = previouslyFocused.current;
      const active = document.activeElement;
      // Only reclaim focus if this dialog's disappearance orphaned it. When
      // closing one modal immediately opens another (picker -> confirm), the
      // new dialog has already taken focus and stealing it back would strand
      // the user outside the dialog they can see.
      if (active && active !== document.body) return;
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
        <div className="hna-modal-header">
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
            ref={closeButtonRef}
            className="hna-modal-close"
            onClick={onClose}
          >
            {/* `[ ESC ]` is a keyboard hint, not a label — read aloud verbatim
                it names nothing, so the accessible name lives in the
                visually-hidden span instead. */}
            <span aria-hidden="true">[ ESC ]</span>
            <span className="sr-only">Close dialog</span>
          </button>
        </div>
        {children}
        <span className="hna-modal-corner-bl" aria-hidden="true" />
        <span className="hna-modal-corner-br" aria-hidden="true" />
      </div>
    </div>
  );
}
