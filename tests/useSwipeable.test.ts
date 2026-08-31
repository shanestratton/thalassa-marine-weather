/**
 * Tests for useSwipeable hook
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSwipeable } from '../hooks/useSwipeable';

describe('useSwipeable', () => {
    it('initialises with zero offset and not swiping', () => {
        const { result } = renderHook(() => useSwipeable());
        expect(result.current.swipeOffset).toBe(0);
        expect(result.current.isSwiping).toBe(false);
    });

    it('exposes touch handlers', () => {
        const { result } = renderHook(() => useSwipeable());
        expect(result.current.handlers.onTouchStart).toBeDefined();
        expect(result.current.handlers.onTouchMove).toBeDefined();
        expect(result.current.handlers.onTouchEnd).toBeDefined();
    });

    it('accepts custom threshold', () => {
        const { result } = renderHook(() => useSwipeable({ threshold: 120 }));
        // Should not throw
        expect(result.current.swipeOffset).toBe(0);
    });

    it('resetSwipe returns offset to zero', () => {
        const { result } = renderHook(() => useSwipeable());
        act(() => result.current.resetSwipe());
        expect(result.current.swipeOffset).toBe(0);
    });

    it('handlers are stable references (no unnecessary re-renders)', () => {
        const { result, rerender } = renderHook(() => useSwipeable());
        const first = result.current.handlers;
        rerender();
        const second = result.current.handlers;
        // onTouchStart should be memoized
        expect(first.onTouchStart).toBe(second.onTouchStart);
    });
});

describe('gesture ownership', () => {
    it('declares touch-action: pan-y on the element it attaches to', () => {
        // Newer iOS WKWebViews arbitrate pans before a non-passive touchmove
        // fires; without this declaration the horizontal swipe loses and the
        // release lands as an entry-opening tap (diary list, 2026-09-01).
        const { result } = renderHook(() => useSwipeable());
        const el = document.createElement('div');
        act(() => result.current.ref(el));
        expect(el.style.touchAction).toBe('pan-y');
    });
});
