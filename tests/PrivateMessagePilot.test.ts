import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    createPrivateMessagePilotRuntime,
    DISABLED_PRIVATE_MESSAGE_PILOT,
    isPrivateMessagePilotText,
    type NativePrivateMessageAuthority,
    type NativePrivateMessageEvent,
    type NativePrivateMessageResult,
    type NativePrivateMessageThread,
    type NativePrivateTextMessage,
    type PrivateMessageNativePort,
} from '../services/chat/e2ee/privateMessagePilot';

const account = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const authority: NativePrivateMessageAuthority = {
    accountId: account,
    deviceId: device,
    lifecycleVersion: 'owner1:epoch2',
    serverVerified: true,
};
const message: NativePrivateTextMessage = {
    id: `outgoing:${id}`,
    clientMessageId: id,
    direction: 'outgoing',
    senderAccountId: account,
    recipientAccountId: peer,
    senderName: 'You',
    text: 'Fixture text',
    localCreatedAtMillis: 1790899200000,
    read: false,
    delivery: 'server_accepted',
    reason: null,
};
const permissions = {
    peerAccountId: peer,
    blockedByMe: false,
    blockedEitherDirection: false,
    canSend: true,
    reason: null,
};
const nativeThread = (
    messages: NativePrivateTextMessage[] = [],
    overrides: Partial<NativePrivateMessageThread> = {},
): NativePrivateMessageThread => ({
    peerAccountId: peer,
    messages,
    permissions,
    unresolvedCount: 0,
    pendingAttemptId: null,
    ...overrides,
});
const ok = <T>(value: T): NativePrivateMessageResult<T> => ({ status: 'ok', authority, value });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function flushMicrotasks() {
    // Await the bounded async readiness -> validation -> finally chain, without
    // wall-clock sleeps or a fake timer changing the native event order.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}
function fixturePort() {
    return {
        readiness: vi.fn(async () => ({ status: 'ready' as const, authority, supportedContent: ['text'] as ['text'] })),
        getInbox: vi.fn(async () =>
            ok([
                {
                    peerAccountId: peer,
                    displayName: 'Paired sailor' as const,
                    lastText: null,
                    lastLocalCreatedAtMillis: null,
                    unreadCount: 0 as const,
                    historyAvailable: true,
                },
            ]),
        ),
        getThread: vi.fn(async () => ok(nativeThread([message]))),
        sendText: vi.fn(async () => ok(message)),
        retryPending: vi.fn(async () => ok(message)),
        getBlockStatus: vi.fn(async () => ok(permissions)),
        setBlocked: vi.fn(async () => ok(permissions)),
        subscribe: vi.fn(
            async (_request: unknown, _listener: (event: NativePrivateMessageEvent) => void): Promise<() => void> =>
                vi.fn<() => void>(),
        ),
    } satisfies PrivateMessageNativePort;
}
beforeEach(() => {
    setAuthIdentityScope(null);
    setAuthIdentityScope(account);
});

describe('private message screen adapter — explicit native port fixtures, not live encryption', () => {
    it('defaults to disabled and supports no environment or storage activation', () => {
        expect(DISABLED_PRIVATE_MESSAGE_PILOT).toEqual({ kind: 'disabled' });
        expect(Object.isFrozen(DISABLED_PRIVATE_MESSAGE_PILOT)).toBe(true);
    });
    it('reads only native rendering data under a matching server-verified lifecycle', async () => {
        const port = fixturePort();
        const runtime = createPrivateMessagePilotRuntime(port);
        const result = await runtime.getThread(getAuthIdentityScope(), peer);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.value.messages[0].message).toBe('Fixture text');
        expect(port.getThread).toHaveBeenCalledWith({ authority, peerAccountId: peer });
        expect(port.readiness).toHaveBeenCalledTimes(2);
        expect((await runtime.getInbox(getAuthIdentityScope())).status).toBe('ok');
    });
    it('preserves unknown native text, local time and read status without inventing legacy metadata', async () => {
        const port = fixturePort();
        port.getThread.mockResolvedValue(ok(nativeThread([{ ...message, text: null, localCreatedAtMillis: null }])));
        const runtime = createPrivateMessagePilotRuntime(port);
        const thread = await runtime.getThread(getAuthIdentityScope(), peer);
        expect(thread.status).toBe('ok');
        if (thread.status === 'ok') {
            expect(thread.value.messages[0]).toEqual({
                kind: 'native-pilot',
                id: `outgoing:${id}`,
                clientMessageId: id,
                direction: 'outgoing',
                sender_id: account,
                recipient_id: peer,
                sender_name: 'You',
                message: null,
                created_at: null,
                localCreatedAtMillis: null,
                read: false,
                delivery: 'server_accepted',
                reason: null,
            });
            expect(thread.value.unresolvedCount).toBe(0);
            expect(thread.value.pendingAttemptId).toBeNull();
        }
        const inbox = await runtime.getInbox(getAuthIdentityScope());
        expect(inbox.status).toBe('ok');
        if (inbox.status === 'ok') {
            expect(inbox.value[0]).toEqual({
                kind: 'native-pilot',
                user_id: peer,
                display_name: 'Paired sailor',
                last_message: null,
                last_at: null,
                unread_count: 0,
                historyAvailable: true,
            });
        }
    });
    it.each([
        { ...message, read: true },
        { ...message, localCreatedAtMillis: '2026-10-02T00:00:00.000Z' },
        { ...message, createdAt: '2026-10-02T00:00:00.000Z' },
        { ...message, senderName: 'Unverified profile name' },
        { ...message, id },
        { ...message, direction: 'incoming' },
    ])('refuses fabricated or legacy message metadata (%j)', async (unsupported) => {
        const port = fixturePort();
        port.getThread.mockResolvedValue(ok(nativeThread([unsupported as NativePrivateTextMessage])));
        expect(await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer)).toEqual({
            status: 'unavailable',
            reason: 'unavailable',
        });
    });
    it('keeps incoming and outgoing messages with the same client UUID as distinct directional records', async () => {
        const port = fixturePort();
        const incoming: NativePrivateTextMessage = {
            ...message,
            id: `incoming:${id}`,
            direction: 'incoming',
            senderAccountId: peer,
            recipientAccountId: account,
            senderName: 'Paired sailor',
            text: 'Incoming with colliding client UUID',
            localCreatedAtMillis: null,
            delivery: 'received',
        };
        port.getThread.mockResolvedValue(ok(nativeThread([message, incoming])));
        const result = await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
            expect(result.value.messages.map((item) => item.id)).toEqual([`outgoing:${id}`, `incoming:${id}`]);
            expect(result.value.messages.map((item) => item.clientMessageId)).toEqual([id, id]);
        }
    });
    it.each([0, Number.MAX_SAFE_INTEGER])(
        'preserves native local milliseconds %s and only renders representable dates',
        async (millis) => {
            const port = fixturePort();
            port.getThread.mockResolvedValue(ok(nativeThread([{ ...message, localCreatedAtMillis: millis }])));
            const result = await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer);
            expect(result.status).toBe('ok');
            if (result.status === 'ok') {
                expect(result.value.messages[0].localCreatedAtMillis).toBe(millis);
                expect(result.value.messages[0].created_at).toBe(millis === 0 ? '1970-01-01T00:00:00.000Z' : null);
            }
        },
    );
    it('refuses multiple native pending slots rather than choosing a retry target', async () => {
        const port = fixturePort();
        port.getThread.mockResolvedValue(
            ok(
                nativeThread(
                    [
                        { ...message, delivery: 'pending' },
                        { ...message, id: `outgoing:${device}`, clientMessageId: device, delivery: 'pending' },
                    ],
                    { pendingAttemptId: id },
                ),
            ),
        );
        expect(await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer)).toEqual({
            status: 'unavailable',
            reason: 'unavailable',
        });
        expect(port.retryPending).not.toHaveBeenCalled();
    });
    it('refuses a fabricated native unread count', async () => {
        const port = fixturePort();
        port.getInbox.mockResolvedValue(
            ok([
                {
                    peerAccountId: peer,
                    displayName: 'Paired sailor',
                    lastText: null,
                    lastLocalCreatedAtMillis: null,
                    unreadCount: 1,
                    historyAvailable: false,
                },
            ]) as never,
        );
        expect(await createPrivateMessagePilotRuntime(port).getInbox(getAuthIdentityScope())).toEqual({
            status: 'unavailable',
            reason: 'unavailable',
        });
    });
    it.each([
        { ...authority, serverVerified: false },
        { ...authority, accountId: peer },
        { ...authority, deviceId: `${device}\n` },
        { ...authority, lifecycleVersion: '' },
        { ...authority, lifecycleVersion: 'epoch\n' },
        { ...authority, privateKey: 'forbidden-fixture' },
    ])('refuses unsupported native readiness and never fetches history (%j)', async (badAuthority) => {
        const port = fixturePort();
        port.readiness.mockResolvedValue({
            status: 'ready',
            authority: badAuthority,
            supportedContent: ['text'],
        } as never);
        expect(await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer)).toEqual({
            status: 'unavailable',
            reason: 'unavailable',
        });
        expect(port.getThread).not.toHaveBeenCalled();
    });
    it('drops history with a wrong authority echo', async () => {
        const port = fixturePort();
        port.getThread.mockResolvedValue({
            status: 'ok',
            value: nativeThread([message]),
            authority: { ...authority, lifecycleVersion: 'old-epoch' },
        });
        expect(await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer)).toEqual({
            status: 'unavailable',
            reason: 'stale_authority',
        });
    });
    it('drops an old local auth scope before native dispatch', async () => {
        const port = fixturePort();
        const ready = deferred<Awaited<ReturnType<PrivateMessageNativePort['readiness']>>>();
        port.readiness.mockReturnValueOnce(ready.promise as never);
        const loading = createPrivateMessagePilotRuntime(port).getInbox(getAuthIdentityScope());
        setAuthIdentityScope(peer);
        ready.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        expect(await loading).toEqual({ status: 'unavailable', reason: 'stale_authority' });
        expect(port.getInbox).not.toHaveBeenCalled();
    });
    it('drops native lifecycle changes after a successful asynchronous result', async () => {
        const port = fixturePort();
        port.readiness
            .mockResolvedValueOnce({ status: 'ready', authority, supportedContent: ['text'] })
            .mockResolvedValueOnce({
                status: 'ready',
                authority: { ...authority, lifecycleVersion: 'owner1:epoch3' },
                supportedContent: ['text'],
            });
        expect(await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), peer)).toEqual({
            status: 'unavailable',
            reason: 'stale_authority',
        });
    });
    it('does not interpret peer change as usable history or permissions', async () => {
        const port = fixturePort();
        port.getBlockStatus.mockResolvedValue({ status: 'unavailable', reason: 'peer_changed' } as never);
        expect(await createPrivateMessagePilotRuntime(port).getBlockStatus(getAuthIdentityScope(), peer)).toEqual({
            status: 'unavailable',
            reason: 'peer_changed',
        });
    });
    it('refuses wrong-peer permission responses and unconfirmed block changes', async () => {
        const port = fixturePort();
        const runtime = createPrivateMessagePilotRuntime(port);
        port.getBlockStatus.mockResolvedValue(ok({ ...permissions, peerAccountId: device }));
        expect((await runtime.getBlockStatus(getAuthIdentityScope(), peer)).status).toBe('unavailable');
        expect((await runtime.setBlocked(getAuthIdentityScope(), peer, true)).status).toBe('unavailable');
    });
    it('accepts only a native peer-control transition matching fresh same-owner/device readiness', async () => {
        const port = fixturePort();
        let currentAuthority = authority;
        port.readiness.mockImplementation(async () => ({
            status: 'ready',
            authority: currentAuthority,
            supportedContent: ['text'],
        }));
        port.setBlocked.mockImplementation(async () => {
            currentAuthority = { ...authority, lifecycleVersion: 'owner1:epoch2:peer3' };
            return {
                status: 'ok',
                authority: currentAuthority,
                value: {
                    ...permissions,
                    blockedByMe: true,
                    blockedEitherDirection: true,
                    canSend: false,
                    reason: 'unavailable',
                },
            } as never;
        });
        const result = await createPrivateMessagePilotRuntime(port).setBlocked(getAuthIdentityScope(), peer, true);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.value.blockedByMe).toBe(true);
    });
    it('refuses self messages before any native request', async () => {
        const port = fixturePort();
        expect(await createPrivateMessagePilotRuntime(port).getThread(getAuthIdentityScope(), account)).toEqual({
            status: 'unavailable',
            reason: 'self_chat_unsupported',
        });
        expect(port.readiness).not.toHaveBeenCalled();
    });
    it.each(['📍PIN|1|2|Fixture', 'Hello\n🍳RECIPE:id|title|1|10|https://example.test/photo', ''])(
        'refuses structured/empty text %j without invoking native send',
        async (text) => {
            const port = fixturePort();
            expect(isPrivateMessagePilotText(text)).toBe(false);
            expect(
                await createPrivateMessagePilotRuntime(port).sendText(getAuthIdentityScope(), peer, id, text),
            ).toEqual({ status: 'unavailable', reason: 'unsupported_content' });
            expect(port.sendText).not.toHaveBeenCalled();
        },
    );
    it('requires exact stable client message ID and reports pending native relay confirmation', async () => {
        const port = fixturePort();
        port.sendText.mockResolvedValue(ok({ ...message, delivery: 'pending' }));
        const result = await createPrivateMessagePilotRuntime(port).sendText(
            getAuthIdentityScope(),
            peer,
            id,
            message.text!,
        );
        expect(port.sendText).toHaveBeenCalledWith({
            authority,
            peerAccountId: peer,
            clientMessageId: id,
            text: message.text,
        });
        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.value.delivery).toBe('pending');
        port.sendText.mockResolvedValue(ok({ ...message, id: `outgoing:${device}`, clientMessageId: device }));
        expect(
            (await createPrivateMessagePilotRuntime(port).sendText(getAuthIdentityScope(), peer, id, message.text!))
                .status,
        ).toBe('unavailable');
        port.sendText.mockResolvedValue(ok({ ...message, text: null }));
        expect(
            (await createPrivateMessagePilotRuntime(port).sendText(getAuthIdentityScope(), peer, id, message.text!))
                .status,
        ).toBe('unavailable');
    });
    it('retries only the exact native pending ID without a plaintext argument or a fabricated echo', async () => {
        const port = fixturePort();
        port.retryPending.mockResolvedValue(ok({ ...message, text: null, localCreatedAtMillis: null }));
        const runtime = createPrivateMessagePilotRuntime(port);
        const result = await runtime.retryPending(getAuthIdentityScope(), peer, id);
        expect(port.retryPending).toHaveBeenCalledExactlyOnceWith({
            authority,
            peerAccountId: peer,
            clientMessageId: id,
        });
        expect(port.sendText).not.toHaveBeenCalled();
        expect(result.status).toBe('ok');
        if (result.status === 'ok')
            expect(result.value).toMatchObject({
                id: `outgoing:${id}`,
                clientMessageId: id,
                message: null,
                created_at: null,
                read: false,
                delivery: 'server_accepted',
            });
        port.retryPending.mockResolvedValue(ok({ ...message, id: `outgoing:${device}`, clientMessageId: device }));
        expect((await runtime.retryPending(getAuthIdentityScope(), peer, id)).status).toBe('unavailable');
    });
    it('stops a late native subscription handle after disposal without delivering queued events', async () => {
        const port = fixturePort();
        const pending = deferred<() => void>();
        const stopNative = vi.fn();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation((_request, receive) => {
            nativeListener = receive;
            return pending.promise;
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(port.subscribe).toHaveBeenCalledTimes(1));
        stop();
        nativeListener(ok(message));
        pending.resolve(stopNative);
        await vi.waitFor(() => expect(stopNative).toHaveBeenCalledTimes(1));
        expect(listener).not.toHaveBeenCalled();
    });
    it('suppresses subscription plaintext after logout and rejects wrong echo events', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(port.subscribe).toHaveBeenCalledTimes(1));
        nativeListener({ status: 'ok', value: message, authority: { ...authority, deviceId: peer } });
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'unavailable', reason: 'unavailable' }));
        listener.mockClear();
        setAuthIdentityScope(null);
        nativeListener(ok(message));
        await Promise.resolve();
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
        stop();
    });
    it('drops an older same-ID event when its readiness check resolves after newer acceptance', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        const older = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        const newer = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        port.readiness.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        nativeListener(ok({ ...message, delivery: 'pending', read: false }));
        nativeListener(ok(message));
        newer.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toMatchObject({
            status: 'ok',
            value: { id: `outgoing:${id}`, read: false, delivery: 'server_accepted' },
        });
        older.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(1);
        stop();
    });
    it('preserves distinct message IDs when their readiness checks complete backwards', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        const first = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        const second = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        port.readiness.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        nativeListener(ok(message));
        nativeListener(
            ok({ ...message, id: `outgoing:${device}`, clientMessageId: device, text: 'Second fixture message' }),
        );
        second.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        first.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.map(([event]) => event.value.id)).toEqual([`outgoing:${device}`, `outgoing:${id}`]);
        stop();
    });
    it('does not conflate opposite directions sharing a client UUID when event checks complete backwards', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        const outgoing = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        const incoming = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        port.readiness.mockReturnValueOnce(outgoing.promise).mockReturnValueOnce(incoming.promise);
        nativeListener(ok(message));
        nativeListener(
            ok({
                ...message,
                id: `incoming:${id}`,
                direction: 'incoming',
                senderAccountId: peer,
                recipientAccountId: account,
                senderName: 'Paired sailor',
                text: 'Opposite direction fixture',
                localCreatedAtMillis: null,
                delivery: 'received',
            }),
        );
        incoming.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        outgoing.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.map(([event]) => event.value.id)).toEqual([`incoming:${id}`, `outgoing:${id}`]);
        stop();
    });
    it('still fences a superseded event check when it discovers current native authority is unavailable', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        const older = deferred<Awaited<ReturnType<PrivateMessageNativePort['readiness']>>>();
        port.readiness.mockReturnValueOnce(older.promise as never);
        nativeListener(ok({ ...message, delivery: 'pending', read: false }));
        nativeListener(ok(message));
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].status).toBe('ok');
        older.resolve({ status: 'unavailable', reason: 'stale_authority' });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.lastCall?.[0]).toEqual({ status: 'unavailable', reason: 'stale_authority' });
        stop();
    });
    it('a later unavailable event fences every earlier suspended plaintext validation', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        const waiting = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        port.readiness.mockReturnValueOnce(waiting.promise);
        nativeListener(ok(message));
        nativeListener({ status: 'unavailable', reason: 'peer_revoked' });
        expect(listener).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'peer_revoked' });
        waiting.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(1);
        stop();
    });
    it('rejects a conflicting same-ID payload even while its original validation is suspended', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return vi.fn<() => void>();
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        const waiting = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        port.readiness.mockReturnValueOnce(waiting.promise);
        nativeListener(ok(message));
        nativeListener(ok({ ...message, text: 'Conflicting fixture plaintext' }));
        expect(listener).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
        waiting.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(1);
        stop();
    });
    it.each([
        {
            field: 'text',
            known: message,
            unknown: { ...message, text: null },
            conflict: { ...message, text: 'Conflicting plaintext after an unknown echo' },
        },
        {
            field: 'local timestamp',
            known: message,
            unknown: { ...message, localCreatedAtMillis: null },
            conflict: { ...message, localCreatedAtMillis: message.localCreatedAtMillis! + 1000 },
        },
        {
            field: 'raw timestamp outside the Date range',
            known: { ...message, localCreatedAtMillis: Number.MAX_SAFE_INTEGER },
            unknown: { ...message, localCreatedAtMillis: null },
            conflict: { ...message, localCreatedAtMillis: Number.MAX_SAFE_INTEGER - 1 },
        },
    ])(
        'remembers known $field through an unknown echo and refuses conflicting same-ID metadata',
        async ({ known, unknown, conflict }) => {
            const port = fixturePort();
            const listener = vi.fn();
            let nativeListener!: (event: NativePrivateMessageEvent) => void;
            port.subscribe.mockImplementation(async (_request, receive) => {
                nativeListener = receive;
                return vi.fn<() => void>();
            });
            const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
            await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
            listener.mockClear();
            nativeListener(ok(known));
            await flushMicrotasks();
            nativeListener(ok(unknown));
            await flushMicrotasks();
            expect(listener).toHaveBeenCalledTimes(2);
            expect(listener.mock.lastCall?.[0]).toMatchObject({
                status: 'ok',
                value: { message: unknown.text, localCreatedAtMillis: unknown.localCreatedAtMillis },
            });
            if (unknown.localCreatedAtMillis === null) expect(listener.mock.lastCall?.[0].value.created_at).toBeNull();
            nativeListener(ok(conflict));
            await flushMicrotasks();
            expect(listener).toHaveBeenCalledTimes(3);
            expect(listener.mock.lastCall?.[0]).toEqual({ status: 'unavailable', reason: 'unavailable' });
            stop();
        },
    );
    it('bounds outstanding readiness work and closes overload rather than queueing more plaintext', async () => {
        const port = fixturePort();
        const listener = vi.fn();
        const stopNative = vi.fn<() => void>();
        let nativeListener!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, receive) => {
            nativeListener = receive;
            return stopNative;
        });
        const stop = createPrivateMessagePilotRuntime(port).subscribe(getAuthIdentityScope(), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'ready' }));
        listener.mockClear();
        port.readiness.mockClear();
        const waiting = deferred<Awaited<ReturnType<typeof port.readiness>>>();
        port.readiness.mockReturnValue(waiting.promise);
        for (let index = 0; index < 33; index += 1) nativeListener(ok(message));
        expect(port.readiness).toHaveBeenCalledTimes(32);
        expect(listener).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
        expect(stopNative).toHaveBeenCalledTimes(1);
        nativeListener(ok(message));
        expect(port.readiness).toHaveBeenCalledTimes(32);
        waiting.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(1);
        stop();
        expect(stopNative).toHaveBeenCalledTimes(1);
    });
});
