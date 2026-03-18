/**
 * useReducedMotion — Unit tests for reduced-motion accessibility hook
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from '../../hooks/useReducedMotion';

// Track listeners for manual dispatch
let changeCallback: ((e: MediaQueryListEvent) => void) | null = null;

function mockMatchMedia(matches: boolean) {
    const mql = {
        matches,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
            changeCallback = cb;
        }),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
    };
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockReturnValue(mql),
    });
    return mql;
}

afterEach(() => {
    vi.restoreAllMocks();
    changeCallback = null;
});

describe('useReducedMotion', () => {
    it('returns false when no reduced-motion preference', () => {
        mockMatchMedia(false);
        const { result } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(false);
    });

    it('returns true when user prefers reduced motion', () => {
        mockMatchMedia(true);
        const { result } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(true);
    });

    it('updates when preference changes', () => {
        mockMatchMedia(false);
        const { result } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(false);

        // Simulate OS settings change
        act(() => {
            changeCallback?.({ matches: true } as MediaQueryListEvent);
        });
        expect(result.current).toBe(true);
    });

    it('cleans up listener on unmount', () => {
        const mql = mockMatchMedia(false);
        const { unmount } = renderHook(() => useReducedMotion());
        unmount();
        expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });
});
