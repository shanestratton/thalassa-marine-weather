/** Real client service/policy with synthetic Auth, SQL and Preferences adapters.
 * These prove local admission/cancellation behavior, not encryption, server
 * enforcement, physical-device behavior or rollback of dispatched writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthIdentityScope } from '../services/authIdentityScope';

const fixture = vi.hoisted(() => {
    type Result = { data: unknown; error: unknown; count?: number | null };
    type AuthResult = { data: { user: { id: string; email: string; user_metadata: object } }; error: null };
    type Operation = {
        table: string;
        action: string;
        method?: string;
        payload?: unknown;
        filters: Array<[string, unknown]>;
    };
    type Payload = { eventType: string; new: Record<string, unknown> };
    const state = { userId: 'account-a' };
    const preferences = new Map<string, string>();
    const plans = new Map<string, Array<Result | Promise<Result>>>();
    const tokenGates = new Map<string, Promise<void>>();
    const tokenEntered: string[] = [];
    const signals: Array<{ key: string; signal: AbortSignal }> = [];
    const dispatches: Array<{
        key: string;
        body: BodyInit | null | undefined;
        transport: 'browser' | 'patched-native';
    }> = [];
    const requests = new Map<string, { key: string; perform: () => Result | Promise<Result> }>();
    const responses = new Map<string, Result>();
    let guardedFetch: typeof fetch | undefined;
    let requestNumber = 0;
    const actions: Operation[] = [];
    const channels: Array<{
        name: string;
        channel: Record<string, unknown>;
        handlers: Array<{ config: { table?: string; filter?: string }; callback: (payload: Payload) => void }>;
    }> = [];
    const authReply = (): AuthResult => ({
        data: {
            user: {
                id: state.userId,
                email: 'fixture@example.test',
                user_metadata: { display_name: 'Fixture sailor' },
            },
        },
        error: null,
    });
    const enqueue = (table: string, action: string, reply: Result | Promise<Result>) => {
        const key = `${table}:${action}`,
            queue = plans.get(key) ?? [];
        queue.push(reply);
        plans.set(key, queue);
    };
    const performTransport = async (
        input: RequestInfo | URL,
        init: RequestInit | undefined,
        transport: 'browser' | 'patched-native',
    ): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const request = requests.get(url);
        if (!request) throw new Error('Unknown synthetic transport request');
        dispatches.push({ key: request.key, body: init?.body, transport });
        const reply = await request.perform();
        responses.set(url, reply);
        // Encode a nonsecret lookup token, then recover the opaque decoded
        // adapter result. This retains the separate poison-getter projection
        // fixtures without JSON serialization itself touching their getters.
        return new Response(JSON.stringify({ fixtureResponse: url }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    // The patched native transport deliberately ignores AbortSignal. Private
    // requests must use the preserved browser source through the REAL gate.
    const nativeFetch = vi.fn<typeof fetch>((input, init) => performTransport(input, init, 'patched-native'));
    const browserFetch = vi.fn<typeof fetch>((input, init) => performTransport(input, init, 'browser'));
    const lazyRequest = (key: string, method: string, payload: unknown, perform: () => Result | Promise<Result>) => {
        const query: Record<string, unknown> = {};
        let signal: AbortSignal | undefined;
        let pending: Promise<Result> | undefined;
        query.abortSignal = vi.fn((value: AbortSignal) => {
            signal = value;
            signals.push({ key, signal: value });
            return query;
        });
        query.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
            if (!pending) {
                pending = (async () => {
                    tokenEntered.push(key);
                    const token = tokenGates.get(key);
                    if (token) await token;
                    if (!guardedFetch) throw new Error('Real guarded fetch fixture was not configured');
                    const route = key.startsWith('rpc:') ? `rpc/${key.slice(4)}` : key.split(':')[0];
                    const url = `https://fixture.supabase.invalid/rest/v1/${route}?fixture_request=${++requestNumber}`;
                    requests.set(url, { key, perform });
                    const response = await guardedFetch(url, {
                        method,
                        signal,
                        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
                    });
                    const decoded = (await response.json()) as { fixtureResponse: string };
                    const reply = responses.get(decoded.fixtureResponse);
                    if (!reply) throw new Error('Unknown synthetic SDK response');
                    return reply;
                })();
            }
            return pending.then(resolve, reject);
        };
        return query;
    };
    const from = vi.fn((table: string) => {
        const operation: Operation = { table, action: 'select', filters: [] };
        const query: Record<string, unknown> = {};
        let signal: AbortSignal | undefined;
        let request: Record<string, unknown> | undefined;
        for (const method of ['order', 'range', 'limit', 'in', 'or', 'neq', 'gte', 'lt'])
            query[method] = vi.fn(() => query);
        query.select = vi.fn((_columns?: string, options?: { head?: boolean }) => {
            if (operation.action === 'select' && options?.head) operation.method = 'HEAD';
            return query;
        });
        query.eq = vi.fn((column: string, value: unknown) => {
            operation.filters.push([column, value]);
            return query;
        });
        for (const action of ['insert', 'update', 'delete', 'upsert'])
            query[action] = vi.fn((payload?: unknown) => {
                operation.action = action;
                operation.payload = payload;
                return query;
            });
        query.abortSignal = vi.fn((value: AbortSignal) => {
            signal = value;
            return query;
        });
        query.single = vi.fn(() => query);
        query.maybeSingle = vi.fn(() => query);
        query.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
            if (!request) {
                const key = `${table}:${operation.action}`;
                request = lazyRequest(
                    key,
                    operation.action === 'select'
                        ? (operation.method ?? 'GET')
                        : operation.action === 'update'
                          ? 'PATCH'
                          : 'POST',
                    operation.payload,
                    () => {
                        actions.push({ ...operation, filters: [...operation.filters] });
                        const planned = plans.get(key)?.shift();
                        const defaultData =
                            operation.action === 'insert'
                                ? {
                                      id: `fixture-${actions.length}`,
                                      created_at: '2026-10-06T00:00:00Z',
                                      read: false,
                                      ...(operation.payload as Record<string, unknown>),
                                  }
                                : operation.action === 'select'
                                  ? []
                                  : null;
                        return planned ?? { data: defaultData, error: null, count: 0 };
                    },
                );
                if (signal) (request.abortSignal as (value: AbortSignal) => unknown)(signal);
            }
            return (
                request.then as (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => unknown
            )(resolve, reject);
        };
        return query;
    });
    const getUser = vi.fn<() => Promise<AuthResult>>(async () => authReply());
    const getSession = vi.fn(async () => ({ data: { session: { user: { id: state.userId } } }, error: null }));
    const rpcReply = async (name: string, args?: unknown): Promise<Result> => ({
        data:
            name === 'get_chat_dm_block_status'
                ? { blockedByMe: false, blockedEitherDirection: false }
                : name === 'set_chat_user_block'
                  ? {
                        blockedByMe: !!(args as Record<string, unknown>).p_blocked,
                        blockedEitherDirection: !!(args as Record<string, unknown>).p_blocked,
                    }
                  : null,
        error: null,
    });
    const rpcQuery = (name: string, args?: unknown, reply?: Result | Promise<Result>) =>
        lazyRequest(`rpc:${name}`, 'POST', args, () => reply ?? rpcReply(name, args));
    const rpc = vi.fn<(name: string, args?: unknown) => Record<string, unknown>>(rpcQuery);
    const removeChannel = vi.fn<(channel: unknown) => void>(() => undefined);
    const channel = vi.fn((name: string) => {
        const api: Record<string, unknown> = {};
        const entry = { name, channel: api, handlers: [] } as (typeof channels)[number];
        api.on = vi.fn(
            (_event: string, config: { table?: string; filter?: string }, callback: (payload: Payload) => void) => {
                entry.handlers.push({ config, callback });
                return api;
            },
        );
        api.subscribe = vi.fn(() => api);
        channels.push(entry);
        return api;
    });
    const get = vi.fn(async ({ key }: { key: string }) => ({ value: preferences.get(key) ?? null }));
    const set = vi.fn(async ({ key, value }: { key: string; value: string }) => {
        preferences.set(key, value);
    });
    const remove = vi.fn(async ({ key }: { key: string }) => {
        preferences.delete(key);
    });
    const reset = () => {
        state.userId = 'account-a';
        preferences.clear();
        plans.clear();
        tokenGates.clear();
        tokenEntered.length = 0;
        signals.length = 0;
        dispatches.length = 0;
        requests.clear();
        responses.clear();
        requestNumber = 0;
        guardedFetch = undefined;
        nativeFetch.mockClear();
        browserFetch.mockClear();
        actions.length = 0;
        channels.length = 0;
        from.mockClear();
        channel.mockClear();
        getUser.mockReset().mockImplementation(async () => authReply());
        getSession
            .mockReset()
            .mockImplementation(async () => ({ data: { session: { user: { id: state.userId } } }, error: null }));
        rpc.mockReset().mockImplementation(rpcQuery);
        removeChannel.mockReset().mockImplementation(() => undefined);
        get.mockReset().mockImplementation(async ({ key }) => ({ value: preferences.get(key) ?? null }));
        set.mockReset().mockImplementation(async ({ key, value }) => {
            preferences.set(key, value);
        });
        remove.mockReset().mockImplementation(async ({ key }) => {
            preferences.delete(key);
        });
    };
    return {
        state,
        preferences,
        actions,
        channels,
        enqueue,
        tokenGates,
        tokenEntered,
        signals,
        dispatches,
        nativeFetch,
        browserFetch,
        rpcQuery,
        configureFetch: (value: typeof fetch) => {
            guardedFetch = value;
        },
        authReply,
        reset,
        from,
        getUser,
        getSession,
        rpc,
        removeChannel,
        get,
        set,
        remove,
        supabase: {
            from,
            channel,
            removeChannel,
            rpc,
            auth: {
                getUser,
                getSession,
                onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
            },
        },
    };
});

vi.mock('../services/supabase', () => ({ supabase: fixture.supabase, isSupabaseConfigured: () => true }));
vi.mock('@capacitor/preferences', () => ({
    Preferences: { get: fixture.get, set: fixture.set, remove: fixture.remove },
}));
vi.mock('../services/ContentModerationService', () => ({ moderateMessage: vi.fn(async () => undefined) }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Service = typeof import('../services/ChatService').ChatService;
type Queued = {
    type: 'channel' | 'dm';
    message: string;
    timestamp: string;
    recipient_id?: string;
    channel_id?: string;
    queue_id?: string;
    owner_user_id?: string;
    opaqueLegacyExtra?: string;
};
type Internals = {
    currentUserId: string | null;
    currentRole: string;
    mutedUntil: string | null;
    blocked: boolean;
    offlineQueueMutationTail: Promise<void>;
    queueOffline: (value: Queued, scope?: AuthIdentityScope) => Promise<boolean>;
    syncOfflineQueue: (scope?: AuthIdentityScope) => Promise<number>;
};
let service: Service;
let identity: typeof import('../services/authIdentityScope');
let policy: typeof import('../services/chat/e2ee/privateMessageCutover');
let Refusal: typeof import('../services/ChatService').LegacyPrivateMessagesUnavailableError;
const DM = 'chat_direct_messages',
    PUBLIC = 'chat_messages';
const refusal = {
    name: 'PrivateMessageLegacyUnavailableError',
    code: 'legacy-private-messages-unavailable',
    message: 'Legacy private messaging is unavailable.',
};
const scope = () => identity.getAuthIdentityScope();
const key = () => identity.authScopedStorageKey('chat_offline_queue', scope());
const internals = () => service as unknown as Internals;
const latch = () => expect(policy.requireNativePrivateMessagesForScope(scope())).toBe(true);
const operations = (table: string, action?: string) =>
    fixture.actions.filter((value) => value.table === table && (!action || value.action === action));
const dmRow = (text = 'Synthetic legacy private text', sender = 'peer-a') => ({
    id: 'dm-fixture',
    sender_id: sender,
    recipient_id: 'account-a',
    sender_name: 'Fixture peer',
    message: text,
    read: false,
    created_at: '2026-10-06T00:00:00Z',
});
const queuedDM = (): Queued => ({
    type: 'dm',
    recipient_id: 'peer-a',
    message: 'Held synthetic private text',
    timestamp: '2026-10-06T00:00:00Z',
    queue_id: 'held-dm',
    owner_user_id: 'account-a',
    opaqueLegacyExtra: 'retain-exactly',
});
const queuedPublic = (): Queued => ({
    type: 'channel',
    channel_id: 'public-channel',
    message: 'Public queued control',
    timestamp: '2026-10-06T00:01:00Z',
    queue_id: 'public-item',
    owner_user_id: 'account-a',
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
async function refuses(work: Promise<unknown>) {
    await expect(work).rejects.toBeInstanceOf(Refusal);
    await expect(work).rejects.toMatchObject(refusal);
}
function noPrivateDispatch() {
    expect(operations(DM)).toEqual([]);
    expect(fixture.rpc.mock.calls.filter(([name]) => name === 'queue_dm_push')).toEqual([]);
    expect(fixture.set).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
}

beforeEach(async () => {
    vi.resetModules();
    fixture.reset();
    identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(null);
    identity.setAuthIdentityScope('account-a');
    policy = await import('../services/chat/e2ee/privateMessageCutover');
    const { createLegacyPrivateMessageFetchGate } = await import('../services/chat/e2ee/legacyPrivateMessageFetchGate');
    fixture.configureFetch(
        createLegacyPrivateMessageFetchGate({
            supabaseUrl: 'https://fixture.supabase.invalid',
            isNative: () => true,
            publicFetch: fixture.nativeFetch,
            getPrivateBrowserFetch: () => fixture.browserFetch,
        }),
    );
    ({ ChatService: service, LegacyPrivateMessagesUnavailableError: Refusal } =
        await import('../services/ChatService'));
    Object.assign(internals(), {
        currentUserId: 'account-a',
        currentRole: 'member',
        mutedUntil: null,
        blocked: false,
        offlineQueueMutationTail: Promise.resolve(),
    });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
    service?.destroy();
    vi.restoreAllMocks();
});

describe('legacy private-message cutover — synthetic service adapters', () => {
    it('preserves a default legacy send and authenticated thread-read/mark-read positive control', async () => {
        expect(await service.sendDM('peer-a', 'Legacy allowed control')).toMatchObject({
            message: 'Legacy allowed control',
        });
        fixture.enqueue(DM, 'select', { data: [dmRow()], error: null });
        expect(await service.getDMThread('peer-a')).toEqual([dmRow()]);
        expect(operations(DM, 'insert')).toHaveLength(1);
        expect(operations(DM, 'update')).toHaveLength(1);
    });

    it.each([
        ['text send', (value: Service) => value.sendDM('peer-a', 'Refused text')],
        ['self send', (value: Service) => value.sendDM('account-a', 'Refused self text')],
        ['pin send', (value: Service) => value.sendPinDrop('peer-a', -27.47, 153.02, 'Refused pin')],
        ['recipe send', (value: Service) => value.sendRecipeShareDM('peer-a', '🍳RECIPE:fixture')],
        ['inbox read', (value: Service) => value.getDMConversations()],
        ['thread read', (value: Service) => value.getDMThread('peer-a')],
        ['unread count', (value: Service) => value.getUnreadDMCount()],
        ['blocked-user list', (value: Service) => value.getBlockedUsers()],
        ['block status', (value: Service) => value.getDMBlockStatus('peer-a')],
        ['block mutation', (value: Service) => value.blockUser('peer-a')],
        ['unblock mutation', (value: Service) => value.unblockUser('peer-a')],
    ] as const)('refuses %s at admission with no Auth/SQL/queue work', async (_name, call) => {
        latch();
        await refuses(call(service));
        expect(fixture.getUser).not.toHaveBeenCalled();
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(fixture.from).not.toHaveBeenCalled();
        expect(fixture.get).not.toHaveBeenCalled();
        noPrivateDispatch();
    });

    it('preserves public send, read and realtime controls after the owner latch', async () => {
        const received = vi.fn();
        service.subscribeToChannel('public-channel', received);
        const publicChannel = fixture.channels.find((value) => value.name.startsWith('chat:'))!;
        latch();
        expect(await service.sendMessage('public-channel', 'Public allowed control')).toMatchObject({
            message: 'Public allowed control',
        });
        const row = { id: 'public-row', channel_id: 'public-channel', message: 'Public read control' };
        fixture.enqueue(PUBLIC, 'select', { data: [row], error: null });
        expect(await service.getMessages('public-channel')).toEqual([row]);
        publicChannel.handlers[0].callback({ eventType: 'INSERT', new: row });
        expect(received).toHaveBeenCalledWith(row);
        expect(fixture.removeChannel).not.toHaveBeenCalledWith(publicChannel.channel);
    });

    it('denies a known protected peer and aggregate metadata while allowing a known unprotected peer', async () => {
        identity.setAuthIdentityScope('protected-peer');
        fixture.state.userId = 'protected-peer';
        latch();
        identity.setAuthIdentityScope('account-a');
        fixture.state.userId = 'account-a';
        await refuses(service.sendDM('protected-peer', 'No private fallback'));
        await refuses(service.getDMThread('protected-peer'));
        await refuses(service.getDMConversations());
        await refuses(service.getUnreadDMCount());
        noPrivateDispatch();
        expect(await service.sendDM('unprotected-peer', 'Known peer legacy control')).toMatchObject({
            message: 'Known peer legacy control',
        });
    });

    it('refuses fresh offline admission for a known safe pair once another account latched and holds existing private data', async () => {
        identity.setAuthIdentityScope('protected-native-account');
        fixture.state.userId = 'protected-native-account';
        latch();
        identity.setAuthIdentityScope('account-a');
        fixture.state.userId = 'account-a';
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const scopedKey = key(),
            original = JSON.stringify([queuedDM()], null, 2);
        fixture.preferences.set(scopedKey, original);
        const sent = vi.fn();
        window.addEventListener('thalassa:queued-dm-sent', sent);
        try {
            await refuses(service.sendDM('unprotected-peer', 'Fresh offline text must not enter a held queue'));
            expect(fixture.preferences.get(scopedKey)).toBe(original);
            expect(sent).not.toHaveBeenCalled();
            noPrivateDispatch();
        } finally {
            window.removeEventListener('thalassa:queued-dm-sent', sent);
        }
    });

    it('revokes the admitted send while remote getUser is pending', async () => {
        const auth = deferred<ReturnType<typeof fixture.authReply>>();
        fixture.getUser.mockReturnValueOnce(auth.promise);
        const work = service.sendDM('peer-a', 'Paused Auth fixture');
        await vi.waitFor(() => expect(fixture.getUser).toHaveBeenCalledTimes(1));
        latch();
        auth.resolve(fixture.authReply());
        await refuses(work);
        expect(fixture.rpc).not.toHaveBeenCalled();
        noPrivateDispatch();
    });

    it('keeps the fixed refusal when a paused Auth adapter rejects after cutover', async () => {
        const auth = deferred<ReturnType<typeof fixture.authReply>>();
        fixture.getUser.mockReturnValueOnce(auth.promise);
        const work = service.sendDM('peer-a', 'Paused rejecting Auth fixture');
        await vi.waitFor(() => expect(fixture.getUser).toHaveBeenCalledTimes(1));
        latch();
        auth.reject(new Error('Synthetic Auth adapter rejection'));
        await refuses(work);
        expect(fixture.rpc).not.toHaveBeenCalled();
        noPrivateDispatch();
    });

    it('revokes a send after block preflight began and before SQL dispatch', async () => {
        const block = deferred<{ data: unknown; error: null }>();
        fixture.rpc.mockImplementationOnce((name, args) => fixture.rpcQuery(name, args, block.promise));
        const work = service.sendDM('peer-a', 'Paused block fixture');
        await vi.waitFor(() =>
            expect(fixture.rpc).toHaveBeenCalledWith('get_chat_dm_block_status', { p_other_user_id: 'peer-a' }),
        );
        latch();
        block.resolve({ data: { blockedByMe: false, blockedEitherDirection: false }, error: null });
        await refuses(work);
        noPrivateDispatch();
    });

    it('refuses a completed block RPC after cutover without cancelling owned queued plaintext', async () => {
        const original = JSON.stringify([queuedDM()]);
        const scopedKey = key();
        fixture.preferences.set(scopedKey, original);
        const block = deferred<{ data: unknown; error: null }>();
        fixture.rpc.mockImplementationOnce((name, args) => fixture.rpcQuery(name, args, block.promise));
        const work = service.blockUser('peer-a');
        await vi.waitFor(() =>
            expect(fixture.rpc).toHaveBeenCalledWith('set_chat_user_block', {
                p_other_user_id: 'peer-a',
                p_blocked: true,
            }),
        );
        latch();
        block.resolve({ data: { blockedByMe: true, blockedEitherDirection: true }, error: null });
        await refuses(work);
        expect(fixture.preferences.get(scopedKey)).toBe(original);
        noPrivateDispatch();
    });

    it('refuses a dispatched INSERT result without inventing unsent/blocked/queued success or scheduling push', async () => {
        const insert = deferred<{ data: unknown; error: null }>();
        fixture.enqueue(DM, 'insert', insert.promise);
        const work = service.sendDM('peer-a', 'May already have committed');
        await vi.waitFor(() => expect(operations(DM, 'insert')).toHaveLength(1));
        latch();
        insert.resolve({ data: { ...dmRow(), sender_id: 'account-a', recipient_id: 'peer-a' }, error: null });
        await refuses(work);
        expect(operations(DM, 'insert')).toHaveLength(1);
        expect(fixture.rpc.mock.calls.filter(([name]) => name === 'queue_dm_push')).toEqual([]);
        expect(fixture.set).not.toHaveBeenCalled();
    });

    it('drops a paused thread result before touching plaintext or starting mark-read', async () => {
        let reads = 0;
        const row = {
            ...dmRow(),
            get message() {
                reads += 1;
                throw new Error('Plaintext getter must not run');
            },
        };
        const select = deferred<{ data: unknown; error: null }>();
        fixture.enqueue(DM, 'select', select.promise);
        const work = service.getDMThread('peer-a');
        await vi.waitFor(() => expect(operations(DM, 'select')).toHaveLength(1));
        latch();
        select.resolve({ data: [row], error: null });
        await refuses(work);
        expect(reads).toBe(0);
        expect(operations(DM, 'update')).toEqual([]);
    });

    it('refuses thread publication when the already-dispatched mark-read completes after cutover', async () => {
        fixture.enqueue(DM, 'select', { data: [dmRow()], error: null });
        const update = deferred<{ data: null; error: null }>();
        fixture.enqueue(DM, 'update', update.promise);
        const work = service.getDMThread('peer-a');
        await vi.waitFor(() => expect(operations(DM, 'update')).toHaveLength(1));
        latch();
        update.resolve({ data: null, error: null });
        await refuses(work);
        expect(operations(DM, 'update')).toHaveLength(1);
    });

    it.each(['inbox', 'unread', 'blocked users'] as const)(
        'refuses paused %s publication after same-scope cutover',
        async (kind) => {
            const table = kind === 'blocked users' ? 'dm_blocks' : DM;
            const select = deferred<{ data: unknown; error: null; count: number }>();
            fixture.enqueue(table, 'select', select.promise);
            const work =
                kind === 'inbox'
                    ? service.getDMConversations()
                    : kind === 'unread'
                      ? service.getUnreadDMCount()
                      : service.getBlockedUsers();
            await vi.waitFor(() => expect(operations(table, 'select')).toHaveLength(1));
            latch();
            select.resolve({
                data: kind === 'blocked users' ? [{ blocked_id: 'peer-a' }] : [dmRow()],
                error: null,
                count: 7,
            });
            await refuses(work);
        },
    );

    it('cancels an existing DM subscription before reentrant unsubscribe can expose payload', () => {
        const onMessage = vi.fn();
        service.subscribeToDMs(onMessage);
        const entry = fixture.channels.find((value) => value.name === 'dm:inbox')!;
        const callback = entry.handlers[0].callback;
        let payloadReads = 0;
        const poison = {
            eventType: 'INSERT',
            get new(): Record<string, unknown> {
                payloadReads += 1;
                throw new Error('Revoked payload getter');
            },
        };
        fixture.removeChannel.mockImplementationOnce(() => {
            callback(poison);
        });
        latch();
        callback(poison);
        expect(fixture.removeChannel).toHaveBeenCalledWith(entry.channel);
        expect(payloadReads).toBe(0);
        expect(onMessage).not.toHaveBeenCalled();
        expect(() => service.subscribeToDMs(onMessage)).toThrow(Refusal);
        expect(fixture.channels.filter((value) => value.name === 'dm:inbox')).toHaveLength(1);
    });

    it('refuses offline admission after a paused local-session lookup without persisting plaintext', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const session = deferred<{ data: { session: { user: { id: string } } }; error: null }>();
        fixture.getSession.mockReturnValueOnce(session.promise);
        const work = service.sendDM('peer-a', 'Offline paused session');
        await vi.waitFor(() => expect(fixture.getSession).toHaveBeenCalledTimes(1));
        latch();
        session.resolve({ data: { session: { user: { id: 'account-a' } } }, error: null });
        await refuses(work);
        expect(fixture.get).not.toHaveBeenCalled();
        noPrivateDispatch();
    });

    it('revokes queue admission while the mutation lock is held', async () => {
        const lock = deferred<void>();
        internals().offlineQueueMutationTail = lock.promise;
        const work = internals().queueOffline(queuedDM(), scope());
        latch();
        lock.resolve();
        await refuses(work);
        expect(fixture.get).not.toHaveBeenCalled();
        noPrivateDispatch();
    });

    it('does not append/normalize/remove a queue whose scoped read crosses cutover', async () => {
        const original = JSON.stringify([queuedDM()]);
        fixture.preferences.set(key(), original);
        const read = deferred<{ value: string | null }>();
        const scopedKey = key();
        fixture.get.mockImplementation(async ({ key: request }) =>
            request === scopedKey ? read.promise : { value: fixture.preferences.get(request) ?? null },
        );
        const work = internals().queueOffline({ ...queuedDM(), queue_id: 'new-attempt' }, scope());
        await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledWith({ key: scopedKey }));
        latch();
        read.resolve({ value: original });
        await refuses(work);
        expect(fixture.preferences.get(scopedKey)).toBe(original);
        noPrivateDispatch();
    });

    it('holds a protected scoped private queue byte-for-byte without normalization or replay', async () => {
        const record = {
            type: 'dm',
            recipient_id: 'peer-a',
            message: 'Old scoped private item',
            timestamp: '2026-10-06T00:00:00Z',
        };
        const original = JSON.stringify([record], null, 2);
        const scopedKey = key();
        fixture.preferences.set(scopedKey, original);
        const sent = vi.fn();
        window.addEventListener('thalassa:queued-dm-sent', sent);
        try {
            latch();
            await internals().syncOfflineQueue(scope());
            expect(fixture.preferences.get(scopedKey)).toBe(original);
            expect(sent).not.toHaveBeenCalled();
            noPrivateDispatch();
        } finally {
            window.removeEventListener('thalassa:queued-dm-sent', sent);
        }
    });

    it('refuses acknowledgement of an already-dispatched Preferences append after cutover and holds the resulting item', async () => {
        const write = deferred<void>();
        const scopedKey = key();
        fixture.set.mockImplementationOnce(async ({ key: request, value }) => {
            // Like SQL, a dispatched storage mutation may already have won.
            fixture.preferences.set(request, value);
            await write.promise;
        });
        const work = internals().queueOffline(queuedDM(), scope());
        await vi.waitFor(() => expect(fixture.set).toHaveBeenCalledTimes(1));
        const committedBytes = fixture.preferences.get(scopedKey);
        latch();
        write.resolve();
        await refuses(work);
        expect(fixture.preferences.get(scopedKey)).toBe(committedBytes);
        await internals().syncOfflineQueue(scope());
        expect(fixture.preferences.get(scopedKey)).toBe(committedBytes);
        expect(operations(DM)).toEqual([]);
        expect(fixture.remove).not.toHaveBeenCalled();
    });

    it('holds historical global private rows without migration, quarantine or deletion', async () => {
        const original = JSON.stringify([{ ...queuedDM(), queue_id: undefined }], null, 2);
        fixture.preferences.set('chat_offline_queue', original);
        latch();
        await internals().syncOfflineQueue(scope());
        expect(fixture.preferences.get('chat_offline_queue')).toBe(original);
        expect(fixture.preferences.has(key())).toBe(false);
        expect(fixture.preferences.has('chat_offline_queue_quarantine_v2')).toBe(false);
        noPrivateDispatch();
    });

    it('replays public scoped items while preserving every held private field', async () => {
        const held = queuedDM(),
            scopedKey = key();
        fixture.preferences.set(scopedKey, JSON.stringify([held, queuedPublic()]));
        const sent = vi.fn();
        window.addEventListener('thalassa:queued-dm-sent', sent);
        try {
            latch();
            await internals().syncOfflineQueue(scope());
            expect(operations(PUBLIC, 'insert')).toHaveLength(1);
            expect(operations(DM)).toEqual([]);
            expect(JSON.parse(fixture.preferences.get(scopedKey)!)).toEqual([held]);
            expect(sent).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('thalassa:queued-dm-sent', sent);
        }
    });

    it('migrates and flushes owned global public rows while preserving raw historical private fields', async () => {
        const held = {
            type: 'dm',
            recipient_id: 'peer-a',
            message: 'Raw global private item',
            timestamp: '2026-10-06T00:00:00Z',
            owner_user_id: 'account-a',
            opaqueLegacyExtra: 'verbatim',
        };
        fixture.preferences.set(
            'chat_offline_queue',
            JSON.stringify([held, { ...queuedPublic(), queue_id: undefined }], null, 2),
        );
        latch();
        await internals().syncOfflineQueue(scope());
        expect(operations(PUBLIC, 'insert')).toHaveLength(1);
        expect(operations(DM)).toEqual([]);
        expect(JSON.parse(fixture.preferences.get('chat_offline_queue')!)).toEqual([held]);
        expect(fixture.preferences.has(key())).toBe(false);
    });

    it('normalizes only an old scoped public item and leaves an old private object intact', async () => {
        const held = {
            type: 'dm',
            recipient_id: 'peer-a',
            message: 'Raw scoped private item',
            timestamp: '2026-10-06T00:00:00Z',
            opaqueLegacyExtra: 'verbatim',
        };
        const oldPublic = {
            type: 'channel',
            channel_id: 'public-channel',
            message: 'Old public control',
            timestamp: '2026-10-06T00:01:00Z',
        };
        const scopedKey = key();
        fixture.preferences.set(scopedKey, JSON.stringify([held, oldPublic], null, 2));
        latch();
        await internals().syncOfflineQueue(scope());
        expect(operations(PUBLIC, 'insert')).toHaveLength(1);
        expect(operations(DM)).toEqual([]);
        expect(JSON.parse(fixture.preferences.get(scopedKey)!)).toEqual([held]);
    });

    it('holds an ambiguously committed queued DM and continues public replay without push or sent event', async () => {
        const held = queuedDM(),
            scopedKey = key();
        fixture.preferences.set(scopedKey, JSON.stringify([held, queuedPublic()]));
        const insert = deferred<{ data: unknown; error: null }>();
        fixture.enqueue(DM, 'insert', insert.promise);
        const sent = vi.fn();
        window.addEventListener('thalassa:queued-dm-sent', sent);
        try {
            const work = internals().syncOfflineQueue(scope());
            await vi.waitFor(() => expect(operations(DM, 'insert')).toHaveLength(1));
            latch();
            insert.resolve({ data: { ...dmRow(), sender_id: 'account-a', recipient_id: 'peer-a' }, error: null });
            await work;
            expect(operations(PUBLIC, 'insert')).toHaveLength(1);
            expect(operations(DM, 'insert')).toHaveLength(1);
            expect(JSON.parse(fixture.preferences.get(scopedKey)!)).toEqual([held]);
            expect(sent).not.toHaveBeenCalled();
            expect(fixture.rpc.mock.calls.filter(([name]) => name === 'queue_dm_push')).toEqual([]);
        } finally {
            window.removeEventListener('thalassa:queued-dm-sent', sent);
        }
    });

    it.each([
        [
            'inbox SELECT',
            `${DM}:select`,
            (value: Service): Promise<unknown> => value.getDMConversations(),
            (): void => undefined,
        ],
        [
            'thread SELECT',
            `${DM}:select`,
            (value: Service): Promise<unknown> => value.getDMThread('peer-a'),
            (): void => undefined,
        ],
        [
            'private INSERT',
            `${DM}:insert`,
            (value: Service): Promise<unknown> => value.sendDM('peer-a', 'No bytes after token denial'),
            (): void => undefined,
        ],
        [
            'mark-read UPDATE',
            `${DM}:update`,
            (value: Service): Promise<unknown> => value.getDMThread('peer-a'),
            (): void => fixture.enqueue(DM, 'select', { data: [dmRow()], error: null }),
        ],
        [
            'block-status RPC',
            'rpc:get_chat_dm_block_status',
            (value: Service): Promise<unknown> => value.getDMBlockStatus('peer-a'),
            (): void => undefined,
        ],
        [
            'block-mutation RPC',
            'rpc:set_chat_user_block',
            (value: Service): Promise<unknown> => value.blockUser('peer-a'),
            (): void => undefined,
        ],
        [
            'blocked-user SELECT',
            'dm_blocks:select',
            (value: Service): Promise<unknown> => value.getBlockedUsers(),
            (): void => undefined,
        ],
        [
            'unread HEAD',
            `${DM}:select`,
            (value: Service): Promise<unknown> => value.getUnreadDMCount(),
            (): void => undefined,
        ],
        [
            'private profile enrichment',
            'chat_profiles:select',
            (value: Service): Promise<unknown> => value.getDMConversations(),
            (): void =>
                fixture.enqueue(DM, 'select', {
                    data: [{ ...dmRow(), sender_id: 'account-a', recipient_id: 'peer-a' }],
                    error: null,
                }),
        ],
    ] as const)(
        'aborts %s after lazy SDK construction/token wait and before synthetic transport dispatch',
        async (_name, target, call, prepare) => {
            prepare();
            const token = deferred<void>();
            fixture.tokenGates.set(target, token.promise);
            const work = call(service);
            await vi.waitFor(() => expect(fixture.tokenEntered).toContain(target));
            const request = fixture.signals.filter((value) => value.key === target).at(-1);
            expect(request).toBeDefined();
            expect(request!.signal.aborted).toBe(false);
            expect(fixture.dispatches.filter((value) => value.key === target)).toEqual([]);
            latch();
            expect(request!.signal.aborted).toBe(true);
            token.resolve();
            await refuses(work);
            // Counts are AFTER the actual shared gate. Fluent construction and
            // PromiseLike assimilation are never treated as a fetch/commit.
            expect(fixture.dispatches.filter((value) => value.key === target)).toEqual([]);
            expect(fixture.nativeFetch).not.toHaveBeenCalled();
            expect(fixture.set).not.toHaveBeenCalled();
            expect(fixture.remove).not.toHaveBeenCalled();
        },
    );

    it('sends admitted private legacy queries through preserved browser fetch, with public transport unchanged', async () => {
        expect(await service.sendDM('peer-a', 'Browser-only private transport control')).toMatchObject({
            message: 'Browser-only private transport control',
        });
        expect(fixture.dispatches.filter((value) => value.key === `${DM}:insert`)).toMatchObject([
            { transport: 'browser' },
        ]);
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
        expect(await service.sendMessage('public-channel', 'Patched public transport control')).toMatchObject({
            message: 'Patched public transport control',
        });
        expect(fixture.dispatches.filter((value) => value.key === `${PUBLIC}:insert`)).toMatchObject([
            { transport: 'patched-native' },
        ]);
    });

    it('refuses a missing preserved browser source without native HTTP, proxy or offline fallback', async () => {
        const { createLegacyPrivateMessageFetchGate } =
            await import('../services/chat/e2ee/legacyPrivateMessageFetchGate');
        fixture.configureFetch(
            createLegacyPrivateMessageFetchGate({
                supabaseUrl: 'https://fixture.supabase.invalid',
                isNative: () => true,
                publicFetch: fixture.nativeFetch,
                getPrivateBrowserFetch: () => null,
            }),
        );
        await refuses(service.sendDM('peer-a', 'Missing browser source must stay refused'));
        expect(fixture.browserFetch).not.toHaveBeenCalled();
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
        expect(fixture.dispatches).toEqual([]);
        noPrivateDispatch();
    });

    it('rechecks denial raised by transport-source selection before any synthetic fetch', async () => {
        const { createLegacyPrivateMessageFetchGate } =
            await import('../services/chat/e2ee/legacyPrivateMessageFetchGate');
        fixture.configureFetch(
            createLegacyPrivateMessageFetchGate({
                supabaseUrl: 'https://fixture.supabase.invalid',
                isNative: () => true,
                publicFetch: fixture.nativeFetch,
                getPrivateBrowserFetch: () => {
                    latch();
                    return fixture.browserFetch;
                },
            }),
        );
        await refuses(service.getDMConversations());
        expect(fixture.browserFetch).not.toHaveBeenCalled();
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
        expect(fixture.dispatches).toEqual([]);
        noPrivateDispatch();
    });

    it('cancels a not-yet-dispatched push token wait while preserving the already accepted prior INSERT', async () => {
        const target = 'rpc:queue_dm_push',
            token = deferred<void>();
        fixture.tokenGates.set(target, token.promise);
        expect(await service.sendDM('peer-a', 'Prior admitted INSERT control')).toMatchObject({
            message: 'Prior admitted INSERT control',
        });
        await vi.waitFor(() => expect(fixture.tokenEntered).toContain(target));
        const request = fixture.signals.filter((value) => value.key === target).at(-1);
        expect(request).toBeDefined();
        expect(fixture.dispatches.filter((value) => value.key === target)).toEqual([]);
        latch();
        token.resolve();
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        expect(request!.signal.aborted).toBe(true);
        expect(fixture.dispatches.filter((value) => value.key === target)).toEqual([]);
        expect(operations(DM, 'insert')).toHaveLength(1);
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
    });
});
