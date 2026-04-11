import { useEffect, useRef, useState, useCallback } from 'react';
import { apiFetch, ApiErrorException, isAbortError } from '../api/client.js';

interface Options {
  intervalMs?: number;
  enabled?: boolean;
}

interface Result<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Poll an API endpoint on an interval and expose the latest JSON response.
 *
 * - Aborts any in-flight request on unmount or when the path changes.
 * - Pauses polling when the browser tab is hidden; catches up on visibility.
 * - Skips setState when the fetched JSON is deep-equal (stringified) to the
 *   current state to avoid unnecessary React re-renders.
 * - After a local mutation, call the returned `refresh()` to update
 *   immediately without waiting for the next tick.
 */
export function useAutoFetch<T>(
  path: string | null,
  opts: Options = {},
): Result<T> {
  const { intervalMs = 5000, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const lastJsonRef = useRef<string>('');
  const visibleRef = useRef<boolean>(
    typeof document === 'undefined' ? true : !document.hidden,
  );

  const doFetch = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await apiFetch<T>(path, { signal: controller.signal });
      const json = JSON.stringify(result);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setData(result);
      }
      setError(null);
    } catch (e) {
      if (isAbortError(e) || (e as Error).name === 'AbortError') return;
      if (e instanceof ApiErrorException) setError(e.payload.message);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  // Initial fetch + when the path changes.
  useEffect(() => {
    setLoading(true);
    lastJsonRef.current = '';
    void doFetch();
  }, [doFetch]);

  // Interval polling.
  useEffect(() => {
    if (!enabled || !path) return;
    const tick = () => {
      if (visibleRef.current) void doFetch();
    };
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [doFetch, intervalMs, enabled, path]);

  // Visibility-aware: pause while hidden, catch up on return.
  useEffect(() => {
    const onVisibility = () => {
      visibleRef.current = !document.hidden;
      if (visibleRef.current) void doFetch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [doFetch]);

  // Cleanup any in-flight request on unmount.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  return { data, loading, error, refresh: doFetch };
}
