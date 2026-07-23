import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realtime = vi.hoisted(() => {
    const callbacks = new Map<string, (payload: unknown) => void>();
    const channels = new Map<string, { name: string }>();
    const removeChannel = vi.fn();
    const applyRealtimeChange = vi.fn().mockResolvedValue(true);
    const requestFullReconciliation = vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
    const database = {
        identity: null as string | null,
        generation: 1,
    };

    return {
        callbacks,
        channels,
        removeChannel,
        applyRealtimeChange,
        requestFullReconciliation,
        database,
        getLocalDatabaseSession: vi.fn(() => ({ ...database })),
        isLocalDatabaseSessionCurrent: vi.fn(
            (session: { identity: string | null; generation: number }) =>
                session.identity === database.identity && session.generation === database.generation,
        ),
        channel: vi.fn((name: string) => {
            const marker = { name };
            const api = {
                on: vi.fn((_kind: string, _filter: Record<string, unknown>, callback: (payload: unknown) => void) => {
                    callbacks.set(name, callback);
                    return api;
                }),
                subscribe: vi.fn(() => {
                    channels.set(name, marker);
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
}));

import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useRealtimeSync } from '../hooks/useRealtimeSync';

describe('useRealtimeSync', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        realtime.callbacks.clear();
        realtime.channels.clear();
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
});
