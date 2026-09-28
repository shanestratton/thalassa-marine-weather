import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { boundedPressureRequest, subscribePressureRefresh } from '../services/weather/pressureRefresh';
import {
    PRESSURE_REFRESH_MS,
    pressureCacheIsFresh,
    pressureCoverage,
    pressureCoversTime,
    pressureFrameWithinCoverage,
    pressureFrameValidAt,
    pressureReplacementError,
    pressureWindValidAt,
} from '../services/weather/pressureProvenance';

const RUN = Date.parse('2026-09-27T00:00:00Z');
const HOUR = 3_600_000;
const grid = {
    refTime: new Date(RUN).toISOString(),
    totalHours: 22,
    subFrameStepHours: 2,
    keyframeFhrs: [0, 6],
    source: 'gfs' as const,
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN + 6 * HOUR);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('pressure valid-time coverage and cache freshness', () => {
    it('does not mistake a new fetch timestamp for an unexpired forecast', () => {
        expect(pressureCoverage(grid)).toEqual({ startMs: RUN, endMs: RUN + 42 * HOUR });
        expect(pressureCacheIsFresh(grid, Date.now())).toBe(true);
        const fetchedAt = Date.now();
        vi.advanceTimersByTime(PRESSURE_REFRESH_MS);
        expect(pressureCacheIsFresh(grid, fetchedAt)).toBe(false);
        vi.setSystemTime(RUN + 3 * 24 * HOUR);
        expect(pressureCacheIsFresh(grid, Date.now())).toBe(false);
        expect(pressureCoversTime(grid, Date.now())).toBe(false);
        expect(pressureFrameWithinCoverage(grid, Date.now())).toBeNull();
    });

    it('handles a device clock moving backwards without indefinite fresh-cache suppression', () => {
        expect(pressureCacheIsFresh(grid, Date.now() + HOUR)).toBe(false);
        expect(pressureReplacementError({ ...grid, refTime: new Date(RUN + 12 * HOUR).toISOString() })).toContain(
            'current time',
        );
    });

    it('rejects same-source run regression while allowing a refreshed run and source failover', () => {
        expect(pressureReplacementError({ ...grid, source: undefined }, null)).toBeNull();
        const newer = { ...grid, refTime: new Date(RUN + 6 * HOUR).toISOString() };
        expect(pressureReplacementError(grid, newer)).toContain('older forecast');
        expect(pressureReplacementError(newer, grid)).toBeNull();
        expect(pressureReplacementError({ ...grid, source: 'open-meteo' }, newer)).toBeNull();
        expect(pressureReplacementError({ ...grid, refTime: null })).toContain('current time');
    });

    it('aligns fractional wind time in UTC, but never clamps missing/outside coverage into a pressure field', () => {
        const validAt = pressureWindValidAt(new Date(RUN + 6 * HOUR).toISOString(), [0, 3, 6, 9], 1.5);
        expect(validAt).toBe(RUN + 10.5 * HOUR);
        expect(pressureFrameWithinCoverage(grid, validAt)).toBe(5);
        expect(pressureFrameWithinCoverage(grid, RUN + 42 * HOUR + 1)).toBeNull();
        expect(pressureFrameWithinCoverage(grid, RUN - 1)).toBeNull();
        expect(pressureWindValidAt(null, [0, 3], 1)).toBeNull();
        expect(pressureWindValidAt(grid.refTime, [0, 3], 3)).toBeNull();
        expect(pressureFrameValidAt(grid, -1)).toBeNull();
        expect(pressureFrameValidAt(grid, 22)).toBeNull();
    });
});

describe('pressure foreground / native resume subscription', () => {
    it('ticks every minute, skips background ticks, and revalidates immediately on browser foreground/online', () => {
        const refresh = vi.fn();
        const stop = subscribePressureRefresh(refresh);
        vi.advanceTimersByTime(60_000);
        expect(refresh).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
        vi.advanceTimersByTime(3 * 24 * HOUR);
        window.dispatchEvent(new Event('focus'));
        expect(refresh).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('focus'));
        expect(refresh).toHaveBeenCalledTimes(4);
        stop();
        vi.advanceTimersByTime(60_000);
        window.dispatchEvent(new Event('focus'));
        expect(refresh).toHaveBeenCalledTimes(4);
    });

    it('uses native isActive even before WebView visibility catches up, and removes a late listener', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        let listener: (state: { isActive: boolean }) => void = () => {};
        let registered!: (handle: { remove: () => Promise<void> }) => void;
        const remove = vi.fn().mockResolvedValue(undefined);
        vi.mocked(App.addListener).mockImplementation(((_event: string, callback: typeof listener) => {
            listener = callback;
            return new Promise((resolve) => {
                registered = resolve;
            });
        }) as typeof App.addListener);
        const refresh = vi.fn();
        const stop = subscribePressureRefresh(refresh);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
        listener({ isActive: false });
        expect(refresh).not.toHaveBeenCalled();
        listener({ isActive: true });
        expect(refresh).toHaveBeenCalledTimes(1);
        stop();
        registered({ remove });
        await Promise.resolve();
        expect(remove).toHaveBeenCalledTimes(1);
        listener({ isActive: true });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('bounds hung refreshes and does not deliver their late result', async () => {
        let resolve!: (value: string) => void;
        const result = boundedPressureRequest(
            new Promise<string>((done) => {
                resolve = done;
            }),
        );
        const rejection = expect(result).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(120_000);
        await rejection;
        resolve('late');
        await expect(boundedPressureRequest(Promise.resolve('replacement'))).resolves.toBe('replacement');
        expect(vi.getTimerCount()).toBe(0);
    });
});
