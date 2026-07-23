import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const chatHarness = vi.hoisted(() => {
    type Result = { data?: any; error?: any; count?: number | null };
    const queued = new Map<string, Array<Result | Promise<Result>>>();
    const actions: Array<{
        table: string;
        action: string;
        payload?: unknown;
        filters: Array<[string, unknown]>;
        orFilter?: string;
    }> = [];
    const realtime: Array<{
        name: string;
        filter?: string;
        callback?: (payload: { eventType: string; new: Record<string, unknown> }) => void;
        channel: Record<string, unknown>;
    }> = [];
    const authQueue: Array<unknown | Promise<unknown>> = [];

    const key = (table: string, action: string) => `${table}:${action}`;
    const enqueue = (table: string, action: string, result: Result | Promise<Result>) => {
        const values = queued.get(key(table, action)) ?? [];
        values.push(result);
        queued.set(key(table, action), values);
    };
    const next = (table: string, action: string): Result | Promise<Result> => {
        const values = queued.get(key(table, action));
        return values?.shift() ?? { data: null, error: null, count: 0 };
    };

    const from = vi.fn((table: string) => {
        const operation = {
            table,
            action: 'select',
            payload: undefined as unknown,
            filters: [] as Array<[string, unknown]>,
            orFilter: undefined as string | undefined,
        };
        const query: Record<string, any> = {};
        for (const method of ['select', 'order', 'range', 'limit', 'in']) {
            query[method] = vi.fn(() => query);
        }
        query.eq = vi.fn((column: string, value: unknown) => {
            operation.filters.push([column, value]);
            return query;
        });
        query.or = vi.fn((filter: string) => {
            operation.orFilter = filter;
            return query;
        });
        for (const action of ['insert', 'update', 'delete', 'upsert']) {
            query[action] = vi.fn((payload?: unknown) => {
                operation.action = action;
                operation.payload = payload;
                actions.push(operation);
                return query;
            });
        }
        query.single = vi.fn(() => query);
        query.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(next(operation.table, operation.action)).then(resolve, reject);
        return query;
    });

    const getUser = vi.fn(() => {
        const nextAuth = authQueue.shift() ?? {
            data: { user: { id: 'account-a', email: 'a@example.com', user_metadata: {} } },
            error: null,
        };
        return Promise.resolve(nextAuth);
    });
    const removeChannel = vi.fn();
    const channel = vi.fn((name: string) => {
        const entry = { name, channel: {} as Record<string, unknown> } as (typeof realtime)[number];
        const channelObject = {
            on: vi.fn(
                (
                    _event: string,
                    config: { filter?: string },
                    callback: (payload: { eventType: string; new: Record<string, unknown> }) => void,
                ) => {
                    entry.filter = config.filter;
                    entry.callback = callback;
                    return channelObject;
                },
            ),
            subscribe: vi.fn(() => channelObject),
        };
        entry.channel = channelObject;
        realtime.push(entry);
        return channelObject;
    });

    const reset = () => {
        queued.clear();
        actions.length = 0;
        realtime.length = 0;
        authQueue.length = 0;
        from.mockClear();
        getUser.mockClear();
        removeChannel.mockClear();
        channel.mockClear();
    };

    return {
        actions,
        authQueue,
        channel,
        enqueue,
        from,
        getUser,
        realtime,
        removeChannel,
        reset,
        supabase: {
            from,
            auth: {
                getUser,
                onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
            },
            channel,
            removeChannel,
            rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
        },
    };
});

vi.mock('../services/supabase', () => ({
    supabase: chatHarness.supabase,
}));

vi.mock('../services/ContentModerationService', () => ({
    moderateMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn().mockResolvedValue({ value: null }),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
    },
}));

import { ChatService } from '../services/ChatService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

function switchTo(userId: string) {
    setAuthIdentityScope(userId);
    chatHarness.authQueue.push({
        data: { user: { id: userId, email: `${userId}@example.com`, user_metadata: {} } },
        error: null,
    });
}

describe('ChatService adversarial identity boundary', () => {
    beforeEach(() => {
        ChatService.destroy();
        chatHarness.reset();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        (ChatService as any).currentUserId = 'account-a';
        (ChatService as any).currentRole = 'member';
    });

    afterEach(() => {
        ChatService.destroy();
    });

    it('drops stale DM lists and never marks an A thread read after switching to B', async () => {
        const conversations = deferred<{ data: unknown[]; error: null }>();
        chatHarness.enqueue('direct_messages', 'select', conversations.promise);
        const conversationRequest = ChatService.getDMConversations();

        switchTo('account-b');
        conversations.resolve({
            data: [
                {
                    id: 'dm-a',
                    sender_id: 'account-a',
                    recipient_id: 'friend-a',
                    sender_name: 'A',
                    message: 'A private DM',
                    created_at: new Date().toISOString(),
                    read: false,
                },
            ],
            error: null,
        });
        await expect(conversationRequest).resolves.toEqual([]);

        setAuthIdentityScope('account-a');
        (ChatService as any).currentUserId = 'account-a';
        chatHarness.authQueue.push({
            data: { user: { id: 'account-a', email: 'a@example.com', user_metadata: {} } },
            error: null,
        });
        const thread = deferred<{ data: unknown[]; error: null }>();
        chatHarness.enqueue('direct_messages', 'select', thread.promise);
        const threadRequest = ChatService.getDMThread('friend-a');
        await vi.waitFor(() => expect(chatHarness.getUser).toHaveBeenCalled());

        switchTo('account-b');
        thread.resolve({
            data: [
                {
                    id: 'dm-thread-a',
                    sender_id: 'friend-a',
                    recipient_id: 'account-a',
                    message: 'A unread',
                    created_at: new Date().toISOString(),
                    read: false,
                },
            ],
            error: null,
        });

        await expect(threadRequest).resolves.toEqual([]);
        expect(chatHarness.actions.filter((action) => action.action === 'update')).toEqual([]);
    });

    it('prevents stale block writes and returns zero for stale unread results', async () => {
        const auth = deferred<{
            data: { user: { id: string; email: string; user_metadata: object } };
            error: null;
        }>();
        chatHarness.authQueue.push(auth.promise);
        const blockRequest = ChatService.blockUser('target-user');

        switchTo('account-b');
        auth.resolve({
            data: { user: { id: 'account-a', email: 'a@example.com', user_metadata: {} } },
            error: null,
        });
        await expect(blockRequest).resolves.toBe(false);
        expect(chatHarness.actions.filter((action) => action.action === 'upsert')).toEqual([]);

        setAuthIdentityScope('account-a');
        (ChatService as any).currentUserId = 'account-a';
        const unread = deferred<{ data: null; error: null; count: number }>();
        chatHarness.enqueue('direct_messages', 'select', unread.promise);
        const unreadRequest = ChatService.getUnreadDMCount();
        switchTo('account-b');
        unread.resolve({ data: null, error: null, count: 9 });
        await expect(unreadRequest).resolves.toBe(0);
    });

    it('rejects foreign realtime rows and all callbacks from an A channel after cutover', () => {
        const onDm = vi.fn();
        const unsubscribe = ChatService.subscribeToDMs(onDm);
        const realtime = chatHarness.realtime.at(-1)!;

        realtime.callback?.({
            eventType: 'INSERT',
            new: { id: 'foreign', recipient_id: 'account-b', sender_id: 'x' },
        });
        expect(onDm).not.toHaveBeenCalled();

        switchTo('account-b');
        realtime.callback?.({
            eventType: 'INSERT',
            new: { id: 'stale-a', recipient_id: 'account-a', sender_id: 'x' },
        });
        expect(onDm).not.toHaveBeenCalled();

        unsubscribe();
        expect(chatHarness.removeChannel).toHaveBeenCalledTimes(1);

        setAuthIdentityScope('account-a');
        (ChatService as any).currentUserId = 'account-a';
        const onChannel = vi.fn();
        const unsubscribeA = ChatService.subscribeToChannel('channel-a', onChannel);
        const realtimeA = chatHarness.realtime.at(-1)!;
        realtimeA.callback?.({
            eventType: 'INSERT',
            new: { id: 'foreign-channel-row', channel_id: 'channel-b' },
        });
        expect(onChannel).not.toHaveBeenCalled();

        switchTo('account-b');
        realtimeA.callback?.({
            eventType: 'INSERT',
            new: { id: 'stale-channel-row', channel_id: 'channel-a' },
        });
        expect(onChannel).not.toHaveBeenCalled();

        ChatService.subscribeToChannel('channel-a', vi.fn());
        const removalsBeforeOldCleanup = chatHarness.removeChannel.mock.calls.length;
        unsubscribeA();
        expect(chatHarness.removeChannel).toHaveBeenCalledTimes(removalsBeforeOldCleanup);
    });

    it('stops join and admin multi-stage flows before their first post-switch write', async () => {
        chatHarness.authQueue.push({
            data: { user: { id: 'account-a', email: 'a@example.com', user_metadata: {} } },
            error: null,
        });
        const membership = deferred<{ data: null; error: null }>();
        chatHarness.enqueue('channel_members', 'select', membership.promise);
        const joinRequest = ChatService.requestJoinChannel('private-channel', 'let me in');
        await vi.waitFor(() => expect(chatHarness.getUser).toHaveBeenCalled());

        switchTo('account-b');
        membership.resolve({ data: null, error: null });
        await expect(joinRequest).resolves.toBe(false);
        expect(
            chatHarness.actions.filter(
                (action) => action.table === 'channel_join_requests' && action.action === 'insert',
            ),
        ).toEqual([]);

        setAuthIdentityScope('account-a');
        (ChatService as any).currentUserId = 'account-a';
        (ChatService as any).currentRole = 'admin';
        chatHarness.authQueue.length = 0;
        chatHarness.authQueue.push({
            data: { user: { id: 'account-a', email: 'a@example.com', user_metadata: {} } },
            error: null,
        });
        chatHarness.enqueue('chat_roles', 'select', { data: { role: 'admin' }, error: null });
        const proposal = deferred<{
            data: { owner_id: string; is_private: boolean };
            error: null;
        }>();
        chatHarness.enqueue('chat_channels', 'select', proposal.promise);
        const approve = ChatService.approveChannel('proposal-a');
        await vi.waitFor(() => expect(chatHarness.from).toHaveBeenCalledWith('chat_channels'));

        switchTo('account-b');
        proposal.resolve({ data: { owner_id: 'owner-a', is_private: true }, error: null });
        await expect(approve).resolves.toBe(false);
        expect(
            chatHarness.actions.filter((action) => action.table === 'chat_channels' && action.action === 'update'),
        ).toEqual([]);
    });

    it('does not let a deferred A initializer overwrite B identity or role', async () => {
        const authA = deferred<{
            data: { user: { id: string; email: string; user_metadata: object } };
            error: null;
        }>();
        chatHarness.authQueue.push(authA.promise);
        const initA = ChatService.initialize();

        switchTo('account-b');
        chatHarness.enqueue('chat_roles', 'select', {
            data: { role: 'moderator', muted_until: null, is_blocked: false },
            error: null,
        });
        const initB = ChatService.initialize();

        authA.resolve({
            data: { user: { id: 'account-a', email: 'a@example.com', user_metadata: {} } },
            error: null,
        });
        await Promise.all([initA, initB]);

        expect(ChatService.getCurrentUserId()).toBe('account-b');
        expect(ChatService.getRole()).toBe('moderator');
    });
});
