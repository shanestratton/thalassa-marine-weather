/** Deterministic service fixtures; no live membership or RPC writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Result {
    data: unknown;
    error: null | { message: string };
}
interface FixtureQuery {
    select(): FixtureQuery;
    eq(column: string, value: unknown): FixtureQuery;
    order(): FixtureQuery;
    single(): FixtureQuery;
    abortSignal(signal: AbortSignal): FixtureQuery;
    then(resolve: (result: Result) => unknown, reject: (reason: unknown) => unknown): Promise<unknown>;
}
interface FixtureRpcQuery {
    abortSignal(signal: AbortSignal): FixtureRpcQuery;
    then(resolve: (result: Result) => unknown, reject: (reason: unknown) => unknown): Promise<unknown>;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function settle() {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
}
const mocks = vi.hoisted(() => {
    const memberships: Array<Result | Promise<Result>> = [];
    const channels: Array<Result | Promise<Result>> = [];
    const joins: Array<Result | Promise<Result>> = [];
    const signals: AbortSignal[] = [];
    const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    let userId = 'crew-a';
    const getUser = vi.fn(async () => ({ data: { user: { id: userId, email: 'fixture@example.com' } }, error: null }));
    const from = vi.fn((table: string) => {
        const entry = { table, filters: [] as Array<[string, unknown]> };
        queries.push(entry);
        const query: FixtureQuery = {
            select: vi.fn(() => query),
            eq: vi.fn((column: string, value: unknown) => {
                entry.filters.push([column, value]);
                return query;
            }),
            order: vi.fn(() => query),
            single: vi.fn(() => query),
            abortSignal: vi.fn((signal: AbortSignal) => {
                signals.push(signal);
                return query;
            }),
            then: (resolve: (result: Result) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve(
                    table === 'vessel_crew'
                        ? (memberships.shift() ?? { data: [], error: null })
                        : table === 'chat_channels'
                          ? (channels.shift() ?? { data: [], error: null })
                          : { data: null, error: null },
                ).then(resolve, reject),
        };
        return query;
    });
    const rpc = vi.fn((_name: string, _args: { p_owner_id: string }) => {
        const result = joins.shift() ?? { data: 0, error: null };
        const query: FixtureRpcQuery = {
            abortSignal: vi.fn((signal: AbortSignal) => {
                signals.push(signal);
                return query;
            }),
            // Deliberately ignore transport abort: late work must still be fenced.
            then: (resolve: (result: Result) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve(result).then(resolve, reject),
        };
        return query;
    });
    return {
        memberships,
        channels,
        joins,
        signals,
        queries,
        getUser,
        from,
        rpc,
        setUser: (id: string) => {
            userId = id;
        },
    };
});
vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: mocks.getUser, onAuthStateChange: vi.fn() },
        from: mocks.from,
        rpc: mocks.rpc,
        removeChannel: vi.fn(),
    },
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async () => ({ value: null })),
        set: vi.fn(),
        remove: vi.fn(),
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ChatService } from '../services/ChatService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { CHANNELS_CACHE_KEY } from '../services/chat/constants';

const membership = (owner = 'captain-a') => ({ owner_id: owner, crew_user_id: 'crew-a', status: 'accepted' });
beforeEach(async () => {
    vi.useFakeTimers();
    ChatService.destroy();
    vi.clearAllMocks();
    mocks.memberships.length =
        mocks.channels.length =
        mocks.joins.length =
        mocks.signals.length =
        mocks.queries.length =
            0;
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('crew-a');
    mocks.setUser('crew-a');
    ChatService.destroy();
    await ChatService.initialize();
});
afterEach(() => {
    try {
        ChatService.destroy();
        localStorage.clear();
    } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
    }
});

describe('accepted-crew channel self-heal fixtures', () => {
    it('queries accepted memberships for the verified owner and deduplicates captain rows', async () => {
        mocks.memberships.push({ data: [membership(), membership(), membership('captain-b')], error: null });
        mocks.joins.push({ data: 1, error: null }, { data: 2, error: null });
        await expect(ChatService.reconcileAcceptedCrewChannels()).resolves.toEqual({ status: 'ok', joinedCount: 3 });
        expect(mocks.queries.find((query) => query.table === 'vessel_crew')?.filters).toEqual([
            ['crew_user_id', 'crew-a'],
            ['status', 'accepted'],
        ]);
        expect(mocks.rpc.mock.calls).toEqual([
            ['join_accepted_crew_channels', { p_owner_id: 'captain-a' }],
            ['join_accepted_crew_channels', { p_owner_id: 'captain-b' }],
        ]);
        expect(mocks.from).not.toHaveBeenCalledWith('channel_members');
    });
    it('shares only in-flight joins, accepts zero inserts, and retries after later channel creation', async () => {
        const pending = deferred<Result>();
        mocks.memberships.push({ data: [membership()], error: null }, { data: [membership()], error: null });
        mocks.joins.push(pending.promise);
        const first = ChatService.reconcileAcceptedCrewChannels();
        const second = ChatService.reconcileAcceptedCrewChannels();
        await settle();
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
        pending.resolve({ data: 0, error: null });
        await expect(first).resolves.toEqual({ status: 'ok', joinedCount: 0 });
        await expect(second).resolves.toEqual({ status: 'ok', joinedCount: 0 });
        mocks.memberships.push({ data: [membership()], error: null });
        mocks.joins.push({ data: 1, error: null });
        await expect(ChatService.reconcileAcceptedCrewChannels()).resolves.toEqual({ status: 'ok', joinedCount: 1 });
        expect(mocks.rpc).toHaveBeenCalledTimes(2);
    });
    it('reports lookup failure instead of treating it as no memberships, then retries', async () => {
        mocks.memberships.push({ data: null, error: { message: 'fixture lookup failure' } });
        await expect(ChatService.reconcileAcceptedCrewChannels()).resolves.toEqual({
            status: 'failed',
            reason: 'membership_lookup',
            failedOwners: 0,
        });
        expect(mocks.rpc).not.toHaveBeenCalled();
        mocks.memberships.push({ data: [membership()], error: null });
        await expect(ChatService.reconcileAcceptedCrewChannels()).resolves.toEqual({ status: 'ok', joinedCount: 0 });
    });
    it('does not latch failed joins and continues repairing other accepted owners', async () => {
        mocks.memberships.push({ data: [membership(), membership('captain-b')], error: null });
        mocks.joins.push({ data: null, error: { message: 'fixture RPC failure' } }, { data: 1, error: null });
        await expect(ChatService.reconcileAcceptedCrewChannels()).resolves.toEqual({
            status: 'failed',
            reason: 'channel_join',
            failedOwners: 1,
        });
        mocks.memberships.push({ data: [membership()], error: null });
        await expect(ChatService.reconcileAcceptedCrewChannels()).resolves.toEqual({ status: 'ok', joinedCount: 0 });
        expect(mocks.rpc).toHaveBeenCalledTimes(3);
    });
    it.each([null, -1, 1.5])(
        'rejects malformed inserted counts (%s) and allows the next load to retry',
        async (count) => {
            mocks.memberships.push({ data: [membership()], error: null });
            mocks.joins.push({ data: count, error: null });
            expect((await ChatService.reconcileAcceptedCrewChannels()).status).toBe('failed');
            mocks.memberships.push({ data: [membership()], error: null });
            expect((await ChatService.reconcileAcceptedCrewChannels()).status).toBe('ok');
        },
    );
    it.each([
        { ...membership(), crew_user_id: 'crew-b' },
        { ...membership(), status: 'pending' },
        { ...membership(), status: 'declined' },
    ])('refuses unexpected membership data without dispatching a join', async (row) => {
        mocks.memberships.push({ data: [row], error: null });
        expect((await ChatService.reconcileAcceptedCrewChannels()).status).toBe('failed');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('fences a delayed authentication response before membership lookup', async () => {
        const auth = deferred<Awaited<ReturnType<typeof mocks.getUser>>>();
        mocks.getUser.mockReturnValueOnce(auth.promise);
        const repair = ChatService.reconcileAcceptedCrewChannels();
        setAuthIdentityScope('crew-b');
        auth.resolve({ data: { user: { id: 'crew-a', email: 'fixture@example.com' } }, error: null });
        await expect(repair).resolves.toEqual({ status: 'cancelled' });
        expect(mocks.from).not.toHaveBeenCalledWith('vessel_crew');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('fences an A→B→A membership lookup by generation, not merely matching account ID', async () => {
        const lookup = deferred<Result>();
        mocks.memberships.push(lookup.promise);
        const repair = ChatService.reconcileAcceptedCrewChannels();
        await settle();
        setAuthIdentityScope('crew-b');
        setAuthIdentityScope('crew-a');
        lookup.resolve({ data: [membership()], error: null });
        await expect(repair).resolves.toEqual({ status: 'cancelled' });
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('aborts and fences a late RPC on logout without dispatching the next captain or changing B cache', async () => {
        const pending = deferred<Result>();
        mocks.memberships.push({ data: [membership(), membership('captain-b')], error: null });
        mocks.joins.push(pending.promise);
        const repair = ChatService.reconcileAcceptedCrewChannels();
        await settle();
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
        setAuthIdentityScope(null);
        setAuthIdentityScope('crew-b');
        const key = authScopedStorageKey(CHANNELS_CACHE_KEY);
        localStorage.setItem(key, 'B-cache-marker');
        await expect(repair).resolves.toEqual({ status: 'cancelled' });
        pending.resolve({ data: 1, error: null });
        await settle();
        expect(mocks.signals.some((signal) => signal.aborted)).toBe(true);
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem(key)).toBe('B-cache-marker');
    });
    it('allows one cancelled caller to stop waiting while another shared join completes', async () => {
        const pending = deferred<Result>();
        const controller = new AbortController();
        mocks.memberships.push({ data: [membership()], error: null }, { data: [membership()], error: null });
        mocks.joins.push(pending.promise);
        const first = ChatService.reconcileAcceptedCrewChannels(getAuthIdentityScope(), controller.signal);
        const second = ChatService.reconcileAcceptedCrewChannels();
        await settle();
        controller.abort();
        await expect(first).resolves.toEqual({ status: 'cancelled' });
        pending.resolve({ data: 1, error: null });
        await expect(second).resolves.toEqual({ status: 'ok', joinedCount: 1 });
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });
    it('bounds stalled joins, releases their in-flight slot, and fences ignored-abort transport completion', async () => {
        const pending = deferred<Result>();
        mocks.memberships.push({ data: [membership()], error: null });
        mocks.joins.push(pending.promise);
        const repair = ChatService.reconcileAcceptedCrewChannels();
        await settle();
        await vi.advanceTimersByTimeAsync(8000);
        expect((await repair).status).toBe('failed');
        mocks.memberships.push({ data: [membership()], error: null });
        expect((await ChatService.reconcileAcceptedCrewChannels()).status).toBe('ok');
        expect(mocks.rpc).toHaveBeenCalledTimes(2);
        const key = authScopedStorageKey(CHANNELS_CACHE_KEY);
        localStorage.setItem(key, 'new-cache-marker');
        pending.resolve({ data: 1, error: null });
        await settle();
        expect(localStorage.getItem(key)).toBe('new-cache-marker');
    });
    it('invalidates pre-repair cache requests so an older snapshot cannot overwrite a fresh list', async () => {
        const old = deferred<Result>();
        mocks.channels.push(old.promise);
        const initial = ChatService.getChannels();
        mocks.memberships.push({ data: [membership()], error: null });
        expect((await ChatService.reconcileAcceptedCrewChannels()).status).toBe('ok');
        const fresh = [{ id: 'crew-channel', name: 'Crew Chat', status: 'active' }];
        mocks.channels.push({ data: fresh, error: null });
        await expect(ChatService.getChannelsFresh()).resolves.toEqual(fresh);
        old.resolve({ data: [{ id: 'old', name: 'Old list' }], error: null });
        await expect(initial).resolves.toEqual([]);
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey(CHANNELS_CACHE_KEY))!)).toEqual(fresh);
    });
    it('does not start repair before initialized authentication or under an already-cancelled scope', async () => {
        ChatService.destroy();
        expect((await ChatService.reconcileAcceptedCrewChannels()).status).toBe('failed');
        const controller = new AbortController();
        controller.abort();
        expect(
            (await ChatService.reconcileAcceptedCrewChannels(getAuthIdentityScope(), controller.signal)).status,
        ).toBe('cancelled');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
