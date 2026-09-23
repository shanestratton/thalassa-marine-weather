import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useDiaryPendingComments } from '../hooks/useDiaryPendingComments';

const service = vi.hoisted(() => ({
    list: vi.fn<(ids: readonly string[], signal: AbortSignal) => Promise<Record<string, number>>>(),
    listeners: new Set<() => void>(),
    unsubscribe: vi.fn(),
}));

vi.mock('../services/DiaryCommentService', () => ({
    listPendingDiaryCommentCounts: service.list,
    subscribeDiaryCommentChanges: (listener: () => void) => {
        service.listeners.add(listener);
        return () => {
            service.unsubscribe();
            service.listeners.delete(listener);
        };
    },
}));

function deferredCounts() {
    let resolve!: (value: Record<string, number>) => void;
    const promise = new Promise<Record<string, number>>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}

async function settle() {
    await act(async () => {
        await Promise.resolve();
    });
}

function moderationConfirmed() {
    act(() => {
        for (const listener of service.listeners) listener();
    });
}

describe('useDiaryPendingComments', () => {
    let hidden: boolean;

    beforeEach(() => {
        vi.useFakeTimers();
        hidden = false;
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        setAuthIdentityScope('diary-owner-a');
        service.list.mockReset().mockResolvedValue({});
        service.listeners.clear();
        service.unsubscribe.mockReset();
    });

    afterEach(() => {
        cleanup();
        setAuthIdentityScope(null);
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('loads all cloud entry counts together and ignores equivalent eight-second entry refreshes', async () => {
        service.list.mockResolvedValue({ 'entry-a': 2, 'entry-b': 1 });
        const { result, rerender } = renderHook(({ ids }) => useDiaryPendingComments(ids, true), {
            initialProps: { ids: ['entry-b', 'entry-a', 'entry-a', 'offline-local', ''] },
        });
        await settle();

        expect(service.list).toHaveBeenCalledExactlyOnceWith(['entry-a', 'entry-b'], expect.any(AbortSignal));
        expect(result.current.counts).toEqual({ 'entry-a': 2, 'entry-b': 1 });

        for (let refresh = 0; refresh < 7; refresh++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(8_000);
            });
            rerender({ ids: ['entry-a', 'offline-other', 'entry-b'] });
        }
        expect(service.list).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_000);
        });
        expect(service.list).toHaveBeenCalledTimes(2);
    });

    it('does not fetch while disabled, signed out, or holding only offline entry IDs', async () => {
        const { rerender } = renderHook(({ ids, enabled }) => useDiaryPendingComments(ids, enabled), {
            initialProps: { ids: ['entry'], enabled: false },
        });
        await settle();
        rerender({ ids: ['offline-local', ''], enabled: true });
        await settle();
        act(() => {
            setAuthIdentityScope(null);
        });
        rerender({ ids: ['entry'], enabled: true });
        await settle();
        expect(service.list).not.toHaveBeenCalled();

        act(() => {
            setAuthIdentityScope('diary-owner-b');
        });
        await settle();
        expect(service.list).toHaveBeenCalledExactlyOnceWith(['entry'], expect.any(AbortSignal));
    });

    it('clears the old owner immediately and fences an old request that finishes after account switching', async () => {
        const lateA = deferredCounts();
        const pendingB = deferredCounts();
        service.list
            .mockResolvedValueOnce({ entry: 2 })
            .mockReturnValueOnce(lateA.promise)
            .mockReturnValueOnce(pendingB.promise);
        const { result } = renderHook(() => useDiaryPendingComments(['entry'], true));
        await settle();
        expect(result.current.counts).toEqual({ entry: 2 });
        moderationConfirmed();
        const oldSignal = service.list.mock.calls[1][1];

        act(() => {
            setAuthIdentityScope('diary-owner-b');
        });
        expect(result.current.counts).toEqual({});
        expect(result.current.error).toBe('');
        expect(oldSignal.aborted).toBe(true);

        await act(async () => {
            pendingB.resolve({ entry: 1 });
        });
        await act(async () => {
            lateA.resolve({ entry: 99 });
        });
        expect(result.current.counts).toEqual({ entry: 1 });
    });

    it('refreshes after confirmed moderation and cannot restore a cleared glow from an in-flight stale count', async () => {
        const stale = deferredCounts();
        service.list.mockResolvedValueOnce({ entry: 1 }).mockReturnValueOnce(stale.promise).mockResolvedValueOnce({});
        const { result } = renderHook(() => useDiaryPendingComments(['entry'], true));
        await settle();
        expect(result.current.counts).toEqual({ entry: 1 });

        act(() => {
            window.dispatchEvent(new Event('focus'));
        });
        const staleSignal = service.list.mock.calls[1][1];
        moderationConfirmed();
        await settle();

        expect(staleSignal.aborted).toBe(true);
        expect(service.list).toHaveBeenCalledTimes(3);
        expect(result.current.counts).toEqual({});
        await act(async () => {
            stale.resolve({ entry: 1 });
        });
        expect(result.current.counts).toEqual({});
    });

    it('retains known pending counts during a failed refresh and offers a successful retry', async () => {
        service.list
            .mockResolvedValueOnce({ entry: 3 })
            .mockRejectedValueOnce(new Error('Network unavailable'))
            .mockResolvedValueOnce({ entry: 1 });
        const { result } = renderHook(() => useDiaryPendingComments(['entry'], true));
        await settle();

        act(() => {
            result.current.refresh();
        });
        await settle();
        expect(result.current.counts).toEqual({ entry: 3 });
        expect(result.current.error).toBe('Comment checks unavailable');

        act(() => {
            result.current.refresh();
        });
        await settle();
        expect(result.current.counts).toEqual({ entry: 1 });
        expect(result.current.error).toBe('');
    });

    it('does not make timer or event reads while hidden and refreshes once visible again', async () => {
        hidden = true;
        service.list.mockResolvedValue({ entry: 2 });
        const { result } = renderHook(() => useDiaryPendingComments(['entry'], true));
        await settle();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(180_000);
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
            document.dispatchEvent(new Event('visibilitychange'));
        });
        moderationConfirmed();
        expect(service.list).not.toHaveBeenCalled();

        act(() => {
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await settle();
        expect(service.list).toHaveBeenCalledTimes(1);
        expect(result.current.counts).toEqual({ entry: 2 });
    });

    it('does not overlap ordinary focus, online, or timer refreshes', async () => {
        const pending = deferredCounts();
        service.list.mockReturnValueOnce(pending.promise);
        renderHook(() => useDiaryPendingComments(['entry'], true));

        await act(async () => {
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(service.list).toHaveBeenCalledTimes(1);
        await act(async () => {
            pending.resolve({ entry: 1 });
        });
    });

    it('aborts outstanding reads and removes polling, listeners, and identity subscriptions on unmount', async () => {
        const pending = deferredCounts();
        service.list.mockReturnValueOnce(pending.promise);
        const { unmount, result } = renderHook(() => useDiaryPendingComments(['entry'], true));
        const signal = service.list.mock.calls[0][1];
        expect(service.listeners.size).toBe(1);
        unmount();
        expect(signal.aborted).toBe(true);
        expect(service.unsubscribe).toHaveBeenCalledOnce();
        expect(service.listeners.size).toBe(0);

        await act(async () => {
            pending.resolve({ entry: 8 });
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
            document.dispatchEvent(new Event('visibilitychange'));
            setAuthIdentityScope('diary-owner-b');
            await vi.advanceTimersByTimeAsync(180_000);
        });
        expect(service.list).toHaveBeenCalledTimes(1);
        expect(result.current.counts).toEqual({});
        expect(vi.getTimerCount()).toBe(0);
    });
});
