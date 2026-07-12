import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsyncAction } from './useAsyncAction.js';
import { ApiErrorException } from '../api/client.js';

describe('useAsyncAction', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useAsyncAction(async () => {}));
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('is pending while the action runs and clears when it resolves', async () => {
    let resolve!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() => useAsyncAction(fn));

    act(() => {
      void result.current.run();
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    await act(async () => {
      resolve();
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('surfaces the API error message on failure and returns to idle', async () => {
    const fn = vi.fn(async () => {
      throw new ApiErrorException(500, { code: 'INTERNAL', message: 'boom' });
    });
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.pending).toBe(false);
  });

  it('ignores re-entrant calls while a run is in flight (no double-fire)', async () => {
    let resolve!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() => useAsyncAction(fn));

    act(() => {
      void result.current.run();
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    // A second call while the first is pending must be a no-op.
    await act(async () => {
      await result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
    });
  });

  it('reset() clears a surfaced error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('nope');
    });
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('nope');

    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
  });
});
