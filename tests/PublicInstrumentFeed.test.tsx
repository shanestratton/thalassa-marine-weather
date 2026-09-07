import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePublicInstrumentFeed } from '../src/usePublicInstrumentFeed';
import { VoyageLogError, type PublicInstrumentResponse } from '../src/voyageLogApi';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/voyageLogApi', async (original) => ({
    ...(await original<typeof import('../src/voyageLogApi')>()),
    fetchPublicInstruments: api,
}));
const shared: PublicInstrumentResponse = { instruments_shared: true, instruments: null, generated_at: '' };
const denied = { ...shared, instruments_shared: false };
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-08T00:00:00Z');
    api.mockReset().mockResolvedValue(shared);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('bounded public instrument polling', () => {
    it('does not let an older full response override newer consent revocation', async () => {
        const { result } = renderHook(() => usePublicInstrumentFeed('boat', false));
        const old = result.current.beginRequest();
        const newer = result.current.beginRequest();
        act(() => result.current.acceptResponse(newer, denied));
        act(() => result.current.acceptResponse(old, shared));
        expect(result.current.snapshot?.instruments_shared).toBe(false);
    });

    it('stops polling hidden/folded/historical panels and ignores an in-flight answer', async () => {
        let resolve!: (data: PublicInstrumentResponse) => void;
        api.mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const { result, rerender } = renderHook(({ enabled }) => usePublicInstrumentFeed('boat', enabled), {
            initialProps: { enabled: true },
        });
        const signal = api.mock.calls[0][1] as AbortSignal;
        rerender({ enabled: false });
        expect(signal.aborted).toBe(true);
        await act(async () => {
            resolve(shared);
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(result.current.snapshot).toBeNull();
        expect(api).toHaveBeenCalledTimes(1);
    });

    it('pauses in hidden browser tabs and refreshes immediately when visible', async () => {
        renderHook(() => usePublicInstrumentFeed('boat', true));
        await act(async () => {});
        act(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(api).toHaveBeenCalledTimes(1);
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(api).toHaveBeenCalledTimes(2);
    });

    it('honours Retry-After across reopening and does not overlap requests', async () => {
        api.mockRejectedValueOnce(new VoyageLogError(429, 'Quota', 90_000));
        const { rerender } = renderHook(({ enabled }) => usePublicInstrumentFeed('boat', enabled), {
            initialProps: { enabled: true },
        });
        await act(async () => {});
        rerender({ enabled: false });
        rerender({ enabled: true });
        await act(async () => vi.advanceTimersByTimeAsync(89_000));
        expect(api).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(api).toHaveBeenCalledTimes(2);
    });

    it('bounds hung requests, marks loss, and retries serially', async () => {
        api.mockImplementation(
            (_handle, signal: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        );
        const { result } = renderHook(() => usePublicInstrumentFeed('boat', true));
        await act(async () => vi.advanceTimersByTimeAsync(12_000));
        expect(result.current.failed).toBe(true);
        expect(api).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(api).toHaveBeenCalledTimes(2);
    });
});
