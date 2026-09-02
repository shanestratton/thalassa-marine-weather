/**
 * The "you're offshore now" flag fires ONCE per crossing and clears after 5 s.
 *
 * It used to `return` out of the effect before recording the previous state,
 * so while the boat stayed offshore every re-render looked like a fresh
 * crossing: the toast re-armed forever (audit 2026-09-02).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOffshoreStatus } from '../hooks/useOffshoreStatus';

type Loc = 'inshore' | 'coastal' | 'offshore' | 'inland';

describe('useOffshoreStatus crossing flag', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('raises on the crossing, clears after 5 s, and stays clear while still offshore', () => {
        const { result, rerender } = renderHook(({ loc }: { loc: Loc }) => useOffshoreStatus(loc), {
            initialProps: { loc: 'coastal' as Loc },
        });
        expect(result.current.justCrossed).toBe(false);

        act(() => rerender({ loc: 'offshore' }));
        expect(result.current.justCrossed).toBe(true);

        act(() => vi.advanceTimersByTime(5_000));
        expect(result.current.justCrossed).toBe(false);

        // Still offshore, unrelated re-renders: must NOT re-fire.
        act(() => rerender({ loc: 'offshore' }));
        act(() => rerender({ loc: 'offshore' }));
        expect(result.current.justCrossed).toBe(false);

        // Back inshore, then out again: fires again — it is per crossing.
        act(() => rerender({ loc: 'coastal' }));
        act(() => rerender({ loc: 'offshore' }));
        expect(result.current.justCrossed).toBe(true);
    });
});
