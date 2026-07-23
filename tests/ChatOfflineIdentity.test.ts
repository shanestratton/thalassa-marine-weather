import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    userId: 'account-a',
    failChannel: false,
    failDm: false,
    inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: state.preferences[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            state.preferences[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete state.preferences[key];
        }),
    },
}));

vi.mock('../services/supabase', () => {
    const from = vi.fn((table: string) => ({
        insert: (payload: Record<string, unknown>) => ({
            select: () => ({
                single: async () => {
                    state.inserts.push({ table, payload });
                    const failed =
                        (table === 'chat_messages' && state.failChannel) ||
                        (table === 'chat_direct_messages' && state.failDm);
                    return failed
                        ? { data: null, error: { message: 'offline', details: null, hint: null } }
                        : {
                              data: {
                                  id: `${table}-${state.inserts.length}`,
                                  ...payload,
                              },
                              error: null,
                          };
                },
            }),
        }),
        select: () => ({
            eq: () => ({
                single: async () => ({ data: null, error: null }),
            }),
            or: () => ({
                limit: async () => ({ data: [], error: null }),
            }),
        }),
    }));
    return {
        supabase: {
            auth: {
                getUser: vi.fn(async () => ({
                    data: {
                        user: {
                            id: state.userId,
                            email: `${state.userId}@example.com`,
                            user_metadata: { display_name: state.userId },
                        },
                    },
                    error: null,
                })),
            },
            from,
            rpc: vi.fn(async () => ({ data: null, error: null })),
            removeChannel: vi.fn(),
        },
        isSupabaseConfigured: () => true,
    };
});

vi.mock('../services/ContentModerationService', () => ({
    moderateMessage: vi.fn(async () => undefined),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ChatService } from '../services/ChatService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

type StoredChatMessage = {
    type: 'channel' | 'dm';
    message: string;
    owner_user_id: string | null;
    queue_id: string;
};

function setIdentity(userId: string | null): void {
    setAuthIdentityScope(userId);
    state.userId = userId ?? '';
    (ChatService as unknown as { currentUserId: string | null }).currentUserId = userId;
}

async function queue(message: Record<string, unknown>): Promise<void> {
    await (
        ChatService as unknown as {
            queueOffline: (message: Record<string, unknown>) => Promise<void>;
        }
    ).queueOffline(message);
}

async function sync(): Promise<void> {
    await (
        ChatService as unknown as {
            syncOfflineQueue: () => Promise<void>;
        }
    ).syncOfflineQueue();
}

function storedQueue(userId: string): StoredChatMessage[] {
    const current = getAuthIdentityScope();
    const scope = {
        key: `user:${userId}`,
        userId,
        generation: current.generation,
    };
    const value = state.preferences[authScopedStorageKey('chat_offline_queue', scope)];
    return value ? (JSON.parse(value) as StoredChatMessage[]) : [];
}

beforeEach(() => {
    for (const key of Object.keys(state.preferences)) delete state.preferences[key];
    state.inserts.length = 0;
    state.failChannel = false;
    state.failDm = false;
    setAuthIdentityScope(null);
    setIdentity('account-a');
    (ChatService as unknown as { offlineQueueMutationTail: Promise<void> }).offlineQueueMutationTail =
        Promise.resolve();
});

describe('ChatService identity-scoped offline queue', () => {
    it('keeps A and B isolated across A → B → A and preserves channel/DM type', async () => {
        await queue({
            type: 'channel',
            channel_id: 'channel-a',
            message: 'A channel',
            timestamp: '2026-07-23T00:00:00Z',
        });
        await queue({
            type: 'dm',
            recipient_id: 'friend-a',
            message: 'A direct',
            timestamp: '2026-07-23T00:01:00Z',
        });

        setIdentity('account-b');
        await queue({
            type: 'channel',
            channel_id: 'channel-b',
            message: 'B channel',
            timestamp: '2026-07-23T00:02:00Z',
        });
        expect(storedQueue('account-b')).toHaveLength(1);

        setIdentity('account-a');
        await sync();

        expect(storedQueue('account-a')).toEqual([]);
        expect(storedQueue('account-b').map((message) => message.message)).toEqual(['B channel']);
        expect(state.inserts.map(({ table, payload }) => [table, payload.message])).toEqual([
            ['chat_messages', 'A channel'],
            ['chat_direct_messages', 'A direct'],
        ]);
        expect(state.inserts[0].payload.user_id).toBe('account-a');
        expect(state.inserts[1].payload.sender_id).toBe('account-a');

        state.inserts.length = 0;
        setIdentity('account-b');
        await sync();
        expect(state.inserts).toHaveLength(1);
        expect(state.inserts[0]).toMatchObject({
            table: 'chat_messages',
            payload: { message: 'B channel', user_id: 'account-b' },
        });
    });

    it('removes only confirmed successes and retains a failed channel message', async () => {
        await queue({
            type: 'channel',
            channel_id: 'channel-a',
            message: 'retry channel',
            timestamp: '2026-07-23T00:00:00Z',
        });
        await queue({
            type: 'dm',
            recipient_id: 'friend-a',
            message: 'send direct',
            timestamp: '2026-07-23T00:01:00Z',
        });
        state.failChannel = true;

        await sync();

        expect(storedQueue('account-a')).toMatchObject([
            {
                type: 'channel',
                message: 'retry channel',
                owner_user_id: 'account-a',
            },
        ]);
        expect(state.inserts.map(({ table }) => table)).toEqual(['chat_messages', 'chat_direct_messages']);
    });

    it('quarantines unattributed legacy messages instead of replaying them as the next account', async () => {
        state.preferences.chat_offline_queue = JSON.stringify([
            {
                type: 'channel',
                channel_id: 'legacy-channel',
                message: 'unknown owner',
                timestamp: '2026-07-22T00:00:00Z',
            },
        ]);

        await sync();

        expect(state.inserts).toEqual([]);
        expect(state.preferences.chat_offline_queue).toBeUndefined();
        expect(state.preferences.chat_offline_queue_quarantine_v2).toContain('unknown owner');
    });

    it('adopts only explicitly owned legacy messages and leaves another owner untouched', async () => {
        state.preferences.chat_offline_queue = JSON.stringify([
            {
                type: 'channel',
                channel_id: 'channel-a',
                message: 'owned by A',
                timestamp: '2026-07-22T00:00:00Z',
                owner_user_id: 'account-a',
            },
            {
                type: 'dm',
                recipient_id: 'friend-b',
                message: 'owned by B',
                timestamp: '2026-07-22T00:01:00Z',
                owner_user_id: 'account-b',
            },
        ]);

        await sync();
        expect(state.inserts.map(({ payload }) => payload.message)).toEqual(['owned by A']);
        expect(state.preferences.chat_offline_queue).toContain('owned by B');

        state.inserts.length = 0;
        setIdentity('account-b');
        await sync();
        expect(state.inserts.map(({ payload }) => payload.message)).toEqual(['owned by B']);
        expect(state.preferences.chat_offline_queue).toBeUndefined();
    });
});
