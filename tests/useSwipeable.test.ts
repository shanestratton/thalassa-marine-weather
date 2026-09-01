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

describe('the release latch, under a simulated thumb', () => {
    const fire = (el: HTMLElement, type: string, x: number, y: number) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: [{ clientX: x, clientY: y }] });
        el.dispatchEvent(ev);
    };

    const attach = () => {
        const { result } = renderHook(() => useSwipeable());
        const el = document.createElement('div');
        act(() => result.current.ref(el));
        return { result, el };
    };

    it('a quick 28px flick latches open instead of snapping shut', () => {
        // The July half-threshold fix (40px) still ate natural flicks: the
        // button showed under the finger and vanished on release (Shane
        // 2026-09-01: "as soon as i release my finger it disappears").
        const { result, el } = attach();
        act(() => {
            fire(el, 'touchstart', 200, 100);
            fire(el, 'touchmove', 190, 100); // locks horizontal
            fire(el, 'touchmove', 172, 100); // 28px reveal
            fire(el, 'touchend', 172, 100);
        });
        expect(result.current.swipeOffset).toBe(80); // settled fully open
    });

    it('a 10px brush still closes — the latch is deliberate-only', () => {
        const { result, el } = attach();
        act(() => {
            fire(el, 'touchstart', 200, 100);
            fire(el, 'touchmove', 192, 100);
            fire(el, 'touchmove', 190, 100);
            fire(el, 'touchend', 190, 100);
        });
        expect(result.current.swipeOffset).toBe(0);
    });

    it('an OS touchcancel mid-reveal latches like a lift, never strands shut', () => {
        const { result, el } = attach();
        act(() => {
            fire(el, 'touchstart', 200, 100);
            fire(el, 'touchmove', 190, 100);
            fire(el, 'touchmove', 170, 100); // 30px showing
            fire(el, 'touchcancel', 170, 100);
        });
        expect(result.current.swipeOffset).toBe(80);
    });
});

describe('listener stability under re-render — the dead-swipe regression', () => {
    it('re-renders with a fresh inline onSwipeComplete must NOT reattach listeners', () => {
        // Every consumer passes `onSwipeComplete: () => …` inline, so every
        // render mints a new callback identity. The ref callback used to
        // depend (transitively) on it, so React detached and reattached the
        // touch listeners on EVERY swipeOffset frame — and iOS drops a touch
        // sequence whose listeners churn mid-gesture: the swipe went dead
        // app-wide (diary + binder lists, 2026-09-02).
        const el = document.createElement('div');
        const adds: string[] = [];
        const removes: string[] = [];
        const origAdd = el.addEventListener.bind(el);
        const origRemove = el.removeEventListener.bind(el);
        el.addEventListener = ((type: string, ...rest: unknown[]) => {
            adds.push(type);
            (origAdd as (...a: unknown[]) => void)(type, ...rest);
        }) as typeof el.addEventListener;
        el.removeEventListener = ((type: string, ...rest: unknown[]) => {
            removes.push(type);
            (origRemove as (...a: unknown[]) => void)(type, ...rest);
        }) as typeof el.removeEventListener;

        const { result, rerender } = renderHook(() => {
            // Inline arrow exactly as SwipeableDiaryCard does it.
            return useSwipeable({ onSwipeComplete: () => {} });
        });
        act(() => result.current.ref(el));
        const addsAfterAttach = adds.length;

        // Simulate the mid-gesture frames: state-driven re-renders.
        rerender();
        rerender();
        rerender();

        expect(adds.length).toBe(addsAfterAttach);
        expect(removes.length).toBe(0);
        // And the ref callback identity itself is stable across renders.
        const refBefore = result.current.ref;
        rerender();
        expect(result.current.ref).toBe(refBefore);
    });
});
