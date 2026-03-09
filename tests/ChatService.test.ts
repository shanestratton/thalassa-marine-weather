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

// --- Mock fns (hoisted so vi.mock factories can reference them) ---
const {
    mockSingle, mockFrom, mockGetUser, mockRpc,
    mockChannel, mockRemoveChannel, mockOn, mockSubscribe,
    mockSupabase, mockPreferencesGet, mockPreferencesSet,
} = vi.hoisted(() => {
    const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockOrder = vi.fn().mockReturnValue({
        range: vi.fn().mockResolvedValue({ data: [], error: null }),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    const mockEq = vi.fn().mockReturnValue({
        single: mockSingle,
        eq: vi.fn().mockReturnValue({
            single: mockSingle,
            data: null, error: null,
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
        delete: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
        upsert: vi.fn().mockReturnValue({ data: null, error: null }),
    });

    const mockGetUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-123', email: 'test@example.com', user_metadata: { display_name: 'TestUser' } } },
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
        auth: { getUser: mockGetUser },
        rpc: mockRpc,
        channel: mockChannel,
        removeChannel: mockRemoveChannel,
    };

    return {
        mockSingle, mockFrom, mockGetUser, mockRpc,
        mockChannel, mockRemoveChannel, mockOn, mockSubscribe,
        mockSupabase, mockPreferencesGet, mockPreferencesSet,
    };
});

vi.mock('../services/supabase', () => ({
    supabase: mockSupabase,
    isSupabaseConfigured: () => true,
}));

vi.mock('../services/ContentModerationService', () => ({
    moderateMessage: vi.fn().mockResolvedValue(undefined),
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

describe('ChatService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        resetChatService();

        // Default: role query returns member
        mockSingle.mockResolvedValue({ data: { role: 'member', muted_until: null, is_blocked: false }, error: null });
    });

    afterEach(() => {
        ChatService.destroy();
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
            mockSingle.mockResolvedValueOnce({ data: { role: 'admin', muted_until: null, is_blocked: false }, error: null });
            await ChatService.initialize();
            expect(ChatService.getRole()).toBe('admin');
        });

        it('detects platform owner by email', async () => {
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

    // ═══════════════════════════════════════
    // CHANNELS
    // ═══════════════════════════════════════

    describe('getChannels()', () => {
        it('returns cached channels from localStorage when available', async () => {
            const cached = [{ id: 'ch-1', name: 'General', description: 'test', icon: '🌊' }];
            localStorage.setItem('thalassa_chat_channels_v1', JSON.stringify(cached));

            const result = await ChatService.getChannels();
            expect(result).toEqual(cached);
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

            await (ChatService as any).queueOffline({
                type: 'channel',
                channel_id: 'ch-1',
                message: 'Hello from offline',
                timestamp: new Date().toISOString(),
            });

            expect(mockPreferencesSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: expect.any(String),
                    value: expect.stringContaining('Hello from offline'),
                })
            );
        });

        it('appends to existing queue in Preferences', async () => {
            const existing = JSON.stringify([{ type: 'channel', channel_id: 'ch-1', message: 'First', timestamp: new Date().toISOString() }]);
            mockPreferencesGet.mockResolvedValueOnce({ value: existing });

            await (ChatService as any).queueOffline({
                type: 'channel',
                channel_id: 'ch-1',
                message: 'Second',
                timestamp: new Date().toISOString(),
            });

            const setCallArg = mockPreferencesSet.mock.calls[0][0];
            const savedQueue = JSON.parse(setCallArg.value);
            expect(savedQueue).toHaveLength(2);
            expect(savedQueue[0].message).toBe('First');
            expect(savedQueue[1].message).toBe('Second');
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
