// Local bridge fixtures only. No native crypto, SDK login, network or devices.
import { describe, expect, it, vi } from 'vitest';
import { createResearchPrivateMessageNativePlugin } from '../experiments/scuttlebutt-e2ee/bridge-web/privateMessagePort';
import type { NativePrivateMessageEvent } from '../services/chat/e2ee/privateMessagePilot';

const OWNER = '10000000-0000-4000-8000-000000000001';
const PEER = '10000000-0000-4000-8000-000000000002';
const DEVICE = '10000000-0000-4000-8000-000000000003';
const VERSION = '10000000-0000-4000-8000-000000000004';
const FENCE = '10000000-0000-4000-8000-000000000005';
const BINDING = '10000000-0000-4000-8000-000000000006';
const MESSAGE = '10000000-0000-4000-8000-000000000007';
const auth = { accountId: OWNER, deviceId: DEVICE, lifecycleVersion: VERSION, serverVerified: true as const };
const ready = () => ({ status: 'ready', authority: { ...auth }, supportedContent: ['text'] });
const permission = () => ({
    peerAccountId: PEER,
    blockedByMe: false,
    blockedEitherDirection: false,
    canSend: true,
    reason: null,
});
const row = (direction: 'outgoing' | 'incoming' = 'outgoing') => ({
    id: `${direction}:${MESSAGE}`,
    clientMessageId: MESSAGE,
    direction,
    senderAccountId: direction === 'outgoing' ? OWNER : PEER,
    recipientAccountId: direction === 'outgoing' ? PEER : OWNER,
    senderName: direction === 'outgoing' ? 'You' : 'Paired sailor',
    text: 'synthetic private-port fixture',
    localCreatedAtMillis: direction === 'outgoing' ? 1234 : null,
    read: false,
    delivery: direction === 'outgoing' ? 'server_accepted' : 'received',
    reason: null,
});
const ok = (value: unknown) => ({ status: 'ok', authority: { ...auth }, value });
const thread = (messages: unknown[] = []) => ({
    peerAccountId: PEER,
    messages,
    permissions: permission(),
    unresolvedCount: 0,
    pendingAttemptId: null,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function fixture() {
    const native = {
        currentAccount: vi.fn(
            async (): Promise<unknown> => ({
                status: 'authenticated',
                account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
            }),
        ),
        fenceSession: vi.fn(async (_: { mode: 'verify' | 'sign_out' }) => ({ status: 'fenced', authFence: FENCE })),
        authenticate: vi.fn(async (_: { accessToken: string; authFence: string }) => ({
            status: 'authenticated',
            account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
        })),
        privateMessageIssue: vi.fn(async (_: { credentialBinding: string }): Promise<unknown> => ready()),
        privateMessageReadiness: vi.fn(async (_: { lifecycleVersion: string }): Promise<unknown> => ready()),
        privateMessagePermissions: vi.fn(
            async (_: { lifecycleVersion: string; peerAccountId: string }): Promise<unknown> => ok(permission()),
        ),
        privateMessageInbox: vi.fn(
            async (_: { lifecycleVersion: string }): Promise<unknown> =>
                ok([
                    {
                        peerAccountId: PEER,
                        displayName: 'Paired sailor',
                        lastText: null,
                        lastLocalCreatedAtMillis: null,
                        unreadCount: 0,
                        historyAvailable: true,
                    },
                ]),
        ),
        privateMessageThread: vi.fn(
            async (_: { lifecycleVersion: string; peerAccountId: string }): Promise<unknown> => ok(thread()),
        ),
        privateMessageSendText: vi.fn(
            async (_: {
                lifecycleVersion: string;
                peerAccountId: string;
                clientMessageId: string;
                text: string;
            }): Promise<unknown> => ok(row()),
        ),
        privateMessageRetryPending: vi.fn(
            async (_: { lifecycleVersion: string; peerAccountId: string; clientMessageId: string }): Promise<unknown> =>
                ok(row()),
        ),
    };
    const port = createResearchPrivateMessageNativePlugin(native);
    const open = async () => {
        expect(await port.fenceSession({ mode: 'verify' })).toEqual({ status: 'fenced', authFence: FENCE });
        return port.authenticate({ accessToken: 'synthetic-fixture-token', authFence: FENCE });
    };
    return { native, port, open };
}
function holdNextReadiness(f: ReturnType<typeof fixture>) {
    const held = deferred<unknown>();
    const entered = deferred<void>();
    f.native.privateMessageReadiness.mockImplementationOnce(() => {
        entered.resolve();
        return held.promise;
    });
    return { held, entered };
}
const sendRequest = () => ({
    authority: { ...auth },
    peerAccountId: PEER,
    clientMessageId: MESSAGE,
    text: 'synthetic private-port fixture',
});

describe('explicit Research-to-private-message bridge — mocked native boundary', () => {
    it('connects the existing native Auth host without a second SDK fence or bearer acquisition', async () => {
        const f = fixture();
        expect(await f.port.connectCurrentAccount()).toEqual(ready());
        expect(f.native.currentAccount).toHaveBeenCalledTimes(1);
        expect(f.native.privateMessageIssue).toHaveBeenCalledWith({ credentialBinding: BINDING });
        expect(f.native.fenceSession).not.toHaveBeenCalled();
        expect(f.native.authenticate).not.toHaveBeenCalled();
        f.port.invalidateView();
        expect((await f.port.readiness()).status).toBe('unavailable');
        expect(f.native.fenceSession).not.toHaveBeenCalled();
    });
    it('cannot connect an unpaired current native account or late connection after view fencing', async () => {
        const f = fixture();
        f.native.privateMessageIssue.mockResolvedValue({ status: 'unavailable', reason: 'unavailable' });
        expect((await f.port.connectCurrentAccount()).status).toBe('unavailable');
        const g = fixture(),
            held = deferred<unknown>();
        g.native.currentAccount.mockImplementationOnce(() => held.promise);
        const connecting = g.port.connectCurrentAccount();
        g.port.invalidateView();
        held.resolve({
            status: 'authenticated',
            account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
        });
        expect((await connecting).status).toBe('unavailable');
        expect(g.native.privateMessageIssue).not.toHaveBeenCalled();
    });
    it('requires native full-pair issuance rather than promoting an Auth Boolean', async () => {
        const f = fixture();
        f.native.privateMessageIssue.mockResolvedValue({ status: 'unavailable', reason: 'unavailable' });
        expect(await f.open()).toEqual({ status: 'unavailable', reason: 'unavailable' });
        expect(await f.port.readiness()).toEqual({ status: 'unavailable', reason: 'unavailable' });
        expect(f.native.privateMessageIssue).toHaveBeenCalledWith({ credentialBinding: BINDING });
        expect(f.native.privateMessageInbox).not.toHaveBeenCalled();
    });
    it('issues one stable native descriptor and checks it before and after each action', async () => {
        const f = fixture();
        expect(await f.open()).toEqual(ready());
        expect(await f.port.readiness()).toEqual(ready());
        expect((await f.port.getInbox({ authority: auth })).status).toBe('ok');
        expect(f.native.privateMessageIssue).toHaveBeenCalledTimes(1);
        expect(
            f.native.privateMessageReadiness.mock.calls.every(
                ([arg]) => Object.keys(arg).join() === 'lifecycleVersion',
            ),
        ).toBe(true);
    });
    it('burns the fence and never issues from an old Auth completion', async () => {
        const f = fixture();
        const held = deferred<unknown>();
        f.native.authenticate.mockImplementationOnce(() => held.promise as ReturnType<typeof f.native.authenticate>);
        await f.port.fenceSession({ mode: 'verify' });
        const checking = f.port.authenticate({ accessToken: 'synthetic-fixture-token', authFence: FENCE });
        await f.port.fenceSession({ mode: 'sign_out' });
        held.resolve({
            status: 'authenticated',
            account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
        });
        expect(await checking).toEqual({ status: 'unavailable', reason: 'unavailable' });
        expect(f.native.privateMessageIssue).not.toHaveBeenCalled();
    });
    it('cannot publish a descriptor when reentrant readiness listeners fence it', async () => {
        // Register after an explicit first fence, then authenticate; the callback
        // uses one shot to avoid recursive fixture notification.
        const g = fixture();
        await g.port.fenceSession({ mode: 'verify' });
        let once = false;
        g.port.subscribeReadiness?.(() => {
            if (!once) {
                once = true;
                void g.port.fenceSession({ mode: 'sign_out' });
            }
        });
        expect(await g.port.authenticate({ accessToken: 'synthetic-fixture-token', authFence: FENCE })).toEqual({
            status: 'unavailable',
            reason: 'unavailable',
        });
    });
    it('reads honest unknown inbox fields without inventing a time or preview', async () => {
        const f = fixture();
        await f.open();
        const result = await f.port.getInbox({ authority: auth });
        expect(result).toEqual(
            ok([
                {
                    peerAccountId: PEER,
                    displayName: 'Paired sailor',
                    lastText: null,
                    lastLocalCreatedAtMillis: null,
                    unreadCount: 0,
                    historyAvailable: true,
                },
            ]),
        );
    });
    it('keeps directional IDs separate and accepts only native null incoming clocks', async () => {
        const f = fixture();
        await f.open();
        f.native.privateMessageThread.mockResolvedValue(ok(thread([row('outgoing'), row('incoming')])));
        const result = await f.port.getThread({ authority: auth, peerAccountId: PEER });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('fixture thread refused');
        expect(result.value.messages.map((m) => m.id)).toEqual([`outgoing:${MESSAGE}`, `incoming:${MESSAGE}`]);
        expect(result.value.messages[1].localCreatedAtMillis).toBeNull();
    });
    it.each([
        { read: true },
        { localCreatedAtMillis: 1 },
        { delivery: 'server_accepted' },
        { senderAccountId: OWNER },
        { senderName: 'invented name' },
        { wire: 'not permitted' },
    ])('refuses malformed incoming projection %j', async (change) => {
        const f = fixture();
        await f.open();
        f.native.privateMessageThread.mockResolvedValue(ok(thread([{ ...row('incoming'), ...change }])));
        expect((await f.port.getThread({ authority: auth, peerAccountId: PEER })).status).toBe('unavailable');
    });
    it('refuses mismatched pending metadata rather than choosing a new attempt', async () => {
        const f = fixture();
        await f.open();
        f.native.privateMessageThread.mockResolvedValue(
            ok({ ...thread([{ ...row(), delivery: 'pending' }]), pendingAttemptId: null }),
        );
        expect((await f.port.getThread({ authority: auth, peerAccountId: PEER })).status).toBe('unavailable');
    });
    it('preserves authenticated local history but disables send after a refused refresh', async () => {
        const f = fixture();
        await f.open();
        f.native.privateMessagePermissions.mockRejectedValue(new Error('synthetic transport refusal'));
        f.native.privateMessageThread.mockResolvedValue(ok(thread([row('incoming')])));
        const result = await f.port.getThread({ authority: auth, peerAccountId: PEER });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('fixture local thread refused');
        expect(result.value.messages).toHaveLength(1);
        expect(result.value.permissions).toEqual({ ...permission(), canSend: false, reason: 'unavailable' });
    });
    it('retries only a native saved ID without plaintext or preparation arguments', async () => {
        const f = fixture();
        await f.open();
        f.native.privateMessageRetryPending.mockResolvedValue(ok({ ...row(), text: null, localCreatedAtMillis: null }));
        const result = await f.port.retryPending({ authority: auth, peerAccountId: PEER, clientMessageId: MESSAGE });
        expect(result.status).toBe('ok');
        expect(f.native.privateMessageRetryPending).toHaveBeenCalledWith({
            lifecycleVersion: VERSION,
            peerAccountId: PEER,
            clientMessageId: MESSAGE,
        });
        expect(f.native.privateMessageSendText).not.toHaveBeenCalled();
    });
    it('new send requires a committed matching echo, not submitted text as success', async () => {
        const f = fixture();
        await f.open();
        f.native.privateMessageSendText.mockResolvedValue(ok({ ...row(), text: null }));
        expect(
            (
                await f.port.sendText({
                    authority: auth,
                    peerAccountId: PEER,
                    clientMessageId: MESSAGE,
                    text: 'synthetic private-port fixture',
                })
            ).status,
        ).toBe('unavailable');
    });
    it('refuses late send output and emits no event after logout', async () => {
        const f = fixture();
        await f.open();
        const held = deferred<unknown>();
        f.native.privateMessageSendText.mockImplementationOnce(() => held.promise);
        const events = vi.fn();
        await f.port.subscribe({ authority: auth }, events);
        const sending = f.port.sendText({
            authority: auth,
            peerAccountId: PEER,
            clientMessageId: MESSAGE,
            text: 'synthetic private-port fixture',
        });
        await vi.waitFor(() => expect(f.native.privateMessageSendText).toHaveBeenCalledTimes(1));
        await f.port.fenceSession({ mode: 'sign_out' });
        held.resolve(ok(row()));
        expect((await sending).status).toBe('unavailable');
        expect(events).not.toHaveBeenCalled();
    });
    it('does not dispatch a caller authority with additional claims', async () => {
        const f = fixture();
        await f.open();
        expect((await f.port.getInbox({ authority: { ...auth, peer: PEER } as typeof auth })).status).toBe(
            'unavailable',
        );
        expect(f.native.privateMessageInbox).not.toHaveBeenCalled();
    });
    it('has no native block mutation or legacy fallback', async () => {
        const f = fixture();
        await f.open();
        expect((await f.port.setBlocked({ authority: auth, peerAccountId: PEER, blocked: true })).status).toBe(
            'unavailable',
        );
        expect(f.native.privateMessageSendText).not.toHaveBeenCalled();
        expect(f.native.privateMessageRetryPending).not.toHaveBeenCalled();
    });
    it('does not dispatch or accept an outer verify fence superseded by reentrant one-shot sign-out notification', async () => {
        const f = fixture();
        let signingOut: Promise<unknown> | undefined;
        let once = false;
        f.port.subscribeReadiness?.(() => {
            if (once) return;
            once = true;
            signingOut = f.port.fenceSession({ mode: 'sign_out' });
        });
        expect(await f.port.fenceSession({ mode: 'verify' })).toEqual({ status: 'unavailable', reason: 'unavailable' });
        await signingOut;
        expect(f.native.fenceSession).toHaveBeenCalledExactlyOnceWith({ mode: 'sign_out' });
        expect(await f.port.authenticate({ accessToken: 'synthetic-fixture-token', authFence: FENCE })).toEqual({
            status: 'unavailable',
            reason: 'unavailable',
        });
        expect(f.native.authenticate).not.toHaveBeenCalled();
        expect(f.native.privateMessageIssue).not.toHaveBeenCalled();
    });
    it.each(['invoke dispatch', 'invoke result', 'readiness', 'subscription'] as const)(
        'fences the %s continuation when logout occurs after check returns true but before its caller resumes',
        async (operation) => {
            const f = fixture();
            await f.open();
            if (operation === 'invoke result') f.native.privateMessageReadiness.mockResolvedValueOnce(ready());
            const { held, entered } = holdNextReadiness(f);
            const events = vi.fn();
            const pending =
                operation === 'readiness'
                    ? f.port.readiness()
                    : operation === 'subscription'
                      ? f.port.subscribe({ authority: { ...auth } }, events)
                      : f.port.getInbox({ authority: { ...auth } });
            await entered.promise;
            let signingOut: Promise<unknown> | undefined;
            // Resolution queues check() first; logout then runs before the
            // continuation of the caller awaiting check()'s Boolean result.
            held.resolve(ready());
            queueMicrotask(() => {
                signingOut = f.port.fenceSession({ mode: 'sign_out' });
            });
            const result = await pending;
            await signingOut;
            if (operation === 'subscription') {
                expect(events).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
                expect(result).toEqual(expect.any(Function));
                if (typeof result === 'function') result();
                await f.open();
                const fresh = Array.from({ length: 32 }, () => vi.fn());
                const stops = await Promise.all(
                    fresh.map((listener) => f.port.subscribe({ authority: auth }, listener)),
                );
                for (const listener of fresh) expect(listener).not.toHaveBeenCalled();
                const overflow = vi.fn();
                const stopOverflow = await f.port.subscribe({ authority: auth }, overflow);
                expect(overflow).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
                for (const stop of stops) stop();
                stopOverflow();
            } else {
                expect(result).toEqual({ status: 'unavailable', reason: 'unavailable' });
            }
            expect(f.native.privateMessageInbox).toHaveBeenCalledTimes(operation === 'invoke result' ? 1 : 0);
        },
    );
    it.each(['send', 'retry'] as const)(
        'fences the returned %s result and later subscribers when the first subscriber logs out',
        async (operation) => {
            const f = fixture();
            await f.open();
            let signingOut: Promise<unknown> | undefined;
            const first = vi.fn(() => {
                signingOut = f.port.fenceSession({ mode: 'sign_out' });
            });
            const later = vi.fn();
            await f.port.subscribe({ authority: auth }, first);
            await f.port.subscribe({ authority: auth }, later);
            const result = await (operation === 'send'
                ? f.port.sendText(sendRequest())
                : f.port.retryPending(sendRequest()));
            await signingOut;
            expect(first).toHaveBeenCalledExactlyOnceWith(ok(row()));
            expect(later).not.toHaveBeenCalled();
            expect(result).toEqual({ status: 'unavailable', reason: 'unavailable' });
            expect(await f.port.readiness()).toEqual({ status: 'unavailable', reason: 'unavailable' });
        },
    );
    it('skips a later subscriber removed reentrantly by the first subscriber', async () => {
        const f = fixture();
        await f.open();
        let stopLater!: () => void;
        const first = vi.fn(() => stopLater());
        const later = vi.fn();
        const stopFirst = await f.port.subscribe({ authority: auth }, first);
        stopLater = await f.port.subscribe({ authority: auth }, later);
        expect(await f.port.sendText(sendRequest())).toEqual(ok(row()));
        expect(first).toHaveBeenCalledTimes(1);
        expect(later).not.toHaveBeenCalled();
        stopFirst();
    });
    it('snapshots fence mode before awaiting the native response', async () => {
        const f = fixture();
        const held = deferred<unknown>();
        f.native.fenceSession.mockImplementationOnce(() => held.promise as ReturnType<typeof f.native.fenceSession>);
        const options: { mode: 'verify' | 'sign_out' } = { mode: 'verify' };
        const fencing = f.port.fenceSession(options);
        options.mode = 'sign_out';
        held.resolve({ status: 'fenced', authFence: FENCE });
        expect(await fencing).toEqual({ status: 'fenced', authFence: FENCE });
        expect(f.native.fenceSession).toHaveBeenCalledWith({ mode: 'verify' });
        expect(await f.port.authenticate({ accessToken: 'synthetic-fixture-token', authFence: FENCE })).toEqual(
            ready(),
        );
    });
    it('snapshots the authenticated native descriptor before awaiting private-pair issuance', async () => {
        const f = fixture();
        await f.port.fenceSession({ mode: 'verify' });
        const authenticated = {
            status: 'authenticated',
            account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
        };
        f.native.authenticate.mockResolvedValueOnce(authenticated);
        const held = deferred<unknown>();
        const issuing = deferred<void>();
        f.native.privateMessageIssue.mockImplementationOnce(() => {
            issuing.resolve();
            return held.promise;
        });
        const options = { accessToken: 'synthetic-fixture-token', authFence: FENCE };
        const opening = f.port.authenticate(options);
        await issuing.promise;
        Object.assign(authenticated.account, { accountId: PEER, deviceId: MESSAGE, credentialBinding: MESSAGE });
        Object.assign(options, { accessToken: 'changed-fixture-token', authFence: MESSAGE });
        held.resolve(ready());
        expect(await opening).toEqual(ready());
        expect(f.native.authenticate).toHaveBeenCalledWith({
            accessToken: 'synthetic-fixture-token',
            authFence: FENCE,
        });
        expect(f.native.privateMessageIssue).toHaveBeenCalledWith({ credentialBinding: BINDING });
    });
    it.each(['inbox', 'thread', 'permissions', 'send', 'retry', 'subscription'] as const)(
        'snapshots mutable caller authority and scalars before the first awaited %s check',
        async (operation) => {
            const f = fixture();
            await f.open();
            const { held, entered } = holdNextReadiness(f);
            const request = sendRequest();
            const events = vi.fn();
            const pending: Promise<unknown> =
                operation === 'inbox'
                    ? f.port.getInbox(request)
                    : operation === 'thread'
                      ? f.port.getThread(request)
                      : operation === 'permissions'
                        ? f.port.getBlockStatus(request)
                        : operation === 'send'
                          ? f.port.sendText(request)
                          : operation === 'retry'
                            ? f.port.retryPending(request)
                            : f.port.subscribe(request, events);
            await entered.promise;
            Object.assign(request.authority, { accountId: PEER, deviceId: MESSAGE, lifecycleVersion: MESSAGE });
            Object.assign(request, { peerAccountId: DEVICE, clientMessageId: DEVICE, text: 'mutated caller draft' });
            held.resolve(ready());
            const result = await pending;
            if (operation === 'subscription') {
                expect(events).not.toHaveBeenCalled();
                expect(result).toEqual(expect.any(Function));
                expect(await f.port.sendText(sendRequest())).toEqual(ok(row()));
                expect(events).toHaveBeenCalledExactlyOnceWith(ok(row()));
                if (typeof result === 'function') result();
            } else expect(result).toMatchObject({ status: 'ok', authority: auth });
            if (operation === 'inbox')
                expect(f.native.privateMessageInbox).toHaveBeenCalledWith({ lifecycleVersion: VERSION });
            if (operation === 'thread' || operation === 'permissions')
                expect(f.native.privateMessagePermissions).toHaveBeenCalledWith({
                    lifecycleVersion: VERSION,
                    peerAccountId: PEER,
                });
            if (operation === 'thread')
                expect(f.native.privateMessageThread).toHaveBeenCalledWith({
                    lifecycleVersion: VERSION,
                    peerAccountId: PEER,
                });
            if (operation === 'send' || operation === 'subscription')
                expect(f.native.privateMessageSendText).toHaveBeenCalledWith({
                    lifecycleVersion: VERSION,
                    peerAccountId: PEER,
                    clientMessageId: MESSAGE,
                    text: 'synthetic private-port fixture',
                });
            if (operation === 'retry')
                expect(f.native.privateMessageRetryPending).toHaveBeenCalledWith({
                    lifecycleVersion: VERSION,
                    peerAccountId: PEER,
                    clientMessageId: MESSAGE,
                });
        },
    );
    it.each([
        { lastText: 'a preview cannot exist without available native history', lastLocalCreatedAtMillis: null },
        { lastText: null, lastLocalCreatedAtMillis: 1234 },
    ])('refuses unavailable native history with nonnull preview metadata %j', async (metadata) => {
        const f = fixture();
        await f.open();
        f.native.privateMessageInbox.mockResolvedValue(
            ok([
                {
                    peerAccountId: PEER,
                    displayName: 'Paired sailor',
                    ...metadata,
                    unreadCount: 0,
                    historyAvailable: false,
                },
            ]),
        );
        expect(await f.port.getInbox({ authority: auth })).toEqual({ status: 'unavailable', reason: 'unavailable' });
    });
    it('reserves all concurrent subscription setups before awaiting readiness and refuses the thirty-third', async () => {
        const f = fixture();
        await f.open();
        f.native.privateMessageReadiness.mockClear();
        const held = deferred<unknown>();
        f.native.privateMessageReadiness.mockImplementation(() => held.promise);
        const events = Array.from({ length: 33 }, () => vi.fn());
        const subscribing = events.map((listener) => f.port.subscribe({ authority: auth }, listener));
        expect(f.native.privateMessageReadiness).toHaveBeenCalledTimes(32);
        expect(events[32]).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
        held.resolve(ready());
        const stops = await Promise.all(subscribing);
        for (const listener of events.slice(0, 32)) expect(listener).not.toHaveBeenCalled();
        expect(await f.port.sendText(sendRequest())).toEqual(ok(row()));
        for (const listener of events.slice(0, 32)) expect(listener).toHaveBeenCalledExactlyOnceWith(ok(row()));
        expect(events[32]).toHaveBeenCalledTimes(1);
        for (const stop of stops) stop();
    });
    it('keeps pending setup reservations across resets, releases them on completion and never adds stale listeners', async () => {
        const f = fixture();
        await f.open();
        const oldActive = vi.fn();
        const stopOldActive = await f.port.subscribe({ authority: auth }, oldActive);
        const held = deferred<unknown>();
        f.native.privateMessageReadiness.mockImplementation(() => held.promise);
        const staleEvents = Array.from({ length: 31 }, () => vi.fn());
        const staleSetups = staleEvents.map((listener) => f.port.subscribe({ authority: auth }, listener));
        await f.port.fenceSession({ mode: 'sign_out' });
        f.native.privateMessageReadiness.mockImplementation(async () => ready());
        await f.open();
        const freshFirst = vi.fn();
        const stopFreshFirst = await f.port.subscribe({ authority: auth }, freshFirst);
        expect(freshFirst).not.toHaveBeenCalled();
        const callsBeforeOverflow = f.native.privateMessageReadiness.mock.calls.length;
        const overflowWhilePending = vi.fn();
        const stopOverflowWhilePending = await f.port.subscribe({ authority: auth }, overflowWhilePending);
        expect(overflowWhilePending).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
        expect(f.native.privateMessageReadiness).toHaveBeenCalledTimes(callsBeforeOverflow);
        held.resolve(ready());
        const staleStops = await Promise.all(staleSetups);
        for (const listener of staleEvents)
            expect(listener).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
        const freshRest = Array.from({ length: 31 }, () => vi.fn());
        const freshStops = await Promise.all(
            freshRest.map((listener) => f.port.subscribe({ authority: auth }, listener)),
        );
        for (const listener of freshRest) expect(listener).not.toHaveBeenCalled();
        const overflowAfterTransfer = vi.fn();
        const stopOverflowAfterTransfer = await f.port.subscribe({ authority: auth }, overflowAfterTransfer);
        expect(overflowAfterTransfer).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
        expect(await f.port.sendText(sendRequest())).toEqual(ok(row()));
        expect(freshFirst).toHaveBeenCalledExactlyOnceWith(ok(row()));
        for (const listener of freshRest) expect(listener).toHaveBeenCalledExactlyOnceWith(ok(row()));
        for (const listener of staleEvents) expect(listener).toHaveBeenCalledTimes(1);
        expect(oldActive).not.toHaveBeenCalled();
        for (const stop of [
            ...staleStops,
            ...freshStops,
            stopOldActive,
            stopFreshFirst,
            stopOverflowWhilePending,
            stopOverflowAfterTransfer,
        ])
            stop();
    });
    it.each(['malformed authority', 'readiness refusal', 'capacity refusal'] as const)(
        'guards a throwing %s listener and returns a harmless unsubscribe handle',
        async (failure) => {
            const f = fixture();
            await f.open();
            const stops: Array<() => void> = [];
            if (failure === 'capacity refusal')
                stops.push(
                    ...(await Promise.all(
                        Array.from({ length: 32 }, () => f.port.subscribe({ authority: auth }, vi.fn())),
                    )),
                );
            if (failure === 'readiness refusal')
                f.native.privateMessageReadiness.mockRejectedValueOnce(new Error('synthetic readiness refusal'));
            const callsBefore = f.native.privateMessageReadiness.mock.calls.length;
            const throwing = vi.fn(() => {
                throw new Error('synthetic subscriber refusal');
            });
            const requestedAuthority = failure === 'malformed authority' ? { ...auth, extra: true } : { ...auth };
            const stop = await f.port.subscribe({ authority: requestedAuthority }, throwing);
            expect(stop).toEqual(expect.any(Function));
            expect(throwing).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable', reason: 'unavailable' });
            expect(f.native.privateMessageReadiness).toHaveBeenCalledTimes(
                callsBefore + (failure === 'readiness refusal' ? 1 : 0),
            );
            stop();
            for (const existingStop of stops) existingStop();
        },
    );
    it.each(['authority', 'message', 'both'] as const)(
        'gives each subscriber and caller independent projected copies despite %s mutation',
        async (field) => {
            const f = fixture();
            await f.open();
            const mutating = vi.fn((event: NativePrivateMessageEvent) => {
                if (event.status !== 'ok') throw new Error('expected committed fixture event');
                if (field !== 'message') Object.assign(event.authority, { accountId: PEER, lifecycleVersion: MESSAGE });
                if (field !== 'authority')
                    Object.assign(event.value, {
                        id: `outgoing:${DEVICE}`,
                        clientMessageId: DEVICE,
                        text: 'subscriber-mutated text',
                        localCreatedAtMillis: 9999,
                    });
            });
            const later = vi.fn();
            const stopMutating = await f.port.subscribe({ authority: auth }, mutating);
            const stopLater = await f.port.subscribe({ authority: auth }, later);
            const result = await f.port.sendText(sendRequest());
            expect(mutating).toHaveBeenCalledTimes(1);
            expect(later).toHaveBeenCalledExactlyOnceWith(ok(row()));
            expect(result).toEqual(ok(row()));
            if (result.status !== 'ok') throw new Error('expected independent committed fixture response');
            const firstEvent = mutating.mock.calls[0][0];
            const laterEvent = later.mock.calls[0][0];
            expect(firstEvent).not.toBe(laterEvent);
            expect(laterEvent).not.toBe(result);
            if (firstEvent.status !== 'ok') throw new Error('expected first committed fixture event');
            expect(firstEvent.authority).not.toBe(laterEvent.authority);
            expect(firstEvent.value).not.toBe(laterEvent.value);
            expect(laterEvent.authority).not.toBe(result.authority);
            expect(laterEvent.value).not.toBe(result.value);
            Object.assign(result.authority, { lifecycleVersion: DEVICE });
            Object.assign(result.value, { text: 'caller-mutated text' });
            expect(later.mock.calls[0][0]).toEqual(ok(row()));
            stopMutating();
            stopLater();
        },
    );
});
