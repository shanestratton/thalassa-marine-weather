import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

vi.unmock('../services/supabase');

const mocks = vi.hoisted(() => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://identity-test.supabase.co';
    process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'identity-test-anon-key';
    return {
        getSession: vi.fn(),
        from: vi.fn(),
        preferencesGet: vi.fn().mockResolvedValue({ value: null }),
        preferencesSet: vi.fn().mockResolvedValue(undefined),
        preferencesRemove: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        auth: {
            getSession: mocks.getSession,
        },
        from: mocks.from,
    }),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: mocks.preferencesGet,
        set: mocks.preferencesSet,
        remove: mocks.preferencesRemove,
    },
}));

import {
    getCurrentUser,
    getCurrentUserId,
    getUserProfile,
    syncWaypoints,
    updateUserProfile,
} from '../services/supabase';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function session(userId: string | null) {
    return {
        data: {
            session: userId
                ? {
                      user: { id: userId },
                      access_token: `${userId}-token`,
                  }
                : null,
        },
        error: null,
    };
}

describe('Supabase identity-bound helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getSession.mockResolvedValue(session('account-a'));
    });

    it('returns the local session only when it exactly matches the active scope', async () => {
        await expect(getCurrentUserId()).resolves.toBe('account-a');
        await expect(getCurrentUser()).resolves.toEqual({ id: 'account-a' });

        mocks.getSession.mockResolvedValue(session('account-b'));
        await expect(getCurrentUserId()).resolves.toBeNull();
        await expect(getCurrentUser()).resolves.toBeNull();
    });

    it('drops a deferred A session after switching to B', async () => {
        const pendingSession = deferred<ReturnType<typeof session>>();
        mocks.getSession.mockReturnValueOnce(pendingSession.promise);
        const pending = getCurrentUserId();

        setAuthIdentityScope('account-b');
        pendingSession.resolve(session('account-a'));

        await expect(pending).resolves.toBeNull();
    });

    it('does not consult persisted auth while the app scope is anonymous', async () => {
        setAuthIdentityScope(null);

        await expect(getCurrentUserId()).resolves.toBeNull();
        expect(mocks.getSession).not.toHaveBeenCalled();
    });

    it('drops a profile row that resolves after an account switch', async () => {
        const result = deferred<{ data: { id: string; display_name: string }; error: null }>();
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            single: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.single.mockReturnValue(result.promise);
        mocks.from.mockReturnValue(query);
        const pending = getUserProfile('account-a');
        await vi.waitFor(() => expect(query.single).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        result.resolve({ data: { id: 'account-a', display_name: 'Alice' }, error: null });

        await expect(pending).resolves.toBeNull();
    });

    it('whitelists editable profile fields and rejects a stale mutation completion', async () => {
        const result = deferred<{ error: null }>();
        const query = {
            update: vi.fn(),
            eq: vi.fn(),
            then: (onFulfilled: (value: { error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
                result.promise.then(onFulfilled, onRejected),
        };
        query.update.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        mocks.from.mockReturnValue(query);
        const pending = updateUserProfile('account-a', {
            display_name: 'Alice',
            subscription_status: 'active',
            id: 'account-b',
        } as never);
        await vi.waitFor(() => expect(query.update).toHaveBeenCalledOnce());
        expect(query.update.mock.calls[0][0]).toEqual({
            display_name: 'Alice',
            updated_at: expect.any(String),
        });

        setAuthIdentityScope('account-b');
        result.resolve({ error: null });

        await expect(pending).resolves.toBe(false);
    });

    it('overwrites waypoint ownership and rejects malformed coordinates', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        mocks.from.mockReturnValue({ upsert });

        await expect(
            syncWaypoints('account-a', [
                {
                    id: 'waypoint-a',
                    user_id: 'account-b',
                    name: 'Safe anchorage',
                    latitude: -27.47,
                    longitude: 153.02,
                },
            ]),
        ).resolves.toBe(true);
        expect(upsert).toHaveBeenCalledWith(
            [
                {
                    id: 'waypoint-a',
                    user_id: 'account-a',
                    name: 'Safe anchorage',
                    latitude: -27.47,
                    longitude: 153.02,
                },
            ],
            { onConflict: 'id' },
        );

        await expect(
            syncWaypoints('account-a', [
                {
                    id: 'bad',
                    user_id: 'account-a',
                    name: 'Impossible',
                    latitude: 91,
                    longitude: 153.02,
                },
            ]),
        ).resolves.toBe(false);
        expect(upsert).toHaveBeenCalledOnce();
    });
});
