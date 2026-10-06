/** Real Guardian hail caller with synthetic Auth/SQL/push replies. No device,
 * network, encryption, server cutover or rollback of dispatched work is proven. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
    type Result = { data: unknown; error: unknown };
    const getUser = vi.fn(),
        insert = vi.fn(),
        single = vi.fn(),
        rpc = vi.fn(),
        logError = vi.fn();
    const tokenGates = new Map<string, Promise<void>>();
    const tokenEntered: string[] = [];
    const constructed: string[] = [];
    const signals: Array<{ key: string; signal: AbortSignal }> = [];
    const dispatches: Array<{
        key: string;
        body: BodyInit | null | undefined;
        transport: 'browser' | 'patched-native';
    }> = [];
    const requests = new Map<string, { key: string; run: () => Promise<Result> }>();
    let requestNumber = 0,
        guardedFetch: typeof fetch | undefined;
    const transport = async (
        input: RequestInfo | URL,
        init: RequestInit | undefined,
        kind: 'browser' | 'patched-native',
    ): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const request = requests.get(url);
        if (!request) throw new Error('Unknown synthetic Guardian request');
        dispatches.push({ key: request.key, body: init?.body, transport: kind });
        const result = await request.run();
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    // Patched native HTTP deliberately ignores cancellation. The actual shared
    // gate must select the preserved browser source for every private request.
    const nativeFetch = vi.fn<typeof fetch>((input, init) => transport(input, init, 'patched-native'));
    const browserFetch = vi.fn<typeof fetch>((input, init) => transport(input, init, 'browser'));
    const lazy = (key: string, route: string, method: string, payload: unknown, run: () => Promise<Result>) => {
        constructed.push(key);
        const query: Record<string, unknown> = {};
        let signal: AbortSignal | undefined, pending: Promise<Result> | undefined;
        for (const name of ['select', 'eq', 'order', 'limit']) query[name] = vi.fn(() => query);
        query.abortSignal = vi.fn((value: AbortSignal) => {
            signal = value;
            signals.push({ key, signal: value });
            return query;
        });
        query.then = (done: (value: Result) => unknown, failed: (error: unknown) => unknown) => {
            if (!pending)
                pending = (async () => {
                    tokenEntered.push(key);
                    const token = tokenGates.get(key);
                    if (token) await token;
                    if (!guardedFetch) throw new Error('Real Guardian fetch gate was not configured');
                    const url = `https://fixture.supabase.invalid/rest/v1/${route}?fixture_request=${++requestNumber}`;
                    requests.set(url, { key, run });
                    const response = await guardedFetch(url, {
                        method,
                        signal,
                        body: method === 'GET' ? undefined : JSON.stringify(payload),
                    });
                    return (await response.json()) as Result;
                })();
            return pending.then(done, failed);
        };
        // Match the SDK's narrowed terminal builder: the owned signal is
        // attached on select.abortSignal(signal), before single/maybeSingle.
        const terminal = { then: query.then };
        query.single = vi.fn(() => terminal);
        query.maybeSingle = vi.fn(() => terminal);
        return query;
    };
    const from = (table: string) => ({
        insert: (payload: unknown) =>
            lazy(`${table}:insert`, table, 'POST', payload, async () => {
                // INSERT is counted only when browser transport actually starts.
                insert(table, payload);
                return (await single()) as Result;
            }),
        select: () => lazy(`${table}:select`, table, 'GET', undefined, async () => ({ data: null, error: null })),
    });
    const sdkRpc = (...args: unknown[]) =>
        lazy(
            `rpc:${String(args[0])}`,
            `rpc/${String(args[0])}`,
            'POST',
            args[1],
            async () => (await rpc(...args)) as Result,
        );
    const reset = () => {
        for (const mock of [getUser, insert, single, rpc, logError]) mock.mockReset();
        tokenGates.clear();
        tokenEntered.length = 0;
        constructed.length = 0;
        signals.length = 0;
        dispatches.length = 0;
        requests.clear();
        requestNumber = 0;
        guardedFetch = undefined;
        nativeFetch.mockClear();
        browserFetch.mockClear();
    };
    return {
        getUser,
        insert,
        single,
        rpc,
        logError,
        tokenGates,
        tokenEntered,
        constructed,
        signals,
        dispatches,
        nativeFetch,
        browserFetch,
        reset,
        configureFetch: (value: typeof fetch) => {
            guardedFetch = value;
        },
        supabase: { auth: { getUser }, from, rpc: sdkRpc },
    };
});
vi.mock('../services/supabase', () => ({ supabase: fixture.supabase }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        error: fixture.logError,
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    }),
}));
vi.mock('../services/ownshipPosition', () => ({ acquireFreshOwnshipPosition: vi.fn() }));

let service: typeof import('../services/GuardianService').GuardianService;
let identity: typeof import('../services/authIdentityScope');
let policy: typeof import('../services/chat/e2ee/privateMessageCutover');
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
const latch = () => expect(policy.requireNativePrivateMessagesForScope(identity.getAuthIdentityScope())).toBe(true);
beforeEach(async () => {
    vi.resetModules();
    fixture.reset();
    identity = await import('../services/authIdentityScope');
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
    ({ GuardianService: service } = await import('../services/GuardianService'));
    fixture.getUser.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
    fixture.single.mockResolvedValue({ data: { id: 'synthetic-hail' }, error: null });
    fixture.rpc.mockResolvedValue({ data: null, error: null });
});
afterEach(() => {
    service.stop();
    vi.restoreAllMocks();
});

describe('Guardian private hail cutover fixtures', () => {
    it('preserves a default legacy hail and explicit push positive control', async () => {
        await expect(service.sendHail('account-b', 'Ahoy fixture')).resolves.toBe(true);
        expect(fixture.insert).toHaveBeenCalledWith(
            'chat_direct_messages',
            expect.objectContaining({
                sender_id: 'account-a',
                recipient_id: 'account-b',
                message: expect.stringContaining('Ahoy fixture'),
            }),
        );
        expect(fixture.rpc).toHaveBeenCalledWith('queue_dm_push', { p_message_id: 'synthetic-hail' });
        expect(fixture.dispatches).toMatchObject([
            { key: 'chat_direct_messages:insert', transport: 'browser' },
            { key: 'rpc:queue_dm_push', transport: 'browser' },
        ]);
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
    });
    it('refuses protected admission before Auth, SQL or client push work', async () => {
        latch();
        await expect(service.sendHail('account-b', 'Refused fixture')).rejects.toBeInstanceOf(
            policy.PrivateMessageLegacyUnavailableError,
        );
        expect(fixture.getUser).not.toHaveBeenCalled();
        expect(fixture.insert).not.toHaveBeenCalled();
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(fixture.logError).not.toHaveBeenCalled();
    });
    it('refuses a protected recipient even under an unlatched sender scope', async () => {
        identity.setAuthIdentityScope('account-b');
        latch();
        identity.setAuthIdentityScope('account-a');
        await expect(service.sendHail('account-b', 'Refused peer fixture')).rejects.toBeInstanceOf(
            policy.PrivateMessageLegacyUnavailableError,
        );
        expect(fixture.getUser).not.toHaveBeenCalled();
        expect(fixture.insert).not.toHaveBeenCalled();
    });
    it('does not recapture permission after held remote Auth returns', async () => {
        const auth = deferred<{ data: { user: { id: string } }; error: null }>();
        fixture.getUser.mockReturnValueOnce(auth.promise);
        const work = service.sendHail('account-b', 'Held Auth fixture');
        await vi.waitFor(() => expect(fixture.getUser).toHaveBeenCalledOnce());
        latch();
        auth.resolve({ data: { user: { id: 'account-a' } }, error: null });
        await expect(work).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
        expect(fixture.insert).not.toHaveBeenCalled();
        expect(fixture.rpc).not.toHaveBeenCalled();
    });
    it('aborts a constructed hail INSERT during the SDK token wait before browser transport or commit', async () => {
        const target = 'chat_direct_messages:insert',
            token = deferred<void>();
        fixture.tokenGates.set(target, token.promise);
        const work = service.sendHail('account-b', 'No transport after token denial');
        await vi.waitFor(() => expect(fixture.tokenEntered).toContain(target));
        expect(fixture.constructed).toContain(target);
        expect(fixture.insert).not.toHaveBeenCalled();
        const request = fixture.signals.filter((value) => value.key === target).at(-1);
        expect(request).toBeDefined();
        expect(request!.signal.aborted).toBe(false);
        latch();
        expect(request!.signal.aborted).toBe(true);
        token.resolve();
        await expect(work).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
        expect(fixture.dispatches).toEqual([]);
        expect(fixture.insert).not.toHaveBeenCalled();
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(fixture.browserFetch).not.toHaveBeenCalled();
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
        expect(fixture.logError).not.toHaveBeenCalled();
    });
    it('blocks queued push token admission while leaving the prior confirmed hail row intact', async () => {
        const target = 'rpc:queue_dm_push',
            token = deferred<void>();
        fixture.tokenGates.set(target, token.promise);
        const work = service.sendHail('account-b', 'Prior inserted row is not rolled back');
        await vi.waitFor(() => expect(fixture.tokenEntered).toContain(target));
        expect(fixture.insert).toHaveBeenCalledOnce();
        expect(fixture.single).toHaveBeenCalledOnce();
        expect(fixture.constructed).toContain(target);
        expect(fixture.rpc).not.toHaveBeenCalled();
        const request = fixture.signals.filter((value) => value.key === target).at(-1);
        expect(request).toBeDefined();
        latch();
        token.resolve();
        await expect(work).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
        expect(request!.signal.aborted).toBe(true);
        expect(fixture.dispatches).toMatchObject([{ key: 'chat_direct_messages:insert', transport: 'browser' }]);
        expect(fixture.insert).toHaveBeenCalledOnce();
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(fixture.nativeFetch).not.toHaveBeenCalled();
        expect(fixture.logError).not.toHaveBeenCalled();
    });
    it.each(['resolved', 'rejected'] as const)(
        'suppresses client push/success after already dispatched INSERT becomes %s',
        async (outcome) => {
            const write = deferred<{ data: { id: string }; error: null }>();
            fixture.single.mockReturnValueOnce(write.promise);
            const work = service.sendHail('account-b', 'Already dispatched fixture');
            await vi.waitFor(() => expect(fixture.insert).toHaveBeenCalledOnce());
            latch();
            if (outcome === 'resolved') write.resolve({ data: { id: 'may-already-be-committed' }, error: null });
            else write.reject(new Error('Synthetic diagnostics must not be logged after cutover'));
            await expect(work).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
            // This cannot retract the prior SQL dispatch or any server-triggered push.
            expect(fixture.insert).toHaveBeenCalledOnce();
            expect(fixture.rpc).not.toHaveBeenCalled();
            expect(fixture.logError).not.toHaveBeenCalled();
        },
    );
    it('does not publish success after a client push request already dispatched', async () => {
        const push = deferred<{ data: null; error: null }>();
        fixture.rpc.mockReturnValueOnce(push.promise);
        const work = service.sendHail('account-b', 'Dispatched push fixture');
        await vi.waitFor(() => expect(fixture.rpc).toHaveBeenCalledOnce());
        latch();
        push.resolve({ data: null, error: null });
        await expect(work).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
        expect(fixture.rpc).toHaveBeenCalledOnce();
        expect(fixture.logError).not.toHaveBeenCalled();
    });
    it('keeps a confirmed hail successful when best-effort push rejects, without authorizing a duplicate retry', async () => {
        fixture.rpc.mockRejectedValueOnce(new Error('Synthetic push failure after confirmed INSERT'));
        await expect(service.sendHail('account-b', 'Confirmed row fixture')).resolves.toBe(true);
        expect(fixture.insert).toHaveBeenCalledOnce();
        expect(fixture.rpc).toHaveBeenCalledOnce();
        expect(fixture.logError).not.toHaveBeenCalled();
    });
    it('keeps unrelated safety disarm operations outside the private latch', async () => {
        latch();
        await expect(service.disarm()).resolves.toBe(true);
        expect(fixture.rpc).toHaveBeenCalledWith('guardian_disarm');
        expect(fixture.insert).not.toHaveBeenCalled();
        expect(fixture.dispatches.filter((value) => value.key === 'rpc:guardian_disarm')).toMatchObject([
            { transport: 'patched-native' },
        ]);
    });
});
