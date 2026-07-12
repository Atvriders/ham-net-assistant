import { useCallback, useState } from 'react';
import { errorMessage } from '../api/client.js';

export interface AsyncAction<A extends unknown[]> {
  /** Invoke the wrapped mutation. Re-entrant calls (while a previous run is
   *  still pending) are ignored, so a double-click can't double-fire. */
  run: (...args: A) => Promise<void>;
  /** True while a run is in flight — wire this to the trigger's `disabled`. */
  pending: boolean;
  /** The last failure's message, or null. Surface it near the control. */
  error: string | null;
  /** Clear the surfaced error (e.g. when re-opening a modal). */
  reset: () => void;
  /** Set the error directly (for caller-side validation messages). */
  setError: (message: string | null) => void;
}

/**
 * Wrap an async mutation with the three guards every console action needs, so
 * a slow or failed request can never look like "nothing happened → click
 * again" (the root cause of the reported "three clicks to end a net" bug):
 *
 *   (a) an in-flight `pending` flag that both blocks re-entry *and* is meant to
 *       drive `disabled` on the triggering button, and
 *   (b) a captured `error` string surfaced to the operator instead of a
 *       swallowed unhandled promise rejection, and
 *   (c) success side-effects (navigate / close a modal / refresh) live inside
 *       the wrapped fn, so they run only after it resolves — reflected exactly
 *       once, never on a merely-slow-then-abandoned attempt.
 *
 * Mirrors the ergonomics `startNet` / `ChatBox.send` already prove out; needs
 * no change to `Button`'s API since native `disabled` already blocks clicks.
 *
 * @example
 *   const end = useAsyncAction(async () => {
 *     await apiFetch(`/sessions/${id}`, { method: 'PATCH', body });
 *     nav(`/sessions/${id}/summary`);
 *   });
 *   <Button disabled={end.pending} onClick={() => void end.run()}>
 *     {end.pending ? 'Ending…' : 'End net'}
 *   </Button>
 *   {end.error && <span className="hna-input-error" role="alert">{end.error}</span>}
 */
export function useAsyncAction<A extends unknown[] = []>(
  fn: (...args: A) => Promise<void>,
): AsyncAction<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: A) => {
      // (a) re-entrancy guard — a genuine double-click is two discrete events
      // with a state flush between them, so `pending` is already true on the
      // second; the trigger's `disabled={pending}` blocks it at the DOM too.
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        await fn(...args);
      } catch (e) {
        // (b) surface the API's message (or a generic fallback) instead of
        // letting the rejection vanish as an unhandled promise rejection.
        setError(errorMessage(e));
      } finally {
        setPending(false);
      }
    },
    [fn, pending],
  );

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset, setError };
}
