import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestChannel {
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    subscribeCallback: ((status: string) => void) | null;
    handlers: Map<string, (value: unknown) => void>;
}

const syncMocks = vi.hoisted(() => {
    const deleteFilters: Array<[string, unknown]> = [];
    const deleteRows = vi.fn(() => {
        const builder = {
            eq: vi.fn((column: string, value: unknown) => {
                deleteFilters.push([column, value]);
                return builder;
            }),
        };
        return builder;
    });

    return {
        authUserId: null as string | null,
        autoSubscribe: true,
        subscribeStatus: 'SUBSCRIBED',
        trackResult: null as Promise<string> | null,
        channels: [] as TestChannel[],
        getUser: vi.fn(),
        rpc: vi.fn(),
        removeChannel: vi.fn().mockResolvedValue('ok'),
        insertAlarm: vi.fn().mockResolvedValue({ error: null }),
        upsertToken: vi.fn().mockResolvedValue({ error: null }),
        deleteRows,
        deleteFilters,
        requestPushToken: vi.fn().mockResolvedValue(null),
        getPushToken: vi.fn().mockReturnValue(null),
        platform: 'ios',
        nativeReadiness: vi.fn(),
        appStateListener: null as null | ((state: { isActive: boolean }) => void),
    };
});

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn(async (_event, listener) => {
            syncMocks.appStateListener = listener;
            return { remove: vi.fn() };
        }),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => syncMocks.platform },
}));

vi.mock('../services/AnchorSafetyNotificationService', () => ({
    AnchorSafetyNotificationService: { requireReadiness: syncMocks.nativeReadiness },
}));

vi.mock('../services/PushNotificationService', () => ({
    PushNotificationService: {
        initialize: vi.fn().mockResolvedValue(undefined),
        requestPermissionAndRegister: syncMocks.requestPushToken,
        setUser: vi.fn().mockResolvedValue(undefined),
        clearUser: vi.fn().mockResolvedValue(undefined),
        getToken: syncMocks.getPushToken,
        isAvailable: vi.fn().mockResolvedValue(false),
        clearBadge: vi.fn().mockResolvedValue(undefined),
        onNotificationTap: null,
        onForegroundPush: null,
    },
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: {
        auth: {
            getUser: syncMocks.getUser,
        },
        rpc: syncMocks.rpc,
        channel: vi.fn(() => {
            const handlers = new Map<string, (value: unknown) => void>();
            const channel: TestChannel = {
                handlers,
                subscribeCallback: null,
                on: vi.fn((kind: string, filter: { event: string }, handler: (value: unknown) => void) => {
                    handlers.set(`${kind}:${filter.event}`, handler);
                    return channel;
                }),
                subscribe: vi.fn((callback: (status: string) => void) => {
                    channel.subscribeCallback = callback;
                    if (syncMocks.autoSubscribe) callback(syncMocks.subscribeStatus);
                    return channel;
                }),
                track: vi.fn(() => syncMocks.trackResult ?? Promise.resolve('ok')),
                send: vi.fn().mockResolvedValue('ok'),
            };
            syncMocks.channels.push(channel);
            return channel;
        }),
        removeChannel: syncMocks.removeChannel,
        from: vi.fn((table: string) => {
            if (table === 'anchor_alarm_events') {
                return { insert: syncMocks.insertAlarm };
            }
            if (table === 'anchor_alarm_tokens') {
                return {
                    upsert: syncMocks.upsertToken,
                    delete: syncMocks.deleteRows,
                };
            }
            throw new Error(`Unexpected table ${table}`);
        }),
    },
}));

import { AnchorWatchSyncService, type PositionBroadcast } from '../services/AnchorWatchSyncService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const SESSION_KEY = 'thalassa_anchor_sync_session';

function signInAs(userId: string) {
    syncMocks.authUserId = userId;
    return setAuthIdentityScope(userId);
}

function flushPromises(): Promise<void> {
    return Promise.resolve().then(() => undefined);
}

function position(): PositionBroadcast {
    return {
        type: 'position',
        vessel: { latitude: -20, longitude: 148, accuracy: 4, heading: 0, speed: 0, timestamp: Date.now() },
        anchor: { latitude: -20, longitude: 148, timestamp: Date.now() },
        distance: 50,
        swingRadius: 30,
        isAlarm: true,
        timestamp: Date.now(),
    };
}

describe('AnchorWatchSyncService identity isolation', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        localStorage.clear();
        vi.useFakeTimers();
        vi.clearAllMocks();
        syncMocks.authUserId = null;
        syncMocks.autoSubscribe = true;
        syncMocks.subscribeStatus = 'SUBSCRIBED';
        syncMocks.trackResult = null;
        syncMocks.channels.length = 0;
        syncMocks.deleteFilters.length = 0;
        syncMocks.getUser.mockImplementation(async () => ({
            data: { user: syncMocks.authUserId ? { id: syncMocks.authUserId } : null },
        }));
        syncMocks.rpc.mockReset().mockResolvedValue({ data: true, error: null });
        syncMocks.removeChannel.mockResolvedValue('ok');
        syncMocks.insertAlarm.mockResolvedValue({ error: null });
        syncMocks.upsertToken.mockResolvedValue({ error: null });
        syncMocks.requestPushToken.mockResolvedValue(null);
        syncMocks.getPushToken.mockReturnValue(null);
        syncMocks.platform = 'ios';
        syncMocks.nativeReadiness.mockResolvedValue({ ready: true });
    });

    afterEach(() => {
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('tears down A synchronously, hides legacy state from B, and restores only A persistence', async () => {
        const accountAScope = signInAs('account-a');
        const baselineTimerCount = vi.getTimerCount();
        const sessionCode = await AnchorWatchSyncService.createSession();

        expect(sessionCode).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
        expect(AnchorWatchSyncService.getState()).toMatchObject({
            connected: true,
            role: 'vessel',
            sessionCode,
        });
        expect(vi.getTimerCount()).toBeGreaterThanOrEqual(baselineTimerCount + 2);
        expect(
            JSON.parse(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountAScope)) ?? '{}'),
        ).toMatchObject({
            sessionCode,
            role: 'vessel',
            userId: 'account-a',
        });

        const firstChannel = syncMocks.channels[0];
        const accountBScope = signInAs('account-b');

        expect(AnchorWatchSyncService.getState()).toMatchObject({
            connected: false,
            sessionCode: null,
        });
        expect(syncMocks.removeChannel).toHaveBeenCalledWith(firstChannel);
        expect(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountBScope))).toBeNull();
        const channelCountAfterSwitch = syncMocks.channels.length;
        const oldSendCount = firstChannel.send.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(syncMocks.channels).toHaveLength(channelCountAfterSwitch);
        expect(firstChannel.send).toHaveBeenCalledTimes(oldSendCount);

        // This pre-isolation value has no owner and must never be guessed.
        localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionCode, role: 'vessel', savedAt: Date.now() }));
        expect(AnchorWatchSyncService.getLastSessionCode()).toBeNull();
        expect(await AnchorWatchSyncService.restoreSession()).toBe(false);

        signInAs('account-a');
        expect(AnchorWatchSyncService.getLastSessionCode()).toBe(sessionCode);
        expect(await AnchorWatchSyncService.restoreSession()).toBe(true);
        expect(AnchorWatchSyncService.getState()).toMatchObject({
            connected: true,
            sessionCode,
        });
    });

    it('drops a stale A auth promise before it can create or persist a session as B', async () => {
        signInAs('account-a');
        let resolveUser!: (value: { data: { user: { id: string } } }) => void;
        syncMocks.getUser.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUser = resolve;
            }),
        );

        const pending = AnchorWatchSyncService.createSession();
        await flushPromises();
        const accountBScope = signInAs('account-b');
        syncMocks.authUserId = 'account-b';
        resolveUser({ data: { user: { id: 'account-a' } } });

        expect(await pending).toBeNull();
        expect(syncMocks.rpc).not.toHaveBeenCalled();
        expect(syncMocks.channels).toHaveLength(0);
        expect(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountBScope))).toBeNull();
    });

    it('settles and fences an in-flight channel join when identity changes', async () => {
        const accountAScope = signInAs('account-a');
        syncMocks.autoSubscribe = false;

        const pending = AnchorWatchSyncService.createSession();
        await vi.waitFor(() => expect(syncMocks.channels).toHaveLength(1));
        const oldChannel = syncMocks.channels[0];
        expect(oldChannel.subscribeCallback).not.toBeNull();

        const accountBScope = signInAs('account-b');
        oldChannel.subscribeCallback?.('SUBSCRIBED');

        expect(await pending).toBeNull();
        expect(oldChannel.track).not.toHaveBeenCalled();
        expect(AnchorWatchSyncService.getState().sessionCode).toBeNull();
        // FLUSH SCHEDULER TICKS BEFORE COUNTING (Node-24 lesson, 2026-08-24).
        // vi.getTimerCount() is a census of EVERY pending fake timer, and under
        // Node 24 React's scheduler work arrives as setTimeout(0) — so render
        // work the identity flip legitimately queues shows up in the count, while
        // under Node 26 the same work rides a channel the census cannot see. CI
        // runs 24; dev machines run 26; the same tree passed one and failed the
        // other with nothing wrong. Advancing the clock by ZERO fires only
        // due-now ticks: scheduler work drains, while a genuinely leaked app
        // timer (they are all >=500 ms here) survives to fail the assertion —
        // the guard is unchanged, only the environment noise is gone.
        vi.advanceTimersByTime(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountAScope))).not.toBeNull();
        expect(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountBScope))).toBeNull();

        oldChannel.handlers.get('broadcast:heartbeat')?.({});
        expect(AnchorWatchSyncService.getState().peerConnected).toBe(false);
    });

    it('settles a stuck presence-track promise on identity transition', async () => {
        signInAs('account-a');
        let resolveTrack!: (status: string) => void;
        syncMocks.trackResult = new Promise((resolve) => {
            resolveTrack = resolve;
        });

        const stuckCreate = AnchorWatchSyncService.createSession();
        await vi.waitFor(() => expect(syncMocks.channels).toHaveLength(1));
        const stuckChannel = syncMocks.channels[0];
        await vi.waitFor(() => expect(stuckChannel.track).toHaveBeenCalledOnce());
        signInAs('account-b');

        expect(await stuckCreate).toBeNull();
        expect(AnchorWatchSyncService.getState().sessionCode).toBeNull();
        resolveTrack('ok');
    });

    it('does not register A push credentials after a switch to B', async () => {
        signInAs('account-a');
        let resolveToken!: (token: string) => void;
        syncMocks.requestPushToken.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveToken = resolve;
            }),
        );

        expect(await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM')).toBe(true);
        expect(syncMocks.requestPushToken).toHaveBeenCalledOnce();

        signInAs('account-b');
        syncMocks.authUserId = 'account-b';
        resolveToken('push-token-a');
        await flushPromises();

        expect(syncMocks.upsertToken).not.toHaveBeenCalled();
    });

    it('fences stale alarm writes and post-switch broadcasts', async () => {
        signInAs('account-a');
        await AnchorWatchSyncService.createSession();
        const oldChannel = syncMocks.channels[0];
        AnchorWatchSyncService.broadcastPosition({
            vessel: {
                latitude: -27,
                longitude: 153,
                accuracy: 4,
                heading: 0,
                speed: 0,
                timestamp: Date.now(),
            },
            anchor: { latitude: -27, longitude: 153, timestamp: Date.now() },
            distance: 3,
            swingRadius: 30,
            isAlarm: false,
            config: {
                rodeLength: 30,
                waterDepth: 5,
                scopeRatio: 5,
                rodeType: 'chain',
                safetyMargin: 10,
            },
        });
        expect(oldChannel.send).toHaveBeenCalledOnce();

        let resolveUser!: (value: { data: { user: { id: string } } }) => void;
        syncMocks.getUser.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUser = resolve;
            }),
        );
        const pendingAlarm = AnchorWatchSyncService.sendAlarmPush({
            distance: 50,
            swingRadius: 30,
        });
        await flushPromises();

        signInAs('account-b');
        syncMocks.authUserId = 'account-b';
        AnchorWatchSyncService.broadcastAlarm({
            triggered: true,
            distance: 50,
            swingRadius: 30,
        });
        resolveUser({ data: { user: { id: 'account-a' } } });
        await pendingAlarm;

        expect(oldChannel.send).toHaveBeenCalledOnce();
        expect(syncMocks.insertAlarm).not.toHaveBeenCalled();
    });

    it('retries a database session-code collision with a fresh code', async () => {
        signInAs('account-a');
        syncMocks.rpc
            .mockResolvedValueOnce({
                data: null,
                error: { code: '23505', message: 'duplicate key value for anchor_watch_sessions' },
            })
            .mockResolvedValueOnce({ data: null, error: null });

        const sessionCode = await AnchorWatchSyncService.createSession();

        expect(sessionCode).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
        expect(syncMocks.rpc).toHaveBeenCalledTimes(2);
        const firstCode = syncMocks.rpc.mock.calls[0][1].p_session_code;
        const secondCode = syncMocks.rpc.mock.calls[1][1].p_session_code;
        expect(secondCode).not.toBe(firstCode);
        expect(sessionCode).toBe(secondCode);
    });

    it('leaves only the captured shore account and never deletes a token under B', async () => {
        const accountAScope = signInAs('account-a');
        syncMocks.requestPushToken.mockResolvedValue('push-token-a');
        syncMocks.getPushToken.mockReturnValue('push-token-a');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        await flushPromises();
        syncMocks.upsertToken.mockClear();

        let resolveUser!: (value: { data: { user: { id: string } } }) => void;
        syncMocks.getUser.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUser = resolve;
            }),
        );
        const leaving = AnchorWatchSyncService.leaveSession();
        expect(AnchorWatchSyncService.getState().sessionCode).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountAScope))).toBeNull();

        const accountBScope = signInAs('account-b');
        syncMocks.authUserId = 'account-b';
        resolveUser({ data: { user: { id: 'account-a' } } });
        await leaving;

        expect(syncMocks.deleteRows).not.toHaveBeenCalled();
        expect(localStorage.getItem(authScopedStorageKey(SESSION_KEY, accountBScope))).toBeNull();
        expect(getAuthIdentityScope().userId).toBe('account-b');
    });

    it('reports checking until both native settings and the session token write are acknowledged', async () => {
        signInAs('account-a');
        syncMocks.requestPushToken.mockResolvedValue('push-token-a');
        let acknowledge!: (value: { error: null }) => void;
        syncMocks.upsertToken.mockReturnValueOnce(new Promise((resolve) => (acknowledge = resolve)));
        const listener = vi.fn();
        const unsubscribe = AnchorWatchSyncService.onPushReadinessChange(listener);
        try {
            expect(listener).toHaveBeenLastCalledWith({ status: 'inactive', reason: null, checkedAt: null });
            expect(await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM')).toBe(true);
            await vi.waitFor(() => expect(syncMocks.upsertToken).toHaveBeenCalledOnce());
            expect(AnchorWatchSyncService.getPushReadiness().status).toBe('checking');
            expect(syncMocks.nativeReadiness).toHaveBeenCalledOnce();
            expect(syncMocks.upsertToken).toHaveBeenCalledWith(
                {
                    session_code: 'ABCDEFGHJKLM',
                    user_id: 'account-a',
                    device_token: 'push-token-a',
                    platform: 'ios',
                    supports_reminders: true,
                },
                { onConflict: 'session_code,device_token' },
            );
            const pending = AnchorWatchSyncService.refreshPushReadiness();
            acknowledge({ error: null });
            await expect(pending).resolves.toEqual({ status: 'ready', reason: null, checkedAt: expect.any(Number) });
            expect(listener).toHaveBeenLastCalledWith(AnchorWatchSyncService.getPushReadiness());
        } finally {
            unsubscribe();
        }
    });

    it.each(['web', 'android'])('keeps %s joins in-app-only without claiming APNs support', async (platform) => {
        signInAs('account-a');
        syncMocks.platform = platform;
        expect(await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM')).toBe(true);
        await expect(AnchorWatchSyncService.refreshPushReadiness()).resolves.toMatchObject({ status: 'unavailable' });
        expect(AnchorWatchSyncService.getState().connected).toBe(true);
        expect(syncMocks.requestPushToken).not.toHaveBeenCalled();
        expect(syncMocks.upsertToken).not.toHaveBeenCalled();
    });

    it.each(['permission-or-token', 'native-settings', 'server-write'])(
        'retains the joined session but reports unavailable when %s verification fails',
        async (failure) => {
            signInAs('account-a');
            syncMocks.requestPushToken.mockResolvedValue(failure === 'permission-or-token' ? null : 'push-token-a');
            if (failure === 'native-settings') {
                syncMocks.nativeReadiness.mockRejectedValue(
                    new Error('Enable Time Sensitive notifications in Settings.'),
                );
            }
            if (failure === 'server-write') syncMocks.upsertToken.mockResolvedValue({ error: { message: 'offline' } });

            expect(await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM')).toBe(true);
            await expect(AnchorWatchSyncService.refreshPushReadiness()).resolves.toMatchObject({
                status: 'unavailable',
                reason: expect.any(String),
            });
            expect(AnchorWatchSyncService.getState()).toMatchObject({ connected: true, sessionCode: 'ABCDEFGHJKLM' });
            expect(AnchorWatchSyncService.hasPersistedSession()).toBe(true);
            if (failure !== 'server-write') expect(syncMocks.upsertToken).not.toHaveBeenCalled();
        },
    );

    it.each(['token', 'native', 'storage'] as const)(
        'bounds a stalled %s check and ignores its late result',
        async (stage) => {
            signInAs('account-a');
            syncMocks.requestPushToken.mockResolvedValue('push-token-a');
            let release!: (value: unknown) => void;
            const stalled = new Promise((resolve) => (release = resolve));
            const mock =
                stage === 'token'
                    ? syncMocks.requestPushToken
                    : stage === 'native'
                      ? syncMocks.nativeReadiness
                      : syncMocks.upsertToken;
            mock.mockReturnValueOnce(stalled);
            await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
            const pending = AnchorWatchSyncService.refreshPushReadiness();
            await vi.advanceTimersByTimeAsync(20_000);

            await expect(pending).resolves.toMatchObject({
                status: 'unavailable',
                reason: expect.stringContaining('timed out'),
            });
            const writesBefore = syncMocks.upsertToken.mock.calls.length;
            release(stage === 'token' ? 'late-token' : stage === 'native' ? { ready: true } : { error: null });
            await flushPromises();
            await flushPromises();
            expect(syncMocks.upsertToken).toHaveBeenCalledTimes(writesBefore);
            expect(AnchorWatchSyncService.getPushReadiness().status).toBe('unavailable');
            expect(AnchorWatchSyncService.getLastSessionCode()).toBe('ABCDEFGHJKLM');
        },
    );

    it('rechecks revoked settings on foreground even while realtime is still connected', async () => {
        signInAs('account-a');
        syncMocks.requestPushToken.mockResolvedValue('push-token-a');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        await expect(AnchorWatchSyncService.refreshPushReadiness()).resolves.toMatchObject({ status: 'ready' });
        syncMocks.nativeReadiness.mockRejectedValue(new Error('Notifications were disabled.'));
        syncMocks.appStateListener?.({ isActive: true });
        await expect(AnchorWatchSyncService.refreshPushReadiness()).resolves.toMatchObject({
            status: 'unavailable',
            reason: 'Notifications were disabled.',
        });
        expect(AnchorWatchSyncService.getState().connected).toBe(true);
    });

    it('retains a failed channel join and retries notification setup on reconnect', async () => {
        signInAs('account-a');
        syncMocks.subscribeStatus = 'CHANNEL_ERROR';
        expect(await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM')).toBe(false);
        await expect(AnchorWatchSyncService.refreshPushReadiness()).resolves.toMatchObject({ status: 'unavailable' });
        expect(AnchorWatchSyncService.getLastSessionCode()).toBe('ABCDEFGHJKLM');
        syncMocks.subscribeStatus = 'SUBSCRIBED';
        syncMocks.requestPushToken.mockResolvedValue('push-token-a');
        await vi.advanceTimersByTimeAsync(2000);
        expect(AnchorWatchSyncService.getState().connected).toBe(true);
        expect(AnchorWatchSyncService.getPushReadiness().status).toBe('ready');
    });

    it('cancels a pending check on leave and fences a rejoined identical session', async () => {
        signInAs('account-a');
        let oldToken!: (token: string) => void;
        syncMocks.requestPushToken.mockReturnValueOnce(new Promise((resolve) => (oldToken = resolve)));
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        const oldCheck = AnchorWatchSyncService.refreshPushReadiness();
        await AnchorWatchSyncService.leaveSession();
        await expect(oldCheck).resolves.toMatchObject({ status: 'inactive' });
        syncMocks.requestPushToken.mockResolvedValue('new-token');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        await expect(AnchorWatchSyncService.refreshPushReadiness()).resolves.toMatchObject({ status: 'ready' });
        const writesBefore = syncMocks.upsertToken.mock.calls.length;
        oldToken('old-token');
        await flushPromises();
        expect(syncMocks.upsertToken).toHaveBeenCalledTimes(writesBefore);
        expect(AnchorWatchSyncService.getPushReadiness().status).toBe('ready');
    });

    it("never publishes an old account's acknowledged token as ready after an identity switch", async () => {
        signInAs('account-a');
        syncMocks.requestPushToken.mockResolvedValue('push-token-a');
        let acknowledge!: (value: { error: null }) => void;
        syncMocks.upsertToken.mockReturnValueOnce(new Promise((resolve) => (acknowledge = resolve)));
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        await vi.waitFor(() => expect(syncMocks.upsertToken).toHaveBeenCalled());
        signInAs('account-b');
        acknowledge({ error: null });
        await flushPromises();
        expect(AnchorWatchSyncService.getPushReadiness().status).toBe('inactive');
    });

    it('replays latest position and alarm across channel reconnect, but not a replaced session/account', async () => {
        signInAs('account-a');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        const firstChannel = syncMocks.channels[0];
        const fix = position();
        const alarm = { type: 'alarm', triggered: false, distance: 5, swingRadius: 30, timestamp: Date.now() };
        firstChannel.handlers.get('broadcast:position')?.({ payload: fix });
        expect(AnchorWatchSyncService.getLatestPosition()).toEqual(fix);
        expect(AnchorWatchSyncService.getLatestBroadcast()).toEqual(fix);
        firstChannel.handlers.get('broadcast:alarm')?.({ payload: alarm });
        expect(AnchorWatchSyncService.getLatestPosition()).toEqual(fix);
        expect(AnchorWatchSyncService.getLatestBroadcast()).toEqual(alarm);

        firstChannel.subscribeCallback?.('CHANNEL_ERROR');
        await vi.advanceTimersByTimeAsync(2000);
        expect(AnchorWatchSyncService.getLatestBroadcast()).toEqual(alarm);
        await AnchorWatchSyncService.joinSession('NPQRSTUVWXYZ');
        firstChannel.handlers.get('broadcast:position')?.({ payload: fix });
        expect(AnchorWatchSyncService.getLatestBroadcast()).toBeNull();
        expect(AnchorWatchSyncService.getLatestPosition()).toBeNull();
        syncMocks.channels.at(-1)?.handlers.get('broadcast:position')?.({ payload: fix });
        signInAs('account-b');
        expect(AnchorWatchSyncService.getLatestBroadcast()).toBeNull();
        expect(AnchorWatchSyncService.getLatestPosition()).toBeNull();
    });

    it('acknowledges only the current phone’s matching incident at the original click time', async () => {
        signInAs('account-a');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        syncMocks.getPushToken.mockReturnValue('push-token-a');
        const cutoff = Date.now();
        const incident = {
            incident_id: '00000000-0000-0000-0000-000000000001',
            token_id: '00000000-0000-0000-0000-000000000002',
            alarm_kind: 'drag',
            started_at: new Date(cutoff - 1000).toISOString(),
        };
        syncMocks.rpc.mockClear();
        syncMocks.rpc.mockResolvedValueOnce({ data: [incident, { ...incident, alarm_kind: 'gps_lost' }], error: null });
        syncMocks.rpc.mockResolvedValueOnce({ data: true, error: null });
        await expect(AnchorWatchSyncService.acknowledgeAlarmReminders('drag', cutoff)).resolves.toEqual([
            incident.incident_id,
        ]);
        expect(syncMocks.rpc.mock.calls).toEqual([
            [
                'list_active_anchor_alarm_incidents',
                {
                    p_session_code: 'ABCDEFGHJKLM',
                    p_device_token: 'push-token-a',
                    p_started_before: new Date(cutoff).toISOString(),
                },
            ],
            ['acknowledge_anchor_alarm', { p_incident_id: incident.incident_id, p_token_id: incident.token_id }],
        ]);
    });

    it.each(['account', 'token', 'session'])('does not ACK after the %s changes during lookup', async (change) => {
        signInAs('account-a');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        syncMocks.getPushToken.mockReturnValue('push-token-a');
        let complete!: (value: unknown) => void;
        syncMocks.rpc.mockClear();
        syncMocks.rpc.mockReturnValueOnce(
            new Promise((resolve) => {
                complete = resolve;
            }),
        );
        const pending = AnchorWatchSyncService.acknowledgeAlarmReminders('drag', Date.now());
        const rejected = expect(pending).rejects.toThrow('changed');
        await flushPromises();
        if (change === 'account') signInAs('account-b');
        if (change === 'token') syncMocks.getPushToken.mockReturnValue('push-token-b');
        if (change === 'session') await AnchorWatchSyncService.joinSession('NPQRSTUVWXYZ');
        complete({ data: [], error: null });
        await rejected;
        expect(syncMocks.rpc.mock.calls.some(([name]) => name === 'acknowledge_anchor_alarm')).toBe(false);
    });

    it.each(['no-match', 'future-incident', 'server-refusal'])(
        'does not claim a successful ACK for %s',
        async (failure) => {
            signInAs('account-a');
            await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
            syncMocks.getPushToken.mockReturnValue('push-token-a');
            const cutoff = Date.now();
            const row = {
                incident_id: '00000000-0000-0000-0000-000000000001',
                token_id: '00000000-0000-0000-0000-000000000002',
                alarm_kind: failure === 'no-match' ? 'gps_lost' : 'drag',
                started_at: new Date(cutoff + (failure === 'future-incident' ? 1000 : -1000)).toISOString(),
            };
            syncMocks.rpc.mockClear();
            syncMocks.rpc.mockResolvedValueOnce({ data: [row], error: null });
            syncMocks.rpc.mockResolvedValueOnce({ data: false, error: null });
            await expect(AnchorWatchSyncService.acknowledgeAlarmReminders('drag', cutoff)).rejects.toThrow();
            expect(syncMocks.rpc).toHaveBeenCalledTimes(failure === 'server-refusal' ? 2 : 1);
        },
    );

    it('relays GPS unavailable status without replacing a fix and fences the old channel', async () => {
        signInAs('account-a');
        await AnchorWatchSyncService.joinSession('ABCDEFGHJKLM');
        const first = syncMocks.channels[0];
        const fix = position();
        const status = {
            type: 'status',
            gpsAvailable: false,
            reason: 'gps_unavailable',
            source: 'pi',
            timestamp: Date.now(),
        };
        first.handlers.get('broadcast:position')?.({ payload: fix });
        first.handlers.get('broadcast:status')?.({ payload: status });
        expect(AnchorWatchSyncService.getLatestPosition()).toEqual(fix);
        expect(AnchorWatchSyncService.getLatestBroadcast()).toEqual(status);
        await AnchorWatchSyncService.joinSession('NPQRSTUVWXYZ');
        first.handlers.get('broadcast:status')?.({ payload: status });
        expect(AnchorWatchSyncService.getLatestBroadcast()).toBeNull();
        syncMocks.channels.at(-1)?.handlers.get('broadcast:status')?.({ payload: status });
        expect(AnchorWatchSyncService.getLatestBroadcast()).toEqual(status);
        signInAs('account-b');
        expect(AnchorWatchSyncService.getLatestBroadcast()).toBeNull();
    });
});
