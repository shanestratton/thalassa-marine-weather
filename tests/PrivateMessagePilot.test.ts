import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    createPrivateMessagePilotRuntime,
    DISABLED_PRIVATE_MESSAGE_PILOT,
    isPrivateMessagePilotText,
    type NativePrivateMessageAuthority,
    type NativePrivateMessageEvent,
    type NativePrivateMessageResult,
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
    id,
    senderAccountId: account,
    recipientAccountId: peer,
    senderName: 'You',
    text: 'Fixture text',
    createdAt: '2026-10-02T00:00:00.000Z',
    read: true,
    delivery: 'server_accepted',
};
const permissions = { peerAccountId: peer, blockedByMe: false, blockedEitherDirection: false, canSend: true };
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
                    user_id: peer,
                    display_name: 'Paired fixture',
                    last_message: '',
                    last_at: message.createdAt,
                    unread_count: 0,
                },
            ]),
        ),
        getThread: vi.fn(async () => ok({ messages: [message], ...permissions })),
        sendText: vi.fn(async () => ok(message)),
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
            value: { messages: [message], ...permissions },
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
                    reason: 'blocked',
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
            message.text,
        );
        expect(port.sendText).toHaveBeenCalledWith({
            authority,
            peerAccountId: peer,
            clientMessageId: id,
            text: message.text,
        });
        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.value.delivery_status).toBe('sending');
        port.sendText.mockResolvedValue(ok({ ...message, id: device }));
        expect(
            (await createPrivateMessagePilotRuntime(port).sendText(getAuthIdentityScope(), peer, id, message.text))
                .status,
        ).toBe('unavailable');
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
        expect(listener.mock.calls[0][0]).toMatchObject({ status: 'ok', value: { id, read: true } });
        expect(listener.mock.calls[0][0].value.delivery_status).toBeUndefined();
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
        nativeListener(ok({ ...message, id: device, text: 'Second fixture message' }));
        second.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        first.resolve({ status: 'ready', authority, supportedContent: ['text'] });
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.map(([event]) => event.value.id)).toEqual([device, id]);
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
