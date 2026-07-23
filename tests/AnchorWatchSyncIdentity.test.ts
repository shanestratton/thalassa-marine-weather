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
    };
});

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    },
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

import { AnchorWatchSyncService } from '../services/AnchorWatchSyncService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const SESSION_KEY = 'thalassa_anchor_sync_session';

function signInAs(userId: string) {
    syncMocks.authUserId = userId;
    return setAuthIdentityScope(userId);
}

function flushPromises(): Promise<void> {
    return Promise.resolve().then(() => undefined);
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
        syncMocks.rpc.mockResolvedValue({ data: true, error: null });
        syncMocks.removeChannel.mockResolvedValue('ok');
        syncMocks.insertAlarm.mockResolvedValue({ error: null });
        syncMocks.upsertToken.mockResolvedValue({ error: null });
        syncMocks.requestPushToken.mockResolvedValue(null);
        syncMocks.getPushToken.mockReturnValue(null);
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
});
