import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope, type AuthIdentityScope } from '../services/authIdentityScope';

const watchMocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: watchMocks.getUser },
        from: watchMocks.from,
        rpc: watchMocks.rpc,
        channel: watchMocks.channel,
        removeChannel: watchMocks.removeChannel,
    },
}));

import { WatchAssignmentService, type WatchAssignment } from '../services/WatchAssignmentService';

const VOYAGE_ID = 'voyage-shared-id';

function assignment(name: string, index = 0): WatchAssignment {
    return {
        id: `assignment-${name}`,
        voyage_id: VOYAGE_ID,
        watch_index: index,
        watch_label: `Watch ${index + 1}`,
        watch_time_label: '00:00–04:00',
        assigned_crew_email: `${name}@example.com`,
        assigned_crew_name: name,
        assigned_at: '2026-07-23T00:00:00.000Z',
        assigned_by: name,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

function cacheKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(`thalassa_watch_assignments_${VOYAGE_ID}`, scope);
}

describe('WatchAssignmentService identity isolation', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        vi.clearAllMocks();
        watchMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { message: 'offline' },
        });
        watchMocks.rpc.mockResolvedValue({ error: null });
    });

    it('keeps offline assignments per account and voyage without adopting a legacy key', async () => {
        localStorage.setItem(`thalassa_watch_assignments_${VOYAGE_ID}`, JSON.stringify([assignment('legacy-crew')]));

        const accountA = setAuthIdentityScope('account-a');
        expect(await WatchAssignmentService.list(VOYAGE_ID)).toEqual([]);
        await WatchAssignmentService.assign(VOYAGE_ID, 0, 'Watch 1', '00:00–04:00', 'a@example.com', 'A crew');

        const accountB = setAuthIdentityScope('account-b');
        expect(await WatchAssignmentService.list(VOYAGE_ID)).toEqual([]);
        await WatchAssignmentService.assign(VOYAGE_ID, 1, 'Watch 2', '04:00–08:00', 'b@example.com', 'B crew');

        expect(JSON.parse(localStorage.getItem(cacheKey(accountA)) || '[]')).toHaveLength(1);
        expect(JSON.parse(localStorage.getItem(cacheKey(accountB)) || '[]')).toHaveLength(1);

        setAuthIdentityScope('account-a');
        const restoredA = await WatchAssignmentService.list(VOYAGE_ID);
        expect(restoredA.map((row) => row.assigned_crew_email)).toEqual(['a@example.com']);
        expect(restoredA[0]?.assigned_by).toBe('account-a');
    });

    it('discards a remote list response that resolves after account transition', async () => {
        const accountA = setAuthIdentityScope('account-a');
        watchMocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });

        let resolveRemote!: (result: { data: WatchAssignment[]; error: null }) => void;
        const remoteResult = new Promise<{ data: WatchAssignment[]; error: null }>((resolve) => {
            resolveRemote = resolve;
        });
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(remoteResult);
        watchMocks.from.mockReturnValue(query);

        const pending = WatchAssignmentService.list(VOYAGE_ID);
        await vi.waitFor(() => expect(query.order).toHaveBeenCalledTimes(1));

        const accountB = setAuthIdentityScope('account-b');
        resolveRemote({ data: [assignment('account-a-crew')], error: null });

        expect(await pending).toEqual([]);
        expect(localStorage.getItem(cacheKey(accountA))).toBeNull();
        expect(localStorage.getItem(cacheKey(accountB))).toBeNull();
    });

    it('does not write a completed A upsert into B cache', async () => {
        const accountA = setAuthIdentityScope('account-a');
        watchMocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });

        let resolveUpsert!: (result: { data: WatchAssignment; error: null }) => void;
        const upsertResult = new Promise<{ data: WatchAssignment; error: null }>((resolve) => {
            resolveUpsert = resolve;
        });
        const query = {
            upsert: vi.fn(),
            select: vi.fn(),
            single: vi.fn(),
        };
        query.upsert.mockReturnValue(query);
        query.select.mockReturnValue(query);
        query.single.mockReturnValue(upsertResult);
        watchMocks.from.mockReturnValue(query);

        const pending = WatchAssignmentService.assign(
            VOYAGE_ID,
            0,
            'Watch 1',
            '00:00–04:00',
            'a@example.com',
            'A crew',
        );
        await vi.waitFor(() => expect(query.single).toHaveBeenCalledTimes(1));

        const accountB = setAuthIdentityScope('account-b');
        resolveUpsert({ data: assignment('account-a'), error: null });

        expect(await pending).toBeNull();
        expect(localStorage.getItem(cacheKey(accountA))).toBeNull();
        expect(localStorage.getItem(cacheKey(accountB))).toBeNull();
    });

    it('tears down A realtime callbacks as soon as B becomes current', () => {
        setAuthIdentityScope('account-a');
        const callbacks: Array<() => void> = [];
        const channel = {
            on: vi.fn((_kind: string, _filter: unknown, callback: () => void) => {
                callbacks.push(callback);
                return channel;
            }),
            subscribe: vi.fn(() => channel),
        };
        watchMocks.channel.mockReturnValue(channel);

        const onUpdate = vi.fn();
        const unsubscribe = WatchAssignmentService.subscribeToUpdates(VOYAGE_ID, onUpdate);
        callbacks[0]?.();
        expect(onUpdate).toHaveBeenCalledTimes(1);

        setAuthIdentityScope('account-b');
        expect(watchMocks.removeChannel).toHaveBeenCalledWith(channel);
        callbacks.forEach((callback) => callback());
        expect(onUpdate).toHaveBeenCalledTimes(1);

        unsubscribe();
        expect(watchMocks.removeChannel).toHaveBeenCalledTimes(1);
    });
});
