import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realtime = vi.hoisted(() => {
    const callbacks = new Map<string, (payload: unknown) => void>();
    const channels = new Map<string, { name: string }>();
    const bindings: { channel: string; table: string; callback: (payload: unknown) => void }[] = [];
    const statusCallbacks = new Map<string, (status: string) => void>();
    const removeChannel = vi.fn();
    const applyRealtimeChange = vi.fn().mockResolvedValue(true);
    const requestFullReconciliation = vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
    const requestCatchUpSync = vi.fn();
    const database = {
        identity: null as string | null,
        generation: 1,
    };

    return {
        callbacks,
        channels,
        bindings,
        statusCallbacks,
        removeChannel,
        applyRealtimeChange,
        requestFullReconciliation,
        requestCatchUpSync,
        database,
        getLocalDatabaseSession: vi.fn(() => ({ ...database })),
        isLocalDatabaseSessionCurrent: vi.fn(
            (session: { identity: string | null; generation: number }) =>
                session.identity === database.identity && session.generation === database.generation,
        ),
        channel: vi.fn((name: string) => {
            const marker = { name };
            const api = {
                on: vi.fn((_kind: string, filter: Record<string, unknown>, callback: (payload: unknown) => void) => {
                    callbacks.set(name, callback);
                    bindings.push({ channel: name, table: String(filter.table), callback });
                    return api;
                }),
                subscribe: vi.fn((onStatus?: (status: string) => void) => {
                    channels.set(name, marker);
                    if (onStatus) statusCallbacks.set(name, onStatus);
                    return api;
                }),
            };
            return api;
        }),
    };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: realtime.channel,
        removeChannel: realtime.removeChannel,
    },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    applyRealtimeChange: realtime.applyRealtimeChange,
    getLocalDatabaseSession: realtime.getLocalDatabaseSession,
    isLocalDatabaseSessionCurrent: realtime.isLocalDatabaseSessionCurrent,
}));

vi.mock('../services/vessel/SyncService', () => ({
    requestFullReconciliation: realtime.requestFullReconciliation,
    requestCatchUpSync: realtime.requestCatchUpSync,
}));

import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useRealtimeSync, useRealtimeSyncMulti } from '../hooks/useRealtimeSync';

describe('useRealtimeSync', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        realtime.callbacks.clear();
        realtime.channels.clear();
        realtime.bindings.length = 0;
        realtime.statusCallbacks.clear();
        realtime.applyRealtimeChange.mockResolvedValue(true);
        realtime.requestFullReconciliation.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
        setAuthIdentityScope(null);
        realtime.database.identity = null;
        realtime.database.generation += 1;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses independent channels and applies the actual realtime row before reloading UI', async () => {
        const firstSync = vi.fn();
        const secondSync = vi.fn();
        const first = renderHook(() => useRealtimeSync('shopping_list', firstSync));
        const second = renderHook(() => useRealtimeSync('shopping_list', secondSync));

        act(() => {
            vi.advanceTimersByTime(300);
        });

        const names = [...realtime.callbacks.keys()];
        expect(names).toHaveLength(2);
        expect(new Set(names).size).toBe(2);

        await act(async () => {
            realtime.callbacks.get(names[0])?.({
                eventType: 'UPDATE',
                new: {
                    id: 'item-1',
                    purchased: true,
                    updated_at: '2026-07-23T10:00:00.000Z',
                },
                old: {},
            });
            await Promise.resolve();
        });

        expect(realtime.applyRealtimeChange).toHaveBeenCalledWith(
            'shopping_list',
            'UPDATE',
            expect.objectContaining({ id: 'item-1', purchased: true }),
            expect.objectContaining({ identity: null, generation: realtime.database.generation }),
        );
        expect(firstSync).toHaveBeenCalledOnce();
        expect(secondSync).not.toHaveBeenCalled();

        first.unmount();
        expect(realtime.removeChannel).toHaveBeenCalledOnce();
        expect(realtime.channels.has(names[1])).toBe(true);
        second.unmount();
        expect(realtime.removeChannel).toHaveBeenCalledTimes(2);
    });

    it('cancels a delayed subscription when its component unmounts', () => {
        const subscription = renderHook(() => useRealtimeSync('shopping_list', vi.fn()));

        subscription.unmount();
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(realtime.channel).not.toHaveBeenCalled();
        expect(realtime.removeChannel).not.toHaveBeenCalled();
    });

    it('cancels pending multi-table subscriptions when their component unmounts', () => {
        const subscription = renderHook(() =>
            useRealtimeSyncMulti(['maintenance_tasks', 'maintenance_history'], vi.fn()),
        );

        subscription.unmount();
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(realtime.channel).not.toHaveBeenCalled();
        expect(realtime.removeChannel).not.toHaveBeenCalled();
    });

    it('starts only the current account subscription when identity changes during the delay', () => {
        setAuthIdentityScope('account-a');
        realtime.database.identity = 'account-a';
        const subscription = renderHook(() => useRealtimeSync('shopping_list', vi.fn()));

        act(() => {
            vi.advanceTimersByTime(150);
        });
        act(() => {
            setAuthIdentityScope('account-b');
            realtime.database.identity = 'account-b';
            realtime.database.generation += 1;
        });
        act(() => {
            vi.advanceTimersByTime(150);
        });
        expect(realtime.channel).not.toHaveBeenCalled();

        act(() => {
            vi.advanceTimersByTime(150);
        });
        expect(realtime.channel).toHaveBeenCalledOnce();
        expect(realtime.channel.mock.calls[0][0]).toMatch(new RegExp(`-${getAuthIdentityScope().generation}$`));

        subscription.unmount();
    });

    it('applies DELETE payloads so removed rows do not wait for an impossible timestamp pull', async () => {
        const onSync = vi.fn();
        renderHook(() => useRealtimeSync('shopping_list', onSync));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const callback = [...realtime.callbacks.values()][0];

        await act(async () => {
            callback?.({
                eventType: 'DELETE',
                new: {},
                old: { id: 'item-2' },
            });
            await Promise.resolve();
        });

        expect(realtime.applyRealtimeChange).toHaveBeenCalledWith(
            'shopping_list',
            'DELETE',
            expect.objectContaining({ id: 'item-2' }),
            expect.objectContaining({ identity: null, generation: realtime.database.generation }),
        );
        expect(onSync).toHaveBeenCalledOnce();
    });

    it('forces a full reconciliation for membership visibility changes', async () => {
        const onSync = vi.fn();
        renderHook(() => useRealtimeSync('vessel_crew', onSync));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const callback = [...realtime.callbacks.values()][0];

        await act(async () => {
            callback?.({
                eventType: 'UPDATE',
                new: { id: 'crew-1' },
                old: {},
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(onSync).toHaveBeenCalledOnce();
        expect(realtime.applyRealtimeChange).not.toHaveBeenCalled();
        expect(realtime.requestFullReconciliation).toHaveBeenCalledOnce();
    });

    it('drops an old account channel and resubscribes for the new identity', async () => {
        setAuthIdentityScope('account-a');
        realtime.database.identity = 'account-a';
        const onSync = vi.fn();
        renderHook(() => useRealtimeSync('shopping_list', onSync));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const oldCallback = [...realtime.callbacks.values()][0];

        act(() => {
            setAuthIdentityScope('account-b');
            realtime.database.identity = 'account-b';
            realtime.database.generation += 1;
        });

        await act(async () => {
            oldCallback?.({
                eventType: 'UPDATE',
                new: { id: 'account-a-row', purchased: true },
                old: {},
            });
            await Promise.resolve();
        });

        expect(realtime.applyRealtimeChange).not.toHaveBeenCalled();
        expect(onSync).not.toHaveBeenCalled();
        expect(realtime.removeChannel).toHaveBeenCalledOnce();

        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(realtime.channel).toHaveBeenCalledTimes(2);
        expect(
            [...realtime.callbacks.keys()].some((name) => name.endsWith(`-${getAuthIdentityScope().generation}`)),
        ).toBe(true);
    });

    it('does not refresh account B after an account A apply resolves late', async () => {
        setAuthIdentityScope('account-a');
        realtime.database.identity = 'account-a';
        let resolveApply!: (value: boolean) => void;
        realtime.applyRealtimeChange.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                resolveApply = resolve;
            }),
        );
        const onSync = vi.fn();
        renderHook(() => useRealtimeSync('shopping_list', onSync));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const callback = [...realtime.callbacks.values()][0];

        await act(async () => {
            callback?.({
                eventType: 'UPDATE',
                new: { id: 'account-a-row', purchased: true },
                old: {},
            });
            await Promise.resolve();
        });
        expect(realtime.applyRealtimeChange).toHaveBeenCalledOnce();

        act(() => {
            setAuthIdentityScope('account-b');
            realtime.database.identity = 'account-b';
            realtime.database.generation += 1;
        });
        await act(async () => {
            resolveApply(true);
            await Promise.resolve();
        });

        expect(onSync).not.toHaveBeenCalled();
    });

    it('does not refresh an unmounted component after a database apply resolves late', async () => {
        let resolveApply!: (value: boolean) => void;
        realtime.applyRealtimeChange.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                resolveApply = resolve;
            }),
        );
        const onSync = vi.fn();
        const subscription = renderHook(() => useRealtimeSync('shopping_list', onSync));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const callback = [...realtime.callbacks.values()][0];

        await act(async () => {
            callback?.({
                eventType: 'UPDATE',
                new: { id: 'late-row', purchased: true },
                old: {},
            });
            await Promise.resolve();
        });
        expect(realtime.applyRealtimeChange).toHaveBeenCalledOnce();

        subscription.unmount();
        await act(async () => {
            resolveApply(true);
            await Promise.resolve();
        });

        expect(onSync).not.toHaveBeenCalled();
    });
    it('listens to several tables on ONE channel, one binding each, and removes it on unmount', async () => {
        const onSync = vi.fn();
        const subscription = renderHook(() =>
            useRealtimeSyncMulti(['maintenance_tasks', 'maintenance_history'], onSync),
        );
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(realtime.channel).toHaveBeenCalledOnce();
        expect(realtime.bindings.map((binding) => binding.table)).toEqual(['maintenance_tasks', 'maintenance_history']);
        expect(new Set(realtime.bindings.map((binding) => binding.channel)).size).toBe(1);

        await act(async () => {
            realtime.bindings[1].callback({
                eventType: 'INSERT',
                new: { id: 'history-1', task_id: 'task-1' },
                old: {},
            });
            await Promise.resolve();
        });
        expect(realtime.applyRealtimeChange).toHaveBeenCalledWith(
            'maintenance_history',
            'INSERT',
            expect.objectContaining({ id: 'history-1' }),
            expect.anything(),
        );
        expect(onSync).toHaveBeenCalledOnce();

        subscription.unmount();
        expect(realtime.removeChannel).toHaveBeenCalledOnce();
    });

    it('subscribe, then fetch: asks for a catch-up when the channel first joins, and again on every rejoin', async () => {
        renderHook(() => useRealtimeSync('inventory_items', vi.fn()));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const onStatus = [...realtime.statusCallbacks.values()][0];

        // Opening a binder: anything changed elsewhere before this channel
        // was listening (the iPad sat on the Nav Station) is fetched now.
        await act(async () => {
            onStatus('SUBSCRIBED');
            await vi.dynamicImportSettled();
        });
        await vi.waitFor(() => expect(realtime.requestCatchUpSync).toHaveBeenCalledOnce());

        // The socket dropped (phone slept, link hiccup) and realtime-js rejoined.
        await act(async () => {
            onStatus('CHANNEL_ERROR');
            onStatus('SUBSCRIBED');
            await vi.dynamicImportSettled();
        });
        await vi.waitFor(() => expect(realtime.requestCatchUpSync).toHaveBeenCalledTimes(2));
        // realtime-js rejoins an errored channel itself: no second channel.
        expect(realtime.channel).toHaveBeenCalledOnce();
    });

    it('a channel the server CLOSES is opened again (with backoff) and catches up once it joins', async () => {
        const onSync = vi.fn();
        const subscription = renderHook(() =>
            useRealtimeSyncMulti(['maintenance_tasks', 'maintenance_history'], onSync),
        );
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const firstName = realtime.channel.mock.calls[0][0];
        await act(async () => {
            realtime.statusCallbacks.get(firstName)?.('SUBSCRIBED');
            await vi.dynamicImportSettled();
        });
        await vi.waitFor(() => expect(realtime.requestCatchUpSync).toHaveBeenCalledOnce());

        // A binding mismatch or an expired token: realtime-js closes the
        // channel for good and never rejoins it.
        act(() => {
            realtime.statusCallbacks.get(firstName)?.('CHANNEL_ERROR');
            realtime.statusCallbacks.get(firstName)?.('CLOSED');
        });
        expect(realtime.channel).toHaveBeenCalledOnce();
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(realtime.channel).toHaveBeenCalledTimes(2);
        const secondName = realtime.channel.mock.calls[1][0];
        expect(secondName).not.toBe(firstName);
        // Both tables again, on the new channel.
        expect(realtime.bindings.filter((binding) => binding.channel === secondName).map((b) => b.table)).toEqual([
            'maintenance_tasks',
            'maintenance_history',
        ]);

        await act(async () => {
            realtime.statusCallbacks.get(secondName)?.('SUBSCRIBED');
            await vi.dynamicImportSettled();
        });
        await vi.waitFor(() => expect(realtime.requestCatchUpSync).toHaveBeenCalledTimes(2));

        // A late status from the closed channel changes nothing.
        act(() => {
            realtime.statusCallbacks.get(firstName)?.('CLOSED');
            vi.advanceTimersByTime(60_000);
        });
        expect(realtime.channel).toHaveBeenCalledTimes(2);

        subscription.unmount();
        expect(realtime.removeChannel).toHaveBeenCalledOnce();
    });

    it('stops reopening a channel the server keeps closing, and never reopens after unmount', async () => {
        const subscription = renderHook(() => useRealtimeSync('inventory_items', vi.fn()));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        for (let round = 0; round < 12; round += 1) {
            const latest = realtime.channel.mock.calls.at(-1)![0];
            act(() => {
                realtime.statusCallbacks.get(latest)?.('CLOSED');
                vi.advanceTimersByTime(120_000);
            });
        }
        const opened = realtime.channel.mock.calls.length;
        expect(opened).toBeGreaterThan(2);
        expect(opened).toBeLessThan(12); // bounded: the foreground catch-up covers the rest

        const unmounted = renderHook(() => useRealtimeSync('inventory_items', vi.fn()));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const last = realtime.channel.mock.calls.at(-1)![0];
        unmounted.unmount();
        act(() => {
            realtime.statusCallbacks.get(last)?.('CLOSED');
            vi.advanceTimersByTime(120_000);
        });
        expect(realtime.channel).toHaveBeenCalledTimes(opened + 1);
        subscription.unmount();
    });

    it('a channel the server accepts and then closes at once, over and over, still stops reopening', async () => {
        const subscription = renderHook(() => useRealtimeSync('inventory_items', vi.fn()));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        for (let round = 0; round < 12; round += 1) {
            const latest = realtime.channel.mock.calls.at(-1)![0];
            await act(async () => {
                // Joined, then closed before it ever held.
                realtime.statusCallbacks.get(latest)?.('SUBSCRIBED');
                realtime.statusCallbacks.get(latest)?.('CLOSED');
                vi.advanceTimersByTime(120_000);
                await vi.dynamicImportSettled();
            });
        }
        // Bounded: each join used to reset the count, so it reopened (and
        // asked for a catch-up) every couple of seconds for as long as the
        // page stayed open.
        expect(realtime.channel.mock.calls.length).toBeLessThan(12);
        subscription.unmount();
    });

    it('a join that holds for a minute earns a fresh set of reopens', async () => {
        const subscription = renderHook(() => useRealtimeSync('inventory_items', vi.fn()));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        for (let round = 0; round < 12; round += 1) {
            const latest = realtime.channel.mock.calls.at(-1)![0];
            await act(async () => {
                realtime.statusCallbacks.get(latest)?.('SUBSCRIBED');
                vi.advanceTimersByTime(60_000);
                realtime.statusCallbacks.get(latest)?.('CLOSED');
                vi.advanceTimersByTime(2_000);
                await vi.dynamicImportSettled();
            });
        }
        // A drop now and then, each after a healthy minute: always reopened.
        expect(realtime.channel).toHaveBeenCalledTimes(13);
        subscription.unmount();
    });

    it('does not ask for a catch-up from a channel that was already removed', async () => {
        const subscription = renderHook(() => useRealtimeSync('inventory_items', vi.fn()));
        act(() => {
            vi.advanceTimersByTime(300);
        });
        const onStatus = [...realtime.statusCallbacks.values()][0];
        await act(async () => {
            onStatus('SUBSCRIBED');
            await vi.dynamicImportSettled();
        });
        await vi.waitFor(() => expect(realtime.requestCatchUpSync).toHaveBeenCalledOnce());
        subscription.unmount();

        await act(async () => {
            onStatus('SUBSCRIBED');
            await vi.dynamicImportSettled();
        });
        expect(realtime.requestCatchUpSync).toHaveBeenCalledOnce();
    });
});
