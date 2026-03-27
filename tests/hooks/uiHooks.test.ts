/**
 * Hook tests — useOnlineStatus, useDeviceMode, useSuccessFlash
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── useOnlineStatus ──────────────────────────────────────────
describe('useOnlineStatus', () => {
    beforeEach(() => {
        Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
    });

    it('returns true when online', async () => {
        const { useOnlineStatus } = await import('../../hooks/useOnlineStatus');
        const { result } = renderHook(() => useOnlineStatus());
        expect(result.current).toBe(true);
    });

    it('responds to offline event', async () => {
        const { useOnlineStatus } = await import('../../hooks/useOnlineStatus');
        const { result } = renderHook(() => useOnlineStatus());
        expect(result.current).toBe(true);

        act(() => {
            Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
            window.dispatchEvent(new Event('offline'));
        });
        expect(result.current).toBe(false);
    });

    it('responds to online event', async () => {
        Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
        const { useOnlineStatus } = await import('../../hooks/useOnlineStatus');
        const { result } = renderHook(() => useOnlineStatus());

        act(() => {
            Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
            window.dispatchEvent(new Event('online'));
        });
        expect(result.current).toBe(true);
    });
});

// ── useDeviceMode ──────────────────────────────────────────
describe('useDeviceMode', () => {
    it('returns helm for wide viewport', async () => {
        Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });

        const addListener = vi.fn();
        const removeListener = vi.fn();
        window.matchMedia = vi.fn().mockReturnValue({
            matches: true,
            addEventListener: addListener,
            removeEventListener: removeListener,
        });

        const { useDeviceMode } = await import('../../hooks/useDeviceMode');
        const { result } = renderHook(() => useDeviceMode());
        expect(result.current).toBe('helm');
    });

    it('returns deck for narrow viewport', async () => {
        Object.defineProperty(window, 'innerWidth', { value: 375, writable: true, configurable: true });

        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });

        vi.resetModules();
        const { useDeviceMode } = await import('../../hooks/useDeviceMode');
        const { result } = renderHook(() => useDeviceMode());
        expect(result.current).toBe('deck');
    });
});

// ── useSuccessFlash ──────────────────────────────────────────
describe('useSuccessFlash', () => {
    it('returns ref and flash function', async () => {
        const { useSuccessFlash } = await import('../../hooks/useSuccessFlash');
        const { result } = renderHook(() => useSuccessFlash());
        expect(result.current.ref).toBeDefined();
        expect(typeof result.current.flash).toBe('function');
    });

    it('flash adds and removes success-flash class', async () => {
        vi.useFakeTimers();
        const { useSuccessFlash } = await import('../../hooks/useSuccessFlash');
        const { result } = renderHook(() => useSuccessFlash());

        // Create a mock element
        const div = document.createElement('div');
        (result.current.ref as any).current = div;

        act(() => {
            result.current.flash();
        });

        expect(div.classList.contains('success-flash')).toBe(true);

        act(() => {
            vi.advanceTimersByTime(700);
        });

        expect(div.classList.contains('success-flash')).toBe(false);
        vi.useRealTimers();
    });
});
