/**
 * The remembered passage grant's paint windows (2026-10-07 tidy-up): one 6 s
 * paint per account + passage between verified answers, however many
 * re-checks start meanwhile. The page-level behaviour is pinned in
 * CrewPagePaintedActions; these pin the bookkeeping on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPassagePaintWindows } from '../components/crewManagement/passagePaintWindows';

const A = 'user:skipper-1::voyage-1';
const B = 'user:skipper-1::voyage-2';

describe('passage paint windows', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('the first claim opens a window that closes 6 s later, however many claims come meanwhile', () => {
        const windows = createPassagePaintWindows(6000);
        const first = vi.fn();
        const second = vi.fn();
        expect(windows.claim(A, first)).toBe(true);
        vi.advanceTimersByTime(4000);
        // A re-check inside the window paints on, without a fresh 6 s.
        expect(windows.claim(A, second)).toBe(true);
        vi.advanceTimersByTime(1999);
        expect(second).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        // The latest claimant hears the close, once.
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60_000);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('a window that closed with no answer paints nothing again until a check verifies the grant', () => {
        const windows = createPassagePaintWindows(6000);
        windows.claim(A, vi.fn());
        vi.advanceTimersByTime(6000);
        expect(windows.claim(A, vi.fn())).toBe(false);
        vi.advanceTimersByTime(60_000);
        expect(windows.claim(A, vi.fn())).toBe(false);

        windows.verified(A);
        const onClose = vi.fn();
        expect(windows.claim(A, onClose)).toBe(true);
        vi.advanceTimersByTime(6000);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a verified answer inside the window stops it, and the next check gets a whole window', () => {
        const windows = createPassagePaintWindows(6000);
        const onClose = vi.fn();
        windows.claim(A, onClose);
        vi.advanceTimersByTime(3000);
        windows.verified(A);
        vi.advanceTimersByTime(60_000);
        expect(onClose).not.toHaveBeenCalled();
        expect(windows.claim(A, vi.fn())).toBe(true);
    });

    it('an answer without a grant (a denial, or "no access" offline) stops the window and paints nothing again', () => {
        const windows = createPassagePaintWindows(6000);
        const onClose = vi.fn();
        windows.claim(A, onClose);
        windows.notGranted(A);
        vi.advanceTimersByTime(60_000);
        expect(onClose).not.toHaveBeenCalled();
        expect(windows.claim(A, vi.fn())).toBe(false);
        // A later check that verifies the grant lets it paint again.
        windows.verified(A);
        expect(windows.claim(A, vi.fn())).toBe(true);
    });

    it('each account + passage has its own window', () => {
        const windows = createPassagePaintWindows(6000);
        windows.claim(A, vi.fn());
        vi.advanceTimersByTime(6000);
        expect(windows.claim(A, vi.fn())).toBe(false);
        expect(windows.claim(B, vi.fn())).toBe(true);
        expect(windows.claim('user:someone-else::voyage-1', vi.fn())).toBe(true);
    });

    it('clear (an account switch, unmount) stops every window', () => {
        const windows = createPassagePaintWindows(6000);
        const onCloseA = vi.fn();
        const onCloseB = vi.fn();
        windows.claim(A, onCloseA);
        windows.claim(B, onCloseB);
        windows.clear();
        vi.advanceTimersByTime(60_000);
        expect(onCloseA).not.toHaveBeenCalled();
        expect(onCloseB).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
