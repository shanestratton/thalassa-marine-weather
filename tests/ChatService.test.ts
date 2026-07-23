/**
 * ChatService Unit Tests
 *
 * Tests the core chat business logic: init, messaging, subscriptions,
 * moderation, DMs, offline queue, and role-based access control.
 *
 * Strategy: Mock Supabase at the module level so ChatService operates
 * against a controlled fake backend. Uses vi.hoisted() to ensure mock
 * variables are available in hoisted vi.mock() factories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

// --- Mock fns (hoisted so vi.mock factories can reference them) ---
const {
    mockSingle,
    mockFrom: _mockFrom,
    mockGetUser,
    mockGetSession,
    mockRpc: _mockRpc,
    mockChannel,
    mockRemoveChannel,
    mockOn: _mockOn,
    mockSubscribe: _mockSubscribe,
    mockSupabase,
    mockPreferencesGet,
    mockPreferencesSet,
    mockOrderedQuery,
    mockOrder,
} = vi.hoisted(() => {
    const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const orderedQuery = {
        data: [],
        error: null,
        range: vi.fn().mockResolvedValue({ data: [], error: null }),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        order: null as unknown as ReturnType<typeof vi.fn>,
    };
    const mockOrder = vi.fn().mockReturnValue(orderedQuery);
    orderedQuery.order = mockOrder;
    const mockEq = vi.fn().mockReturnValue({
        single: mockSingle,
        eq: vi.fn().mockReturnValue({
            single: mockSingle,
            data: null,
            error: null,
        }),
        order: mockOrder,
    });
    const mockFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
            eq: mockEq,
            or: vi.fn().mockReturnValue({
                order: mockOrder,
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
            order: mockOrder,
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockReturnValue({ select: () => ({ single: mockSingle }) }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ data: null, error: null }) }),
        delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        }),
        upsert: vi.fn().mockReturnValue({ data: null, error: null }),
    });

    const mockGetUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-123', email: 'test@example.com', user_metadata: { display_name: 'TestUser' } } },
        error: null,
    });
    const mockGetSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-123' } } },
        error: null,
    });
    const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockSubscribe = vi.fn();
    const mockOn = vi.fn();
    const mockChannelObj = { on: mockOn };
    // subscribe() returns the channel object (so activeSubscriptions stores a truthy value)
    mockSubscribe.mockReturnValue(mockChannelObj);
    mockOn.mockReturnValue({ subscribe: mockSubscribe });
    const mockChannel = vi.fn().mockReturnValue({ on: mockOn });
    const mockRemoveChannel = vi.fn();
    const mockPreferencesGet = vi.fn().mockResolvedValue({ value: null });
    const mockPreferencesSet = vi.fn().mockResolvedValue(undefined);

    const mockSupabase = {
        from: mockFrom,
        auth: { getUser: mockGetUser, getSession: mockGetSession },
        rpc: mockRpc,
        channel: mockChannel,
        removeChannel: mockRemoveChannel,
    };

    return {
        mockSingle,
        mockFrom,
        mockGetUser,
        mockGetSession,
        mockRpc,
        mockChannel,
        mockRemoveChannel,
        mockOn,
        mockSubscribe,
        mockSupabase,
        mockPreferencesGet,
        mockPreferencesSet,
        mockOrderedQuery: orderedQuery,
        mockOrder,
    };
});

vi.mock('../services/supabase', () => ({
    supabase: mockSupabase,
    isSupabaseConfigured: () => true,
}));

vi.mock('../services/ContentModerationService', () => ({
    moderateMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: mockPreferencesGet,
        set: mockPreferencesSet,
        remove: vi.fn().mockResolvedValue(undefined),
    },
}));

// Import AFTER mocks are set up
import { ChatService } from '../services/ChatService';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

// --- Test Helpers ---
function resetChatService() {
    ChatService.destroy();
    (ChatService as any).initPromise = null;
    (ChatService as any).currentUserId = null;
    (ChatService as any).currentRole = 'member';
    (ChatService as any).mutedUntil = null;
    (ChatService as any).blocked = false;
    (ChatService as any).ownerUserId = null;
    (ChatService as any).cachedDisplayName = null;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('ChatService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        setAuthIdentityScope(null);
        setAuthIdentityScope('user-123');
        resetChatService();

        // Default: role query returns member
        mockSingle.mockResolvedValue({ data: { role: 'member', muted_until: null, is_blocked: false }, error: null });
    });

    afterEach(() => {
        ChatService.destroy();
        vi.useRealTimers();
    });

    // ═══════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════

    describe('initialize()', () => {
        it('deduplicates — calling twice only makes one auth request', async () => {
            const p1 = ChatService.initialize();
            const p2 = ChatService.initialize();
            await Promise.all([p1, p2]);
            // Should only have called getUser once, proving dedup
            expect(mockGetUser).toHaveBeenCalledTimes(1);
        });

        it('sets currentUserId from auth', async () => {
            await ChatService.initialize();
            expect(ChatService.getCurrentUserId()).toBe('user-123');
        });

        it('loads user role on init', async () => {
            mockSingle.mockResolvedValueOnce({
                data: { role: 'admin', muted_until: null, is_blocked: false },
                error: null,
            });
            await ChatService.initialize();
            expect(ChatService.getRole()).toBe('admin');
        });

        it('detects platform owner by email', async () => {
            setAuthIdentityScope('owner-1');
            mockGetUser.mockResolvedValueOnce({
                data: { user: { id: 'owner-1', email: 'shane.stratton@gmail.com', user_metadata: {} } },
                error: null,
            });
            await ChatService.initialize();
            expect((ChatService as any).ownerUserId).toBe('owner-1');
        });

        it('clears init promise on error — allows retry', async () => {
            mockGetUser.mockRejectedValueOnce(new Error('Network error'));
            await ChatService.initialize();
            expect((ChatService as any).initPromise).toBeNull();

            mockGetUser.mockResolvedValueOnce({
                data: { user: { id: 'user-456', email: 'retry@test.com', user_metadata: {} } },
                error: null,
            });
            setAuthIdentityScope('user-456');
            await ChatService.initialize();
            expect(ChatService.getCurrentUserId()).toBe('user-456');
        });
    });

    // ═══════════════════════════════════════
    // ROLE-BASED ACCESS
    // ═══════════════════════════════════════

    describe('role checks', () => {
        it('isMod() returns true for admin', () => {
            (ChatService as any).currentRole = 'admin';
            expect(ChatService.isMod()).toBe(true);
        });

        it('isMod() returns true for moderator', () => {
            (ChatService as any).currentRole = 'moderator';
            expect(ChatService.isMod()).toBe(true);
        });

        it('isMod() returns false for member', () => {
            (ChatService as any).currentRole = 'member';
            expect(ChatService.isMod()).toBe(false);
        });

        it('isAdmin() returns true only for admin role', () => {
            (ChatService as any).currentRole = 'moderator';
            expect(ChatService.isAdmin()).toBe(false);
            (ChatService as any).currentRole = 'admin';
            expect(ChatService.isAdmin()).toBe(true);
        });
    });

    // ═══════════════════════════════════════
    // MUTE DETECTION
    // ═══════════════════════════════════════

    describe('isMuted()', () => {
        it('returns true when user is platform-blocked', () => {
            (ChatService as any).blocked = true;
            expect(ChatService.isMuted()).toBe(true);
        });

        it('returns true when muted until future time', () => {
            (ChatService as any).mutedUntil = new Date(Date.now() + 60000);
            expect(ChatService.isMuted()).toBe(true);
        });

        it('returns false when mute has expired', () => {
            (ChatService as any).mutedUntil = new Date(Date.now() - 60000);
            expect(ChatService.isMuted()).toBe(false);
            expect(ChatService.getMutedUntil()).toBeNull();
        });

        it('returns false when not muted', () => {
            expect(ChatService.isMuted()).toBe(false);
        });
    });

    // ═══════════════════════════════════════
    // OWNER PROTECTION
    // ═══════════════════════════════════════

    describe('isOwnerProtected()', () => {
        it('returns true for the owner user ID', () => {
            (ChatService as any).ownerUserId = 'owner-1';
            expect(ChatService.isOwnerProtected('owner-1')).toBe(true);
        });

        it('returns false for non-owner', () => {
            (ChatService as any).ownerUserId = 'owner-1';
            expect(ChatService.isOwnerProtected('user-123')).toBe(false);
        });

        it('returns false when ownerUserId is null', () => {
            expect(ChatService.isOwnerProtected('anyone')).toBe(false);
        });
    });

    // ═══════════════════════════════════════
    // DISPLAY NAME CACHE
    // ═══════════════════════════════════════

    describe('display name cache', () => {
        it('clearDisplayNameCache() resets cached name', () => {
            (ChatService as any).cachedDisplayName = 'CachedName';
            ChatService.clearDisplayNameCache();
            expect((ChatService as any).cachedDisplayName).toBeNull();
        });

        it('destroy() also clears cached display name', () => {
            (ChatService as any).cachedDisplayName = 'CachedName';
            ChatService.destroy();
            expect((ChatService as any).cachedDisplayName).toBeNull();
        });
    });

    describe('channel cache identity isolation', () => {
        it('never returns account A cached channels to account B', async () => {
            localStorage.setItem(
                authScopedStorageKey('thalassa_chat_channels_v1'),
                JSON.stringify([{ id: 'private-a', name: 'Account A private channel' }]),
            );

            expect((await ChatService.getChannels()).map((channel) => channel.id)).toEqual(['private-a']);

            setAuthIdentityScope('user-456');
            expect(await ChatService.getChannels()).toEqual([]);

            localStorage.setItem(
                authScopedStorageKey('thalassa_chat_channels_v1'),
                JSON.stringify([{ id: 'private-b', name: 'Account B private channel' }]),
            );
            expect((await ChatService.getChannels()).map((channel) => channel.id)).toEqual(['private-b']);

            setAuthIdentityScope('user-123');
            expect((await ChatService.getChannels()).map((channel) => channel.id)).toEqual(['private-a']);
        });

        it('does not adopt the unattributable legacy channel cache', async () => {
            localStorage.setItem(
                'thalassa_chat_channels_v1',
                JSON.stringify([{ id: 'legacy-private', name: 'Unknown owner' }]),
            );

            expect(await ChatService.getChannels()).toEqual([]);
        });
    });

    // ═══════════════════════════════════════
    // CHANNELS
    // ═══════════════════════════════════════

    describe('getChannels()', () => {
        it('returns cached channels from localStorage when available', async () => {
            const cached = [{ id: 'ch-1', name: 'General', description: 'test', icon: '🌊' }];
            localStorage.setItem(authScopedStorageKey('thalassa_chat_channels_v1'), JSON.stringify(cached));

            const result = await ChatService.getChannels();
            expect(result).toEqual(cached);
        });
    });

    describe('bounded message reads', () => {
        it('clamps channel pagination before constructing the database range', async () => {
            await ChatService.getMessages('ch-1', Number.POSITIVE_INFINITY, -50);

            expect(mockOrderedQuery.range).toHaveBeenCalledWith(0, 49);

            await ChatService.getMessages('ch-1', 5_000, 50_000);
            expect(mockOrderedQuery.range).toHaveBeenLastCalledWith(10_000, 10_199);
        });

        it('bounds inbox aggregation and fetches the newest DM page', async () => {
            (ChatService as any).currentUserId = 'user-123';

            await ChatService.getDMConversations();
            expect(mockOrderedQuery.limit).toHaveBeenCalledWith(2_000);

            mockOrderedQuery.limit.mockClear();
            await ChatService.getDMThread('friend-123', 10_000);
            expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
            expect(mockOrderedQuery.limit).toHaveBeenCalledWith(200);
        });

        it('rejects unsafe raw-filter IDs before contacting the database', async () => {
            await expect(ChatService.getDMThread('friend),recipient_id.neq.null')).resolves.toEqual([]);
            expect(_mockFrom).not.toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════
    // SUBSCRIPTIONS
    // ═══════════════════════════════════════

    describe('subscribeToChannel()', () => {
        it('returns an unsubscribe function', () => {
            const unsub = ChatService.subscribeToChannel('ch-1', vi.fn());
            expect(typeof unsub).toBe('function');
        });

        it('creates a Supabase channel with correct name', () => {
            ChatService.subscribeToChannel('ch-1', vi.fn());
            expect(mockChannel).toHaveBeenCalledWith('chat:ch-1');
        });

        it('unsubscribes previous subscription for same channel', () => {
            ChatService.subscribeToChannel('ch-1', vi.fn());
            ChatService.subscribeToChannel('ch-1', vi.fn());
            expect(mockRemoveChannel).toHaveBeenCalled();
        });

        it('calling unsub removes the channel', () => {
            const unsub = ChatService.subscribeToChannel('ch-1', vi.fn());
            unsub();
            expect(mockRemoveChannel).toHaveBeenCalled();
        });
    });

    describe('subscribeToDMs()', () => {
        beforeEach(() => {
            (ChatService as any).currentUserId = 'user-123';
        });

        it('returns an unsubscribe function', () => {
            const unsub = ChatService.subscribeToDMs(vi.fn());
            expect(typeof unsub).toBe('function');
        });

        it('creates dm:inbox channel', () => {
            ChatService.subscribeToDMs(vi.fn());
            expect(mockChannel).toHaveBeenCalledWith('dm:inbox');
        });

        it('removes previous DM subscription if exists', () => {
            ChatService.subscribeToDMs(vi.fn());
            ChatService.subscribeToDMs(vi.fn());
            expect(mockRemoveChannel).toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════
    // MOD ACTIONS — AUTHORIZATION
    // ═══════════════════════════════════════

    describe('mod actions authorization', () => {
        it('deleteMessage() returns false when not a mod', async () => {
            (ChatService as any).currentRole = 'member';
            const result = await ChatService.deleteMessage('msg-1');
            expect(result).toBe(false);
        });

        it('pinMessage() returns false when not a mod', async () => {
            (ChatService as any).currentRole = 'member';
            const result = await ChatService.pinMessage('msg-1', true);
            expect(result).toBe(false);
        });

        it('muteUser() returns false when not a mod', async () => {
            (ChatService as any).currentRole = 'member';
            const result = await ChatService.muteUser('user-1', 24);
            expect(result).toBe(false);
        });

        it('muteUser() returns false for owner-protected user', async () => {
            (ChatService as any).currentRole = 'admin';
            (ChatService as any).ownerUserId = 'owner-1';
            const result = await ChatService.muteUser('owner-1', 24);
            expect(result).toBe(false);
        });

        it('setRole() prevents non-admins from changing roles', async () => {
            (ChatService as any).currentRole = 'moderator';
            const result = await ChatService.setRole('user-1', 'admin');
            expect(result).toBe(false);
        });

        it('setRole() prevents demoting yourself', async () => {
            (ChatService as any).currentRole = 'admin';
            (ChatService as any).currentUserId = 'user-123';
            const result = await ChatService.setRole('user-123', 'member');
            expect(result).toBe(false);
        });

        it('setRole() prevents demoting the platform owner', async () => {
            (ChatService as any).currentRole = 'admin';
            (ChatService as any).ownerUserId = 'owner-1';
            const result = await ChatService.setRole('owner-1', 'member');
            expect(result).toBe(false);
        });

        it('blockUserPlatform() returns false for non-admin', async () => {
            (ChatService as any).currentRole = 'moderator';
            const result = await ChatService.blockUserPlatform('user-1');
            expect(result).toBe(false);
        });

        it('blockUserPlatform() returns false for owner-protected user', async () => {
            (ChatService as any).currentRole = 'admin';
            (ChatService as any).ownerUserId = 'owner-1';
            const result = await ChatService.blockUserPlatform('owner-1');
            expect(result).toBe(false);
        });
    });

    // ═══════════════════════════════════════
    // OFFLINE QUEUE
    // ═══════════════════════════════════════

    describe('offline queue', () => {
        it('queues messages via Capacitor Preferences', async () => {
            mockPreferencesGet.mockResolvedValueOnce({ value: null });

            const queued = await (ChatService as any).queueOffline({
                type: 'channel',
                channel_id: 'ch-1',
                message: 'Hello from offline',
                timestamp: new Date().toISOString(),
            });

            expect(queued).toBe(true);
            expect(mockPreferencesSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: expect.any(String),
                    value: expect.stringContaining('Hello from offline'),
                }),
            );
        });

        it('appends to existing queue in Preferences', async () => {
            const existing = JSON.stringify([
                { type: 'channel', channel_id: 'ch-1', message: 'First', timestamp: new Date().toISOString() },
            ]);
            // No historical global queue; the existing value belongs to the
            // current identity-scoped key.
            mockPreferencesGet.mockResolvedValueOnce({ value: null }).mockResolvedValueOnce({ value: existing });

            await (ChatService as any).queueOffline({
                type: 'channel',
                channel_id: 'ch-1',
                message: 'Second',
                timestamp: new Date().toISOString(),
            });

            const setCallArg = mockPreferencesSet.mock.calls.at(-1)![0];
            const savedQueue = JSON.parse(setCallArg.value);
            expect(savedQueue).toHaveLength(2);
            expect(savedQueue[0].message).toBe('First');
            expect(savedQueue[1].message).toBe('Second');
        });

        it('reports when durable offline queue storage fails', async () => {
            mockPreferencesSet.mockRejectedValueOnce(new Error('disk full'));

            const queued = await (ChatService as any).queueOffline({
                type: 'dm',
                recipient_id: 'friend-1',
                message: 'Do not lose this',
                timestamp: new Date().toISOString(),
            });

            expect(queued).toBe(false);
        });

        it('retries a durably queued message after a short online backoff', async () => {
            vi.useFakeTimers();
            (ChatService as any).currentUserId = 'user-123';
            const syncSpy = vi.spyOn(ChatService as any, 'syncOfflineQueue').mockResolvedValue(0);

            const queued = await (ChatService as any).queueOffline({
                type: 'channel',
                channel_id: 'ch-1',
                message: 'Retry me',
                timestamp: new Date().toISOString(),
            });
            expect(queued).toBe(true);

            await vi.advanceTimersByTimeAsync(15_000);

            expect(syncSpy).toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('flushes queued messages immediately when connectivity returns', async () => {
            await ChatService.initialize();
            const syncSpy = vi.spyOn(ChatService as any, 'syncOfflineQueue').mockResolvedValue(0);
            vi.useFakeTimers();

            window.dispatchEvent(new Event('online'));
            await vi.advanceTimersByTimeAsync(0);

            expect(syncSpy).toHaveBeenCalled();
            vi.useRealTimers();
        });
    });

    describe('offline send identity verification', () => {
        beforeEach(() => {
            (ChatService as any).currentUserId = 'user-123';
        });

        it('durably queues a channel message from a matching local session when explicitly offline', async () => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

            const result = await ChatService.sendMessage('ch-1', 'Offline channel update');

            expect(result).toBe('queued');
            expect(mockGetUser).not.toHaveBeenCalled();
            expect(mockGetSession).toHaveBeenCalledTimes(1);
            expect(mockPreferencesSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: authScopedStorageKey('chat_offline_queue'),
                    value: expect.stringContaining('Offline channel update'),
                }),
            );
        });

        it('durably queues a DM after a retryable auth-network failure and matching local session', async () => {
            mockGetUser.mockResolvedValueOnce({
                data: { user: null },
                error: new AuthRetryableFetchError('network unavailable', 0),
            } as any);

            const result = await ChatService.sendDM('friend-1', 'Offline direct update');

            expect(result).toBe('queued');
            expect(mockGetSession).toHaveBeenCalledTimes(1);
            expect(mockPreferencesSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: authScopedStorageKey('chat_offline_queue'),
                    value: expect.stringContaining('Offline direct update'),
                }),
            );
        });

        it('does not queue channel messages or DMs when remote auth confirms sign-out', async () => {
            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: null,
            } as any);

            await expect(ChatService.sendMessage('ch-1', 'Do not queue channel')).resolves.toBeNull();
            await expect(ChatService.sendDM('friend-1', 'Do not queue DM')).resolves.toBeNull();

            expect(mockGetSession).not.toHaveBeenCalled();
            expect(mockPreferencesSet).not.toHaveBeenCalled();
        });

        it('does not queue when the locally persisted session belongs to another user', async () => {
            mockGetUser.mockRejectedValueOnce(new AuthRetryableFetchError('network unavailable', 0));
            mockGetSession.mockResolvedValueOnce({
                data: { session: { user: { id: 'user-456' } } },
                error: null,
            });

            await expect(ChatService.sendMessage('ch-1', 'Wrong owner')).resolves.toBeNull();
            expect(mockPreferencesSet).not.toHaveBeenCalled();
        });

        it.each([
            ['channel', () => ChatService.sendMessage('ch-1', 'Race channel')],
            ['DM', () => ChatService.sendDM('friend-1', 'Race DM')],
        ])('does not queue a %s when identity changes during local-session verification', async (_label, send) => {
            const localSession = deferred<{
                data: { session: { user: { id: string } } };
                error: null;
            }>();
            mockGetUser.mockRejectedValueOnce(new AuthRetryableFetchError('network unavailable', 0));
            mockGetSession.mockReturnValueOnce(localSession.promise);

            const pendingSend = send();
            await vi.waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1));
            setAuthIdentityScope('user-456');
            localSession.resolve({
                data: { session: { user: { id: 'user-123' } } },
                error: null,
            });

            await expect(pendingSend).resolves.toBeNull();
            expect(mockPreferencesSet).not.toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════
    // DESTROY / CLEANUP
    // ═══════════════════════════════════════

    describe('destroy()', () => {
        it('removes all active subscriptions and clears cache', () => {
            (ChatService as any).currentUserId = 'user-123';
            ChatService.subscribeToChannel('ch-1', vi.fn());
            ChatService.subscribeToDMs(vi.fn());

            ChatService.destroy();

            expect(mockRemoveChannel).toHaveBeenCalled();
            expect((ChatService as any).cachedDisplayName).toBeNull();
        });
    });
});
