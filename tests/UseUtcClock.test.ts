/**
 * The emergency console's UTC clock must tick (audit 2026-09-02): it used
 * to be a render-time `new Date()` with nothing to re-render it.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUtcClock } from '../hooks/useUtcClock';

describe('useUtcClock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-02T03:04:05Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('reads HH:MM:SS UTC and advances every second without a re-render from outside', () => {
        const { result } = renderHook(() => useUtcClock());
        expect(result.current).toBe('03:04:05');
        act(() => vi.advanceTimersByTime(1000));
        expect(result.current).toBe('03:04:06');
        act(() => vi.advanceTimersByTime(54_000));
        expect(result.current).toBe('03:05:00');
    });

    it('clears its interval on unmount', () => {
        const spy = vi.spyOn(globalThis, 'clearInterval');
        const { unmount } = renderHook(() => useUtcClock());
        unmount();
        expect(spy).toHaveBeenCalled();
    });
});
