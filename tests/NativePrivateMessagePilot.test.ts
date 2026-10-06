/**
 * Deterministic SDK/native-port fixtures only. No Supabase login, native plugin,
 * provider cryptography, secure storage, network or encrypted delivery is tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    createNativePrivateMessagePilotSession,
    type NativePrivateMessagePilotSession,
    type PrivateMessageNativePlugin,
    type PrivateMessageSupabaseAuth,
} from '../services/chat/e2ee/nativePrivateMessagePilot';
import type {
    NativePrivateMessageAuthority,
    NativePrivateMessageBlockStatus,
    NativePrivateMessageEvent,
    NativePrivateMessageReadiness,
    NativePrivateMessageResult,
    NativePrivateTextMessage,
} from '../services/chat/e2ee/privateMessagePilot';

const legacy = vi.hoisted(() => ({
    inbox: vi.fn(),
    thread: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn(),
    block: vi.fn(),
}));
vi.mock('../services/ChatService', () => ({
    ChatService: {
        getDMConversations: legacy.inbox,
        getDMThread: legacy.thread,
        sendDM: legacy.send,
        subscribeToDMs: legacy.subscribe,
        blockUser: legacy.block,
    },
}));

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const LOCAL_CREATED_AT_MILLIS = Date.parse('2026-10-02T00:00:00.000Z');
// Deliberately nonsecret, non-JWT fixture strings.
const BEARER_A = 'fixture-bearer-A';
const BEARER_B = 'fixture-bearer-B';
const RENEWED_BEARER_A = 'fixture-bearer-A-renewed';
const sessions: NativePrivateMessagePilotSession[] = [];
const AUTHORITY_A: NativePrivateMessageAuthority = {
    accountId: ACCOUNT_A,
    deviceId: DEVICE,
    lifecycleVersion: 'fixture:epoch1:peer0',
    serverVerified: true,
};
const closed = () => ({ status: 'unavailable' as const, reason: 'unavailable' as const });
const ready = (authority: NativePrivateMessageAuthority): NativePrivateMessageReadiness => ({
    status: 'ready',
    authority,
    supportedContent: ['text'],
});
const peerFor = (account: string) => (account === ACCOUNT_A ? ACCOUNT_B : ACCOUNT_A);
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
/** Drain bounded promise chains without wall-clock waits or polling timers. */
async function settle() {
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
}
function same(a: NativePrivateMessageAuthority, b: NativePrivateMessageAuthority) {
    return (
        a.accountId === b.accountId &&
        a.deviceId === b.deviceId &&
        a.lifecycleVersion === b.lifecycleVersion &&
        b.serverVerified === true
    );
}
function outgoingText(
    authority: NativePrivateMessageAuthority,
    peerAccountId: string,
    clientMessageId: string,
    text: string,
): NativePrivateTextMessage {
    return {
        id: `outgoing:${clientMessageId}`,
        clientMessageId,
        direction: 'outgoing',
        senderAccountId: authority.accountId,
        recipientAccountId: peerAccountId,
        senderName: 'You',
        text,
        localCreatedAtMillis: LOCAL_CREATED_AT_MILLIS,
        read: false,
        delivery: 'server_accepted',
        reason: null,
    };
}

function fixture() {
    let sdkSession: { access_token: string } | null = { access_token: BEARER_A };
    let authListener: Parameters<PrivateMessageSupabaseAuth['onAuthStateChange']>[0] | undefined;
    let nativeAuthority: NativePrivateMessageAuthority | null = null;
    let nativeFence = '';
    let epoch = 0;
    let peerGeneration = 0;
    let blocked = false;
    const authUnsubscribe = vi.fn();
    const auth = {
        getSession: vi.fn(async () => ({ data: { session: sdkSession }, error: null as unknown })),
        onAuthStateChange: vi.fn((listener: Parameters<PrivateMessageSupabaseAuth['onAuthStateChange']>[0]) => {
            authListener = listener;
            return { data: { subscription: { unsubscribe: authUnsubscribe } } };
        }),
    } satisfies PrivateMessageSupabaseAuth;
    const subscriptions: Array<{
        authority: NativePrivateMessageAuthority;
        receive: (event: NativePrivateMessageEvent) => void;
        close: ReturnType<typeof vi.fn>;
    }> = [];
    const result = <T>(value: T, expected: NativePrivateMessageAuthority): NativePrivateMessageResult<T> =>
        nativeAuthority && same(nativeAuthority, expected)
            ? { status: 'ok', authority: { ...nativeAuthority }, value }
            : closed();
    const permissions = (): NativePrivateMessageBlockStatus => ({
        peerAccountId: peerFor(nativeAuthority!.accountId),
        blockedByMe: blocked,
        blockedEitherDirection: blocked,
        canSend: !blocked,
        reason: blocked ? 'unavailable' : null,
    });
    const native = {
        fenceSession: vi.fn(
            async (_options: {
                mode: 'verify' | 'sign_out';
            }): ReturnType<PrivateMessageNativePlugin['fenceSession']> => {
                nativeAuthority = null;
                nativeFence = `fixture-fence-${++epoch}`;
                return { status: 'fenced' as const, authFence: nativeFence };
            },
        ),
        authenticate: vi.fn(
            async ({
                accessToken,
                authFence,
            }: {
                accessToken: string;
                authFence: string;
            }): Promise<NativePrivateMessageReadiness> => {
                if (authFence !== nativeFence || ![BEARER_A, BEARER_B, RENEWED_BEARER_A].includes(accessToken))
                    return closed();
                nativeAuthority = {
                    accountId: accessToken === BEARER_B ? ACCOUNT_B : ACCOUNT_A,
                    deviceId: DEVICE,
                    lifecycleVersion: `fixture:epoch${epoch}:peer${peerGeneration}`,
                    serverVerified: true,
                };
                return ready({ ...nativeAuthority });
            },
        ),
        readiness: vi.fn(
            async (): Promise<NativePrivateMessageReadiness> =>
                nativeAuthority ? ready({ ...nativeAuthority }) : closed(),
        ),
        getInbox: vi.fn(
            async ({
                authority,
            }: {
                authority: NativePrivateMessageAuthority;
            }): ReturnType<PrivateMessageNativePlugin['getInbox']> =>
                result(
                    [
                        {
                            peerAccountId: peerFor(authority.accountId),
                            displayName: 'Paired sailor',
                            lastText: null,
                            lastLocalCreatedAtMillis: null,
                            unreadCount: 0,
                            historyAvailable: true,
                        },
                    ],
                    authority,
                ),
        ),
        getThread: vi.fn(
            async ({ authority, peerAccountId }: { authority: NativePrivateMessageAuthority; peerAccountId: string }) =>
                result(
                    {
                        peerAccountId,
                        messages: [] as NativePrivateTextMessage[],
                        permissions: { ...permissions(), peerAccountId },
                        unresolvedCount: 0,
                        pendingAttemptId: null,
                    },
                    authority,
                ),
        ),
        sendText: vi.fn(
            async ({
                authority,
                peerAccountId,
                clientMessageId,
                text,
            }: {
                authority: NativePrivateMessageAuthority;
                peerAccountId: string;
                clientMessageId: string;
                text: string;
            }) => result(outgoingText(authority, peerAccountId, clientMessageId, text), authority),
        ),
        retryPending: vi.fn(
            async ({
                authority,
                peerAccountId,
                clientMessageId,
            }: {
                authority: NativePrivateMessageAuthority;
                peerAccountId: string;
                clientMessageId: string;
            }) => result(outgoingText(authority, peerAccountId, clientMessageId, 'Fixture retry text'), authority),
        ),
        getBlockStatus: vi.fn(async ({ authority }: { authority: NativePrivateMessageAuthority }) =>
            result(permissions(), authority),
        ),
        setBlocked: vi.fn(
            async ({
                authority,
                blocked: next,
            }: {
                authority: NativePrivateMessageAuthority;
                blocked: boolean;
            }): ReturnType<PrivateMessageNativePlugin['setBlocked']> => {
                if (!nativeAuthority || !same(authority, nativeAuthority)) return closed();
                blocked = next;
                peerGeneration += 1;
                nativeAuthority = {
                    ...nativeAuthority,
                    lifecycleVersion: `fixture:epoch${epoch}:peer${peerGeneration}`,
                };
                return { status: 'ok' as const, authority: { ...nativeAuthority }, value: permissions() };
            },
        ),
        subscribe: vi.fn(
            async (
                { authority }: { authority: NativePrivateMessageAuthority },
                receive: (event: NativePrivateMessageEvent) => void,
            ): ReturnType<PrivateMessageNativePlugin['subscribe']> => {
                const close = vi.fn();
                subscriptions.push({ authority, receive, close });
                return close;
            },
        ),
    } satisfies PrivateMessageNativePlugin;
    const session = createNativePrivateMessagePilotSession({ auth, native, reverifyMilliseconds: 1000 });
    sessions.push(session);
    return {
        auth,
        native,
        session,
        subscriptions,
        authUnsubscribe,
        setSdk(token: string | null) {
            sdkSession = token === null ? null : { access_token: token };
        },
        emitAuth(event: string, token: string | null) {
            sdkSession = token === null ? null : { access_token: token };
            authListener?.(event, sdkSession);
        },
        authority: () => nativeAuthority,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope(ACCOUNT_A);
});
afterEach(async () => {
    try {
        for (const session of sessions.splice(0)) await session.dispose();
        for (const callback of Object.values(legacy)) expect(callback).not.toHaveBeenCalled();
    } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
    }
});

describe('SDK-to-native pilot session — fake Auth/native authority, not live E2EE', () => {
    it('does not activate on construction, refresh, or an attempted DM before explicit start', async () => {
        const timersBeforeConstruction = vi.getTimerCount();
        const { session, auth, native } = fixture();
        expect(session.state()).toBe('stopped');
        await session.refresh();
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(auth.getSession).not.toHaveBeenCalled();
        expect(auth.onAuthStateChange).not.toHaveBeenCalled();
        expect(native.authenticate).not.toHaveBeenCalled();
        expect(native.fenceSession).not.toHaveBeenCalled();
        expect(native.getInbox).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(timersBeforeConstruction);
    });
    it('passes only the current SDK fixture bearer and native fence into native attestation', async () => {
        const { session, native } = fixture();
        session.start();
        await settle();
        expect(session.state()).toBe('ready');
        expect(native.authenticate).toHaveBeenCalledWith({ accessToken: BEARER_A, authFence: 'fixture-fence-1' });
        expect(Object.keys(native.authenticate.mock.calls[0][0]).sort()).toEqual(['accessToken', 'authFence']);
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
        expect(native.getInbox.mock.calls[0][0].authority.accountId).toBe(ACCOUNT_A);
    });
    it('does not supersede a synchronous SDK INITIAL_SESSION callback with a boot read', async () => {
        const { session, auth, native, authUnsubscribe } = fixture();
        auth.onAuthStateChange.mockImplementationOnce((listener) => {
            listener('INITIAL_SESSION', { access_token: RENEWED_BEARER_A });
            return { data: { subscription: { unsubscribe: authUnsubscribe } } };
        });
        session.start();
        await settle();
        expect(session.state()).toBe('ready');
        expect(auth.getSession).not.toHaveBeenCalled();
        expect(native.authenticate).toHaveBeenCalledTimes(1);
        expect(native.authenticate.mock.calls[0][0].accessToken).toBe(RENEWED_BEARER_A);
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
    });
    it('deactivates native authority on a confirmed absent SDK session while the local identity still names A', async () => {
        const { session, native, setSdk, authority } = fixture();
        setSdk(null);
        session.start();
        await settle();
        expect(getAuthIdentityScope().userId).toBe(ACCOUNT_A);
        expect(session.state()).toBe('signed_out');
        expect(native.fenceSession.mock.calls.map(([options]) => options.mode)).toEqual(['verify', 'sign_out']);
        expect(native.authenticate).not.toHaveBeenCalled();
        expect(authority()).toBeNull();
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(native.getInbox).not.toHaveBeenCalled();
    });
    it('never invokes native authenticate when native fencing rejects', async () => {
        const { session, native, auth } = fixture();
        native.fenceSession.mockRejectedValueOnce(new Error('fixture fence failure'));
        session.start();
        await settle();
        expect(session.state()).toBe('unavailable');
        expect(auth.getSession).not.toHaveBeenCalled();
        expect(native.authenticate).not.toHaveBeenCalled();
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(native.getInbox).not.toHaveBeenCalled();
    });
    it('waits for durable native fencing before reading the SDK session', async () => {
        const { session, native, auth } = fixture();
        const gate = deferred<void>();
        const commitFence = native.fenceSession.getMockImplementation()!;
        native.fenceSession.mockImplementationOnce(async (options) => {
            await gate.promise;
            return commitFence(options);
        });
        session.start();
        await settle();
        expect(native.fenceSession).toHaveBeenCalledTimes(1);
        expect(session.state()).toBe('checking');
        expect(auth.getSession).not.toHaveBeenCalled();
        expect(native.authenticate).not.toHaveBeenCalled();
        gate.resolve();
        await settle();
        expect(auth.getSession).toHaveBeenCalledTimes(1);
        expect(native.authenticate).toHaveBeenCalledWith({ accessToken: BEARER_A, authFence: 'fixture-fence-1' });
        expect(session.state()).toBe('ready');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
    });
    it('never reads the SDK session when the durable fence becomes obsolete during logout', async () => {
        const { session, native, auth, emitAuth } = fixture();
        const fence = deferred<Awaited<ReturnType<PrivateMessageNativePlugin['fenceSession']>>>();
        native.fenceSession.mockReturnValueOnce(fence.promise);
        session.start();
        await settle();
        emitAuth('SIGNED_OUT', null);
        await settle();
        fence.resolve({ status: 'fenced', authFence: 'fixture-obsolete-fence' });
        await settle();
        expect(session.state()).toBe('signed_out');
        expect(auth.getSession).not.toHaveBeenCalled();
        expect(native.authenticate).not.toHaveBeenCalled();
    });
    it.each([closed(), { status: 'fenced' as const, authFence: 'invalid-fence\n' }])(
        'never reads the SDK session after an unsuccessful or malformed native fence',
        async (fence) => {
            const { session, native, auth } = fixture();
            native.fenceSession.mockResolvedValueOnce(fence);
            session.start();
            await settle();
            expect(session.state()).toBe('unavailable');
            expect(auth.getSession).not.toHaveBeenCalled();
            expect(native.authenticate).not.toHaveBeenCalled();
        },
    );
    it.each([
        ['unverified', { ...AUTHORITY_A, serverVerified: false }],
        ['wrong owner', { ...AUTHORITY_A, accountId: ACCOUNT_B }],
        ['noncanonical device', { ...AUTHORITY_A, deviceId: `${DEVICE}\n` }],
        ['invalid lifecycle', { ...AUTHORITY_A, lifecycleVersion: 'fixture:epoch1\n' }],
    ])('refuses %s native attestation without reading messages', async (_label, authority) => {
        const { session, native } = fixture();
        native.authenticate.mockResolvedValueOnce(ready(authority as NativePrivateMessageAuthority));
        session.start();
        await settle();
        expect(session.state()).toBe('unavailable');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(native.getInbox).not.toHaveBeenCalled();
    });
    it('rejects a malformed SDK fixture bearer before invoking native authenticate', async () => {
        const { session, native, setSdk } = fixture();
        setSdk(`${BEARER_A}\n`);
        session.start();
        await settle();
        expect(session.state()).toBe('unavailable');
        expect(native.authenticate).not.toHaveBeenCalled();
    });
    it('ignores a delayed SDK bootstrap after confirmed logout', async () => {
        const { session, native, auth, emitAuth } = fixture();
        const bootstrap = deferred<Awaited<ReturnType<PrivateMessageSupabaseAuth['getSession']>>>();
        auth.getSession.mockReturnValueOnce(bootstrap.promise);
        session.start();
        await settle();
        emitAuth('SIGNED_OUT', null);
        setAuthIdentityScope(null);
        await settle();
        bootstrap.resolve({ data: { session: { access_token: BEARER_A } }, error: null });
        await settle();
        expect(session.state()).toBe('signed_out');
        expect(native.authenticate).not.toHaveBeenCalled();
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
    });
    it('ignores a delayed SDK bootstrap after an account switch and keeps the newer account ready', async () => {
        const { session, native, auth, setSdk } = fixture();
        const bootstrap = deferred<Awaited<ReturnType<PrivateMessageSupabaseAuth['getSession']>>>();
        auth.getSession.mockReturnValueOnce(bootstrap.promise);
        session.start();
        await settle();
        setSdk(BEARER_B);
        setAuthIdentityScope(ACCOUNT_B);
        await settle();
        expect(session.state()).toBe('ready');
        bootstrap.resolve({ data: { session: { access_token: BEARER_A } }, error: null });
        await settle();
        expect(native.authenticate).toHaveBeenCalledTimes(1);
        expect(native.authenticate.mock.calls[0][0].accessToken).toBe(BEARER_B);
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
        expect(native.getInbox.mock.calls[0][0].authority.accountId).toBe(ACCOUNT_B);
    });
    it.each(['logout', 'account switch'] as const)(
        'ignores delayed native Auth completion after %s',
        async (change) => {
            const { session, native, emitAuth, setSdk } = fixture();
            const authentication = deferred<NativePrivateMessageReadiness>();
            native.authenticate.mockReturnValueOnce(authentication.promise);
            session.start();
            await settle();
            expect(native.authenticate).toHaveBeenCalledTimes(1);
            if (change === 'logout') {
                emitAuth('SIGNED_OUT', null);
                setAuthIdentityScope(null);
            } else {
                setSdk(BEARER_B);
                setAuthIdentityScope(ACCOUNT_B);
            }
            await settle();
            const fenceCount = native.fenceSession.mock.calls.length;
            authentication.resolve(ready(AUTHORITY_A));
            await settle();
            expect(native.fenceSession).toHaveBeenCalledTimes(fenceCount);
            if (change === 'logout') {
                expect(session.state()).toBe('signed_out');
                expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
            } else {
                expect(session.state()).toBe('ready');
                expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
                expect(native.getInbox.mock.calls[0][0].authority.accountId).toBe(ACCOUNT_B);
            }
        },
    );
    it('fences on SDK SIGNED_OUT before the local identity mirror changes and rejects delayed native Auth', async () => {
        const { session, native, emitAuth, authority } = fixture();
        const pending = deferred<NativePrivateMessageReadiness>();
        native.authenticate.mockReturnValueOnce(pending.promise);
        session.start();
        await settle();
        expect(native.authenticate).toHaveBeenCalledTimes(1);
        emitAuth('SIGNED_OUT', null);
        await settle();
        expect(getAuthIdentityScope().userId).toBe(ACCOUNT_A);
        expect(session.state()).toBe('signed_out');
        expect(authority()).toBeNull();
        expect(native.fenceSession.mock.calls.at(-1)?.[0].mode).toBe('sign_out');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(native.getInbox).not.toHaveBeenCalled();
        pending.resolve(ready(AUTHORITY_A));
        await settle();
        expect(session.state()).toBe('signed_out');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(native.getInbox).not.toHaveBeenCalled();
    });
    it('rebinds logical subscriptions after same-account verification and drops old-lease callbacks', async () => {
        const { session, native, auth, subscriptions, emitAuth } = fixture();
        session.start();
        await settle();
        const receive = vi.fn();
        const stop = session.runtime.subscribe(getAuthIdentityScope(), receive);
        await settle();
        expect(native.subscribe).toHaveBeenCalledTimes(1);
        receive.mockClear();
        emitAuth('TOKEN_REFRESHED', RENEWED_BEARER_A);
        await settle();
        expect(session.state()).toBe('ready');
        expect(native.subscribe).toHaveBeenCalledTimes(2);
        expect(native.authenticate.mock.calls[1][0].accessToken).toBe(RENEWED_BEARER_A);
        expect(auth.getSession).toHaveBeenCalledTimes(1);
        expect(subscriptions[0].close).toHaveBeenCalledTimes(1);
        expect(subscriptions[1].authority.lifecycleVersion).not.toBe(subscriptions[0].authority.lifecycleVersion);
        const text: NativePrivateTextMessage = {
            id: `incoming:${MESSAGE}`,
            clientMessageId: MESSAGE,
            direction: 'incoming',
            senderAccountId: ACCOUNT_B,
            recipientAccountId: ACCOUNT_A,
            senderName: 'Paired sailor',
            text: 'Fixture after renewal',
            localCreatedAtMillis: null,
            read: false,
            delivery: 'received',
            reason: null,
        };
        receive.mockClear();
        subscriptions[0].receive({ status: 'ok', authority: subscriptions[0].authority, value: text });
        await settle();
        expect(receive).not.toHaveBeenCalled();
        subscriptions[1].receive({ status: 'ok', authority: subscriptions[1].authority, value: text });
        await settle();
        expect(receive).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'ok',
                value: expect.objectContaining({ id: `incoming:${MESSAGE}`, message: text.text }),
            }),
        );
        stop();
    });
    it('updates cached native authority after a peer-control epoch transition and rebinds subscriptions', async () => {
        const { session, native, subscriptions } = fixture();
        session.start();
        await settle();
        const stop = session.runtime.subscribe(getAuthIdentityScope(), vi.fn());
        await settle();
        const before = subscriptions[0].authority.lifecycleVersion;
        const blocked = await session.runtime.setBlocked(getAuthIdentityScope(), ACCOUNT_B, true);
        await settle();
        expect(blocked.status).toBe('ok');
        if (blocked.status === 'ok') expect(blocked.value.blockedByMe).toBe(true);
        expect(session.state()).toBe('ready');
        expect(native.subscribe).toHaveBeenCalledTimes(2);
        expect(subscriptions[1].authority.lifecycleVersion).not.toBe(before);
        const status = await session.runtime.getBlockStatus(getAuthIdentityScope(), ACCOUNT_B);
        expect(status.status).toBe('ok');
        if (status.status === 'ok') expect(status.value.canSend).toBe(false);
        expect(native.getBlockStatus.mock.calls[0][0].authority.lifecycleVersion).toBe(
            subscriptions[1].authority.lifecycleVersion,
        );
        stop();
    });
    it('rejects an in-flight data response crossing a same-account SDK refresh', async () => {
        const { session, native, emitAuth, authority } = fixture();
        session.start();
        await settle();
        const before = { ...authority()! };
        const pending = deferred<Awaited<ReturnType<PrivateMessageNativePlugin['getInbox']>>>();
        native.getInbox.mockReturnValueOnce(pending.promise);
        const loading = session.runtime.getInbox(getAuthIdentityScope());
        await settle();
        expect(native.getInbox).toHaveBeenCalledTimes(1);
        emitAuth('TOKEN_REFRESHED', RENEWED_BEARER_A);
        await settle();
        expect(session.state()).toBe('ready');
        expect(authority()!.lifecycleVersion).not.toBe(before.lifecycleVersion);
        pending.resolve({
            status: 'ok',
            authority: before,
            value: [
                {
                    peerAccountId: ACCOUNT_B,
                    displayName: 'Paired sailor',
                    lastText: 'Old lease fixture plaintext',
                    lastLocalCreatedAtMillis: LOCAL_CREATED_AT_MILLIS,
                    unreadCount: 0,
                    historyAvailable: true,
                },
            ],
        });
        expect((await loading).status).toBe('unavailable');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
        expect(native.getInbox.mock.calls[1][0].authority.lifecycleVersion).toBe(authority()!.lifecycleVersion);
    });
    it('retries the exact native attempt without passing plaintext or fabricating a read receipt', async () => {
        const { session, native, authority } = fixture();
        session.start();
        await settle();
        const retried = await session.runtime.retryPending(getAuthIdentityScope(), ACCOUNT_B, MESSAGE);
        expect(native.retryPending).toHaveBeenCalledTimes(1);
        expect(native.retryPending).toHaveBeenCalledWith({
            authority: authority()!,
            peerAccountId: ACCOUNT_B,
            clientMessageId: MESSAGE,
        });
        expect(Object.keys(native.retryPending.mock.calls[0][0]).sort()).toEqual([
            'authority',
            'clientMessageId',
            'peerAccountId',
        ]);
        expect(retried).toEqual({
            status: 'ok',
            value: {
                kind: 'native-pilot',
                id: `outgoing:${MESSAGE}`,
                clientMessageId: MESSAGE,
                direction: 'outgoing',
                sender_id: ACCOUNT_A,
                recipient_id: ACCOUNT_B,
                sender_name: 'You',
                message: 'Fixture retry text',
                created_at: '2026-10-02T00:00:00.000Z',
                localCreatedAtMillis: LOCAL_CREATED_AT_MILLIS,
                read: false,
                delivery: 'server_accepted',
                reason: null,
            },
        });
        expect(native.sendText).not.toHaveBeenCalled();
    });
    it('rejects a retry completion from the old native epoch after same-account SDK refresh', async () => {
        const { session, native, emitAuth, authority } = fixture();
        session.start();
        await settle();
        const before = { ...authority()! };
        const pending = deferred<Awaited<ReturnType<PrivateMessageNativePlugin['retryPending']>>>();
        native.retryPending.mockReturnValueOnce(pending.promise);
        const retrying = session.runtime.retryPending(getAuthIdentityScope(), ACCOUNT_B, MESSAGE);
        await settle();
        expect(native.retryPending).toHaveBeenCalledTimes(1);
        expect(native.retryPending.mock.calls[0][0].authority).toEqual(before);
        emitAuth('TOKEN_REFRESHED', RENEWED_BEARER_A);
        await settle();
        expect(session.state()).toBe('ready');
        expect(authority()!.lifecycleVersion).not.toBe(before.lifecycleVersion);
        pending.resolve({
            status: 'ok',
            authority: before,
            value: outgoingText(before, ACCOUNT_B, MESSAGE, 'Old lease retry fixture plaintext'),
        });
        expect(await retrying).toEqual({ status: 'unavailable', reason: 'stale_authority' });
        const retried = await session.runtime.retryPending(getAuthIdentityScope(), ACCOUNT_B, MESSAGE);
        expect(retried.status).toBe('ok');
        expect(native.retryPending).toHaveBeenCalledTimes(2);
        expect(native.retryPending.mock.calls[1][0].authority.lifecycleVersion).toBe(authority()!.lifecycleVersion);
        expect(native.sendText).not.toHaveBeenCalled();
    });
    it('never falls back to legacy chat after native refusal or transport failure', async () => {
        const { session, native } = fixture();
        session.start();
        await settle();
        native.getInbox.mockRejectedValueOnce(new Error('fixture transport failure'));
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        native.sendText.mockResolvedValueOnce({ status: 'unavailable', reason: 'peer_changed' });
        expect(await session.runtime.sendText(getAuthIdentityScope(), ACCOUNT_B, MESSAGE, 'Fixture text')).toEqual({
            status: 'unavailable',
            reason: 'peer_changed',
        });
        native.retryPending.mockResolvedValueOnce({ status: 'unavailable', reason: 'peer_changed' });
        expect(await session.runtime.retryPending(getAuthIdentityScope(), ACCOUNT_B, MESSAGE)).toEqual({
            status: 'unavailable',
            reason: 'peer_changed',
        });
        for (const callback of Object.values(legacy)) expect(callback).not.toHaveBeenCalled();
    });
    it('cannot install a late peer-control authority into a different signed-in account', async () => {
        const { session, native, setSdk } = fixture();
        session.start();
        await settle();
        const pending = deferred<Awaited<ReturnType<PrivateMessageNativePlugin['setBlocked']>>>();
        native.setBlocked.mockReturnValueOnce(pending.promise);
        const changing = session.runtime.setBlocked(getAuthIdentityScope(), ACCOUNT_B, true);
        await settle();
        expect(native.setBlocked).toHaveBeenCalledTimes(1);
        setSdk(BEARER_B);
        setAuthIdentityScope(ACCOUNT_B);
        await settle();
        pending.resolve({
            status: 'ok',
            authority: { ...AUTHORITY_A, lifecycleVersion: 'fixture:late-peer-control' },
            value: {
                peerAccountId: ACCOUNT_B,
                blockedByMe: true,
                blockedEitherDirection: true,
                canSend: false,
                reason: 'unavailable',
            },
        });
        expect((await changing).status).toBe('unavailable');
        expect(session.state()).toBe('ready');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
        expect(native.getInbox.mock.calls[0][0].authority.accountId).toBe(ACCOUNT_B);
    });
    it('cleans up a late native subscription handle after logical unsubscribe and suppresses its events', async () => {
        const { session, native, authority } = fixture();
        session.start();
        await settle();
        const subscription = deferred<() => void>();
        const nativeClose = vi.fn();
        let nativeReceive!: (event: NativePrivateMessageEvent) => void;
        native.subscribe.mockImplementationOnce((_request, callback) => {
            nativeReceive = callback;
            return subscription.promise;
        });
        const receive = vi.fn();
        const stop = session.runtime.subscribe(getAuthIdentityScope(), receive);
        await settle();
        expect(native.subscribe).toHaveBeenCalledTimes(1);
        stop();
        subscription.resolve(nativeClose);
        await settle();
        nativeReceive({
            status: 'ok',
            authority: authority()!,
            value: {
                id: `incoming:${MESSAGE}`,
                clientMessageId: MESSAGE,
                direction: 'incoming',
                senderAccountId: ACCOUNT_B,
                recipientAccountId: ACCOUNT_A,
                senderName: 'Paired sailor',
                text: 'Fixture after unsubscribe',
                localCreatedAtMillis: null,
                read: false,
                delivery: 'received',
                reason: null,
            },
        });
        await settle();
        expect(nativeClose).toHaveBeenCalledTimes(1);
        expect(receive).not.toHaveBeenCalled();
    });
    it('reverifies on its bounded timer, then disposal removes timer, SDK listener and native access', async () => {
        const { session, auth, native, authUnsubscribe, emitAuth } = fixture();
        session.start();
        await settle();
        expect(native.authenticate).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        await settle();
        expect(native.authenticate).toHaveBeenCalledTimes(2);
        expect(await session.dispose()).toBe(true);
        expect(session.state()).toBe('stopped');
        expect(authUnsubscribe).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        const fenceCount = native.fenceSession.mock.calls.length;
        const bootstrapCount = auth.getSession.mock.calls.length;
        emitAuth('SIGNED_IN', BEARER_B);
        setAuthIdentityScope(ACCOUNT_B);
        await vi.advanceTimersByTimeAsync(60_000);
        await settle();
        expect(native.authenticate).toHaveBeenCalledTimes(2);
        expect(native.fenceSession).toHaveBeenCalledTimes(fenceCount);
        expect(auth.getSession).toHaveBeenCalledTimes(bootstrapCount);
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
        expect(await session.dispose()).toBe(true);
    });
    it('reports failed native deactivation without claiming successful disposal', async () => {
        const { session, native } = fixture();
        session.start();
        await settle();
        native.fenceSession.mockResolvedValueOnce({ status: 'unavailable', reason: 'storage_failure' });
        expect(await session.dispose()).toBe(false);
        expect(session.state()).toBe('unavailable');
        expect((await session.runtime.getInbox(getAuthIdentityScope())).status).toBe('unavailable');
    });
    it('does not start overlapping timer verifications while SDK bootstrap is pending', async () => {
        const { session, auth, native } = fixture();
        const pending = deferred<Awaited<ReturnType<PrivateMessageSupabaseAuth['getSession']>>>();
        auth.getSession.mockReturnValueOnce(pending.promise);
        session.start();
        await settle();
        expect(session.state()).toBe('checking');
        await vi.advanceTimersByTimeAsync(3000);
        await settle();
        expect(auth.getSession).toHaveBeenCalledTimes(1);
        expect(native.fenceSession).toHaveBeenCalledTimes(1);
        expect(native.authenticate).not.toHaveBeenCalled();
        expect(await session.dispose()).toBe(true);
        pending.resolve({ data: { session: { access_token: BEARER_A } }, error: null });
        await settle();
        expect(session.state()).toBe('stopped');
        expect(native.authenticate).not.toHaveBeenCalled();
    });
});
