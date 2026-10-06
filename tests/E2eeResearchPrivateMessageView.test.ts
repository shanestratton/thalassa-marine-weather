// @vitest-environment jsdom
// Deterministic local view/DOM fixtures only: no SDK login, crypto, relay or device claims.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, getAllByText, getByRole, getByText } from '@testing-library/dom';
import {
    createPrivateMessageViewController,
    mountPrivateMessageView,
} from '../experiments/scuttlebutt-e2ee/bridge-web/privateMessageView';
import type {
    NativePrivateMessageAuthority,
    NativePrivateMessageEvent,
    NativePrivateMessageInboxEntry,
    NativePrivateMessageThread,
    NativePrivateTextMessage,
} from '../services/chat/e2ee/privateMessagePilot';

vi.mock('../services/supabase', () => {
    throw new Error('pure private-message view must not load SDK auth');
});
vi.mock('../services/ChatService', () => {
    throw new Error('pure private-message view must not load legacy chat');
});
vi.mock('@capacitor/core', () => {
    throw new Error('pure private-message view must not register a native plugin');
});

const OWNER = '10000000-0000-4000-8000-000000000001';
const PEER = '10000000-0000-4000-8000-000000000002';
const DEVICE = '10000000-0000-4000-8000-000000000003';
const VERSION = '10000000-0000-4000-8000-000000000004';
const MESSAGE = '10000000-0000-4000-8000-000000000007';
const NEXT_MESSAGE = '10000000-0000-4000-8000-000000000008';
const auth: NativePrivateMessageAuthority = {
    accountId: OWNER,
    deviceId: DEVICE,
    lifecycleVersion: VERSION,
    serverVerified: true,
};
const ready = () => ({ status: 'ready' as const, authority: { ...auth }, supportedContent: ['text'] as ['text'] });
const ok = (value: unknown) => ({ status: 'ok', authority: { ...auth }, value });
const inboxEntry = (overrides: Partial<NativePrivateMessageInboxEntry> = {}): NativePrivateMessageInboxEntry => ({
    peerAccountId: PEER,
    displayName: 'Paired sailor',
    lastText: null,
    lastLocalCreatedAtMillis: null,
    unreadCount: 0,
    historyAvailable: true,
    ...overrides,
});
const message = (overrides: Partial<NativePrivateTextMessage> = {}): NativePrivateTextMessage => {
    const direction = overrides.direction ?? 'outgoing';
    const clientMessageId = overrides.clientMessageId ?? MESSAGE;
    return {
        id: `${direction}:${clientMessageId}`,
        clientMessageId,
        direction,
        senderAccountId: direction === 'outgoing' ? OWNER : PEER,
        recipientAccountId: direction === 'outgoing' ? PEER : OWNER,
        senderName: direction === 'outgoing' ? 'You' : 'Paired sailor',
        text: 'Native fixture text',
        localCreatedAtMillis: direction === 'outgoing' ? 1234 : null,
        read: false,
        delivery: direction === 'outgoing' ? 'server_accepted' : 'received',
        reason: null,
        ...overrides,
    };
};
const thread = (
    messages: NativePrivateTextMessage[] = [],
    overrides: Partial<NativePrivateMessageThread> = {},
): NativePrivateMessageThread => ({
    peerAccountId: PEER,
    messages,
    permissions: {
        peerAccountId: PEER,
        blockedByMe: false,
        blockedEitherDirection: false,
        canSend: true,
        reason: null,
    },
    unresolvedCount: 0,
    pendingAttemptId:
        messages.find((row) => row.direction === 'outgoing' && row.delivery === 'pending')?.clientMessageId ?? null,
    ...overrides,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function flushMicrotasks() {
    for (let turn = 0; turn < 48; turn += 1) await Promise.resolve();
}
const cleanups: Array<() => void> = [];
function fixture() {
    let receive: ((event: NativePrivateMessageEvent) => void) | undefined;
    let readinessChanged: (() => void) | undefined;
    const nativeReadiness = vi.fn(async (): Promise<unknown> => ready());
    const createClientMessageId = vi.fn(() => NEXT_MESSAGE);
    let savedThread = thread();
    const commit = (row: NativePrivateTextMessage) => {
        savedThread = {
            ...savedThread,
            messages: [...savedThread.messages.filter((existing) => existing.id !== row.id), row],
            pendingAttemptId:
                savedThread.pendingAttemptId === row.clientMessageId ? null : savedThread.pendingAttemptId,
        };
        return ok(row);
    };
    const port = {
        getInbox: vi.fn(
            async (_: { authority: NativePrivateMessageAuthority }): Promise<unknown> => ok([inboxEntry()]),
        ),
        getThread: vi.fn(
            async (_: { authority: NativePrivateMessageAuthority; peerAccountId: string }): Promise<unknown> =>
                ok(savedThread),
        ),
        sendText: vi.fn(
            async (request: {
                authority: NativePrivateMessageAuthority;
                peerAccountId: string;
                clientMessageId: string;
                text: string;
            }): Promise<unknown> =>
                commit(
                    message({
                        clientMessageId: request.clientMessageId,
                        text: request.text,
                    }),
                ),
        ),
        retryPending: vi.fn(
            async (request: {
                authority: NativePrivateMessageAuthority;
                peerAccountId: string;
                clientMessageId: string;
            }): Promise<unknown> =>
                commit(
                    message({
                        clientMessageId: request.clientMessageId,
                        text: null,
                        localCreatedAtMillis: null,
                    }),
                ),
        ),
        subscribe: vi.fn(
            async (
                _: { authority: NativePrivateMessageAuthority },
                callback: (event: NativePrivateMessageEvent) => void,
            ) => {
                receive = callback;
                return vi.fn<() => void>();
            },
        ),
        subscribeReadiness: vi.fn((callback: () => void) => {
            readinessChanged = callback;
            return vi.fn<() => void>();
        }),
        fenceSession: vi.fn(),
    };
    const controller = createPrivateMessageViewController({ port, nativeReadiness, createClientMessageId });
    cleanups.push(() => controller.close());
    return {
        controller,
        port,
        nativeReadiness,
        createClientMessageId,
        setThread: (value: NativePrivateMessageThread) => {
            savedThread = value;
        },
        emit: (event: unknown) => receive!(event as NativePrivateMessageEvent),
        emitReadiness: () => readinessChanged!(),
    };
}
function expectWiped(controller: ReturnType<typeof createPrivateMessageViewController>) {
    expect(controller.getSnapshot()).toMatchObject({
        authority: null,
        inbox: [],
        thread: null,
        draft: '',
        pendingAttemptId: null,
    });
}
function expectRedacted(controller: ReturnType<typeof createPrivateMessageViewController>) {
    const state = controller.getSnapshot();
    expect(state).toMatchObject({ phase: 'unavailable', inbox: [], thread: null });
    if (state.authority !== null) expect(state.authority).toEqual(auth);
}
afterEach(() => {
    for (const close of cleanups.splice(0)) close();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('pure explicit private-message view controller — mocked native boundary', () => {
    it('has no SDK, storage, network, timer or native operations on module import and controller creation', async () => {
        vi.resetModules();
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const storageRead = vi.spyOn(Storage.prototype, 'getItem');
        const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
        const interval = vi.spyOn(globalThis, 'setInterval');
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const module = await import('../experiments/scuttlebutt-e2ee/bridge-web/privateMessageView');
        const f = fixture();
        const isolated = module.createPrivateMessageViewController({
            port: f.port,
            nativeReadiness: f.nativeReadiness,
            createClientMessageId: f.createClientMessageId,
        });
        cleanups.push(() => isolated.close());
        expect(isolated.getSnapshot()).toMatchObject({ phase: 'closed', view: 'inbox', busy: false, authority: null });
        for (const callback of Object.values(f.port)) expect(callback).not.toHaveBeenCalled();
        expect(f.nativeReadiness).not.toHaveBeenCalled();
        expect(f.createClientMessageId).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(storageRead).not.toHaveBeenCalled();
        expect(storageWrite).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
    });
    it('loads only actual native inbox/thread data and keeps same client UUIDs separate by direction', async () => {
        const f = fixture();
        f.port.getThread.mockResolvedValue(ok(thread([message(), message({ direction: 'incoming', text: null })])));
        expect(await f.controller.start()).toBe(true);
        expect(f.port.getInbox).toHaveBeenCalledWith({ authority: auth });
        expect(await f.controller.open()).toBe(true);
        expect(f.port.getThread).toHaveBeenCalledWith({ authority: auth, peerAccountId: PEER });
        const state = f.controller.getSnapshot();
        expect(state.phase).toBe('ready');
        expect(state.view).toBe('thread');
        expect(state.thread?.messages.map((row) => row.id)).toEqual([`outgoing:${MESSAGE}`, `incoming:${MESSAGE}`]);
        expect(state.thread?.messages[1]).toMatchObject({
            senderName: 'Paired sailor',
            text: null,
            localCreatedAtMillis: null,
            read: false,
            delivery: 'received',
        });
        expect(f.createClientMessageId).not.toHaveBeenCalled();
    });
    it.each([
        { ...ready(), authority: { ...auth, serverVerified: false } },
        { ...ready(), authority: { ...auth, privateKey: 'forbidden synthetic claim' } },
        { ...ready(), authority: { ...auth, lifecycleVersion: `${VERSION}\n` } },
        { ...ready(), supportedContent: ['text', 'attachments'] },
    ])('refuses unsupported native readiness before requesting history (%j)', async (unsupported) => {
        const f = fixture();
        f.nativeReadiness.mockResolvedValue(unsupported);
        expect(await f.controller.start()).toBe(false);
        expectWiped(f.controller);
        expect(f.port.getInbox).not.toHaveBeenCalled();
        expect(f.port.getThread).not.toHaveBeenCalled();
    });
    it.each([
        { ...inboxEntry(), displayName: 'Invented profile name' },
        { ...inboxEntry(), unreadCount: 1 },
        { ...inboxEntry(), peerAccountId: OWNER },
        { ...inboxEntry(), historyAvailable: false, lastText: 'Unsupported preview' },
        { ...inboxEntry(), historyAvailable: false, lastLocalCreatedAtMillis: 1234 },
        { ...inboxEntry(), wire: 'unsupported extra envelope' },
    ])('refuses malformed inbox projections and exposes no caller-selected peer (%j)', async (unsupported) => {
        const f = fixture();
        f.port.getInbox.mockResolvedValue(ok([unsupported]));
        expect(await f.controller.start()).toBe(false);
        expectRedacted(f.controller);
        expect(await f.controller.open()).toBe(false);
        expect(f.port.getThread).not.toHaveBeenCalled();
    });
    it.each([
        thread([{ ...message({ direction: 'incoming' }), read: true } as never]),
        thread([{ ...message({ direction: 'incoming' }), localCreatedAtMillis: 1 }]),
        thread([{ ...message({ direction: 'incoming' }), senderName: 'Invented profile name' } as never]),
        thread([{ ...message({ direction: 'incoming' }), wire: 'unsupported extra envelope' } as never]),
        thread([message(), message()]),
        thread([message({ delivery: 'pending' })], { pendingAttemptId: null }),
        thread([message({ delivery: 'pending' }), message({ clientMessageId: NEXT_MESSAGE, delivery: 'pending' })]),
        thread([], { unresolvedCount: 17 }),
        thread([message({ delivery: 'rejected', reason: null })]),
        thread([], {
            permissions: {
                peerAccountId: PEER,
                blockedByMe: true,
                blockedEitherDirection: true,
                canSend: true,
                reason: null,
            },
        }),
        thread(
            Array.from({ length: 17 }, (_, index) =>
                message({ clientMessageId: `10000000-0000-4000-8000-${(index + 10).toString().padStart(12, '0')}` }),
            ),
        ),
        thread(
            Array.from({ length: 17 }, (_, index) =>
                message({
                    direction: 'incoming',
                    clientMessageId: `10000000-0000-4000-8000-${(index + 10).toString().padStart(12, '0')}`,
                }),
            ),
        ),
    ])('refuses strict thread/pending/capacity violations (%j)', async (unsupported) => {
        const f = fixture();
        expect(await f.controller.start()).toBe(true);
        f.port.getThread.mockResolvedValue(ok(unsupported));
        expect(await f.controller.open()).toBe(false);
        expectRedacted(f.controller);
        expect(f.port.sendText).not.toHaveBeenCalled();
        expect(f.createClientMessageId).not.toHaveBeenCalled();
    });
    it('does not expose a result with a wrong native authority echo or rejected transport diagnostics', async () => {
        const f = fixture();
        await f.controller.start();
        f.port.getThread.mockResolvedValueOnce({
            ...ok(thread([message()])),
            authority: { ...auth, lifecycleVersion: MESSAGE },
        });
        expect(await f.controller.open()).toBe(false);
        expectRedacted(f.controller);
        await f.controller.start();
        f.port.getThread.mockRejectedValueOnce(new Error('synthetic-secret-that-must-not-be-rendered'));
        expect(await f.controller.open()).toBe(false);
        expect(f.controller.getSnapshot().statusText).not.toContain('synthetic-secret-that-must-not-be-rendered');
        expectRedacted(f.controller);
    });
    it.each(['', '📍PIN|1|2|Berth', 'Hello\n🍳RECIPE:fixture', 'x'.repeat(4001)])(
        'never generates an ID or sends unsupported draft %j',
        async (draft) => {
            const f = fixture();
            await f.controller.start();
            await f.controller.open();
            await f.controller.setDraft(draft);
            expect(await f.controller.send()).toBe(false);
            expect(f.createClientMessageId).not.toHaveBeenCalled();
            expect(f.port.sendText).not.toHaveBeenCalled();
        },
    );
    it('reconciles native thread policy before ID generation and accepts only a committed matching send echo', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Actual attempted text');
        f.port.getThread.mockResolvedValueOnce(
            ok(
                thread([], {
                    permissions: {
                        peerAccountId: PEER,
                        blockedByMe: false,
                        blockedEitherDirection: false,
                        canSend: false,
                        reason: 'unavailable',
                    },
                }),
            ),
        );
        expect(await f.controller.send()).toBe(false);
        expect(f.createClientMessageId).not.toHaveBeenCalled();
        expect(f.port.sendText).not.toHaveBeenCalled();
        await f.controller.refresh();
        await f.controller.setDraft('Actual attempted text');
        f.port.sendText.mockResolvedValueOnce(ok(message({ clientMessageId: NEXT_MESSAGE, text: null })));
        expect(await f.controller.send()).toBe(false);
        expect(
            f.controller.getSnapshot().thread?.messages.some((row) => row.text === 'Actual attempted text'),
        ).not.toBe(true);
        expect(f.controller.getSnapshot().draft).toBe('Actual attempted text');
    });
    it('recovers lost preparation using the same original ID and text while keeping an edited draft separate', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Original attempted draft');
        f.port.sendText.mockResolvedValueOnce({ status: 'unavailable', reason: 'transport_failure' });
        expect(await f.controller.send()).toBe(false);
        expect(f.controller.getSnapshot().pendingAttemptId).toBe(NEXT_MESSAGE);
        expect(await f.controller.refresh()).toBe(true);
        await f.controller.setDraft('Edited draft stays separate');
        expect(await f.controller.send()).toBe(false);
        expect(await f.controller.retry()).toBe(true);
        expect(
            f.port.sendText.mock.calls.map(([request]) => ({
                clientMessageId: request.clientMessageId,
                text: request.text,
            })),
        ).toEqual([
            { clientMessageId: NEXT_MESSAGE, text: 'Original attempted draft' },
            { clientMessageId: NEXT_MESSAGE, text: 'Original attempted draft' },
        ]);
        expect(f.createClientMessageId).toHaveBeenCalledTimes(1);
        expect(f.port.retryPending).not.toHaveBeenCalled();
        expect(f.controller.getSnapshot()).toMatchObject({
            draft: 'Edited draft stays separate',
            pendingAttemptId: null,
        });
    });
    it('renders the post-commit native row rather than filling unavailable history from the submitted draft or send echo', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Native send echo is not a history fallback');
        f.port.sendText.mockImplementationOnce(async (request) => {
            f.setThread(
                thread([message({ clientMessageId: request.clientMessageId, text: null, localCreatedAtMillis: null })]),
            );
            return ok(message({ clientMessageId: request.clientMessageId, text: request.text }));
        });
        expect(await f.controller.send()).toBe(true);
        expect(f.controller.getSnapshot().thread?.messages[0]).toMatchObject({
            id: `outgoing:${NEXT_MESSAGE}`,
            text: null,
            localCreatedAtMillis: null,
            delivery: 'server_accepted',
            read: false,
        });
    });
    it.each(['missing', 'wrong ID'] as const)(
        'refuses a send whose committed echo has a %s post-operation native row',
        async (failure) => {
            const f = fixture();
            await f.controller.start();
            await f.controller.open();
            await f.controller.setDraft('Do not invent a committed row');
            f.port.sendText.mockImplementationOnce(async (request) => {
                f.setThread(thread(failure === 'missing' ? [] : [message({ text: request.text })]));
                return ok(message({ clientMessageId: request.clientMessageId, text: request.text }));
            });
            expect(await f.controller.send()).toBe(false);
            expect(
                f.controller.getSnapshot().thread?.messages.some((row) => row.clientMessageId === NEXT_MESSAGE),
            ).not.toBe(true);
            expect(f.createClientMessageId).toHaveBeenCalledTimes(1);
        },
    );
    it('recovers an actual native pending attempt by exact ID without plaintext, time or a replacement attempt', async () => {
        const f = fixture();
        const pending = message({ text: null, localCreatedAtMillis: null, delivery: 'pending' });
        f.setThread(thread([pending], { unresolvedCount: 1 }));
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Different draft');
        expect(await f.controller.send()).toBe(false);
        expect(await f.controller.retry()).toBe(true);
        expect(f.port.retryPending).toHaveBeenCalledExactlyOnceWith({
            authority: auth,
            peerAccountId: PEER,
            clientMessageId: MESSAGE,
        });
        expect(f.port.sendText).not.toHaveBeenCalled();
        expect(f.createClientMessageId).not.toHaveBeenCalled();
        expect(f.controller.getSnapshot()).toMatchObject({ draft: 'Different draft', pendingAttemptId: null });
        expect(f.controller.getSnapshot().thread?.messages[0]).toMatchObject({
            id: `outgoing:${MESSAGE}`,
            text: null,
            localCreatedAtMillis: null,
            delivery: 'server_accepted',
            read: false,
        });
    });
    it.each(['close', 'hidden', 'scopeChanged'] as const)(
        'wipes sensitive state synchronously on %s and refuses a late native projection',
        async (operation) => {
            const f = fixture();
            const pending = message({ delivery: 'pending' });
            f.setThread(thread([pending]));
            await f.controller.start();
            await f.controller.open();
            await f.controller.setDraft('Private draft before privacy fence');
            const held = deferred<unknown>();
            const entered = deferred<void>();
            f.port.getThread.mockImplementationOnce(() => {
                entered.resolve();
                return held.promise;
            });
            const refreshing = f.controller.refresh();
            await entered.promise;
            f.controller[operation]();
            expectWiped(f.controller);
            expect(f.controller.getSnapshot().phase).toBe(operation === 'scopeChanged' ? 'unavailable' : 'closed');
            held.resolve(ok(thread([pending])));
            expect(await refreshing).toBe(false);
            expectWiped(f.controller);
            expect(f.port.fenceSession).not.toHaveBeenCalled();
        },
    );
    it('keeps the one data-operation reservation across close until old native work settles', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        const held = deferred<unknown>();
        const entered = deferred<void>();
        f.port.getThread.mockImplementationOnce(() => {
            entered.resolve();
            return held.promise;
        });
        const oldRefresh = f.controller.refresh();
        await entered.promise;
        f.controller.close();
        const inboxCalls = f.port.getInbox.mock.calls.length;
        expect(await f.controller.start()).toBe(false);
        expect(f.port.getInbox).toHaveBeenCalledTimes(inboxCalls);
        expectWiped(f.controller);
        held.resolve(ok(thread([message()])));
        expect(await oldRefresh).toBe(false);
        expectWiped(f.controller);
        expect(await f.controller.start()).toBe(true);
        expect(f.port.getInbox).toHaveBeenCalledTimes(inboxCalls + 1);
    });
    it('coalesces draft edits behind one readiness check and ignores them after a hidden fence', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        const held = deferred<unknown>();
        f.nativeReadiness.mockClear();
        f.nativeReadiness.mockImplementationOnce(() => held.promise);
        const editing = Array.from({ length: 32 }, (_, index) => f.controller.setDraft(`Draft ${index}`));
        expect(f.nativeReadiness).toHaveBeenCalledTimes(1);
        held.resolve(ready());
        await Promise.all(editing);
        expect(f.controller.getSnapshot().draft).toBe('Draft 31');
        const late = deferred<unknown>();
        f.nativeReadiness.mockImplementationOnce(() => late.promise);
        const ignored = f.controller.setDraft('Draft that must never return');
        f.controller.hidden();
        expectWiped(f.controller);
        late.resolve(ready());
        expect(await ignored).toBe(false);
        expectWiped(f.controller);
    });
    it('fences the readiness-to-caller microtask gap without restoring closed plaintext', async () => {
        const f = fixture();
        f.setThread(thread([message()]));
        await f.controller.start();
        await f.controller.open();
        const held = deferred<unknown>();
        const entered = deferred<void>();
        f.nativeReadiness.mockImplementationOnce(() => {
            entered.resolve();
            return held.promise;
        });
        const refreshing = f.controller.refresh();
        await entered.promise;
        held.resolve(ready());
        queueMicrotask(() => f.controller.close());
        expect(await refreshing).toBe(false);
        expectWiped(f.controller);
        expect(f.controller.getSnapshot().phase).toBe('closed');
    });
    it('copies the native readiness descriptor before later awaits instead of retaining a mutable authority pointer', async () => {
        const f = fixture();
        const mutableReady = ready();
        f.nativeReadiness.mockResolvedValueOnce(mutableReady);
        const held = deferred<unknown>();
        const entered = deferred<void>();
        f.port.getInbox.mockImplementationOnce(() => {
            entered.resolve();
            return held.promise;
        });
        const starting = f.controller.start();
        await entered.promise;
        Object.assign(mutableReady.authority, { accountId: PEER, deviceId: MESSAGE, lifecycleVersion: MESSAGE });
        held.resolve(ok([inboxEntry()]));
        expect(await starting).toBe(true);
        expect(f.controller.getSnapshot().authority).toEqual(auth);
        expect(f.port.getInbox.mock.calls[0][0].authority).toEqual(auth);
    });
    it('refuses native plaintext when the actual descriptor changes during the asynchronous operation', async () => {
        const f = fixture();
        await f.controller.start();
        const held = deferred<unknown>();
        const entered = deferred<void>();
        f.port.getThread.mockImplementationOnce(() => {
            entered.resolve();
            return held.promise;
        });
        const opening = f.controller.open();
        await entered.promise;
        f.nativeReadiness.mockResolvedValue({ ...ready(), authority: { ...auth, lifecycleVersion: MESSAGE } });
        held.resolve(ok(thread([message({ text: 'Plaintext under an old native descriptor' })])));
        expect(await opening).toBe(false);
        expectWiped(f.controller);
        expect(f.port.sendText).not.toHaveBeenCalled();
        expect(f.createClientMessageId).not.toHaveBeenCalled();
    });
    it.each(['text', 'local milliseconds', 'unrepresentable raw milliseconds'] as const)(
        'remembers known %s through null and refuses same-ID conflicts',
        async (field) => {
            const f = fixture();
            const known = message(
                field === 'unrepresentable raw milliseconds' ? { localCreatedAtMillis: Number.MAX_SAFE_INTEGER } : {},
            );
            const unknown = { ...known, ...(field === 'text' ? { text: null } : { localCreatedAtMillis: null }) };
            const conflict = {
                ...known,
                ...(field === 'text'
                    ? { text: 'Conflicting native text' }
                    : { localCreatedAtMillis: field === 'local milliseconds' ? 1235 : Number.MAX_SAFE_INTEGER - 1 }),
            };
            f.setThread(thread([known]));
            await f.controller.start();
            await f.controller.open();
            f.setThread(thread([unknown]));
            expect(await f.controller.refresh()).toBe(true);
            expect(f.controller.getSnapshot().thread?.messages[0]).toMatchObject({
                text: unknown.text,
                localCreatedAtMillis: unknown.localCreatedAtMillis,
            });
            f.setThread(thread([conflict]));
            expect(await f.controller.refresh()).toBe(false);
            expectRedacted(f.controller);
        },
    );
    it('publishes independent state copies to subscribers and snapshot callers without an initial emit', async () => {
        const f = fixture();
        f.setThread(thread([message()]));
        const mutating = vi.fn((state: ReturnType<typeof f.controller.getSnapshot>) => {
            if (state.authority) Object.assign(state.authority, { accountId: PEER });
            if (state.inbox[0]) state.inbox[0].lastText = 'subscriber-mutated inbox';
            if (state.thread) {
                state.thread.messages[0].text = 'subscriber-mutated message';
                state.thread.permissions.canSend = false;
            }
        });
        const later = vi.fn();
        const stopFirst = f.controller.subscribe(mutating);
        const stopLater = f.controller.subscribe(later);
        expect(mutating).not.toHaveBeenCalled();
        expect(later).not.toHaveBeenCalled();
        expect(await f.controller.start()).toBe(true);
        expect(await f.controller.open()).toBe(true);
        const delivered = later.mock.calls
            .filter(([state]) => state.phase === 'ready' && state.thread !== null)
            .at(-1)?.[0];
        expect(delivered.authority).toEqual(auth);
        expect(delivered.inbox[0].lastText).toBeNull();
        expect(delivered.thread.messages[0].text).toBe('Native fixture text');
        expect(delivered.thread.permissions.canSend).toBe(true);
        const owned = f.controller.getSnapshot();
        Object.assign(owned.authority!, { lifecycleVersion: MESSAGE });
        owned.inbox[0].lastText = 'caller-mutated inbox';
        owned.thread!.messages[0].text = 'caller-mutated message';
        expect(f.controller.getSnapshot().authority).toEqual(auth);
        expect(f.controller.getSnapshot().thread?.messages[0].text).toBe('Native fixture text');
        expect(delivered.thread.messages[0].text).toBe('Native fixture text');
        stopFirst();
        stopLater();
    });
    it('stops later plaintext listeners and the operation result when the first state subscriber closes reentrantly', async () => {
        const f = fixture();
        f.setThread(thread([message()]));
        f.controller.subscribe((state) => {
            if (state.phase === 'ready' && state.thread?.messages.length) f.controller.close();
        });
        const later = vi.fn();
        f.controller.subscribe(later);
        await f.controller.start();
        expect(await f.controller.open()).toBe(false);
        expect(later.mock.calls.some(([state]) => state.phase === 'ready' && state.thread?.messages.length)).toBe(
            false,
        );
        expectWiped(f.controller);
    });
    it.each([
        { status: 'unavailable', reason: 'transport_failure' },
        { ...ok(message()), value: { ...message(), read: true } },
        { ...ok(message()), authority: { ...auth, lifecycleVersion: MESSAGE } },
        { ...ok(message()), wire: 'extra synthetic envelope' },
    ])('privacy-fences malformed/unavailable native events synchronously (%j)', async (event) => {
        const f = fixture();
        f.setThread(thread([message({ delivery: 'pending' })]));
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Private draft before event refusal');
        const reads = f.port.getThread.mock.calls.length;
        f.emit(event);
        expectWiped(f.controller);
        await flushMicrotasks();
        expect(f.port.getThread).toHaveBeenCalledTimes(reads);
        expect(f.port.fenceSession).not.toHaveBeenCalled();
    });
    it('privacy-fences readiness notifications without restarting native auth or work', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Private draft');
        const checks = f.nativeReadiness.mock.calls.length;
        const reads = f.port.getThread.mock.calls.length;
        f.emitReadiness();
        expectWiped(f.controller);
        await flushMicrotasks();
        expect(f.nativeReadiness).toHaveBeenCalledTimes(checks);
        expect(f.port.getThread).toHaveBeenCalledTimes(reads);
        expect(f.port.fenceSession).not.toHaveBeenCalled();
    });
    it('immediately closes a readiness registration handle returned after its synchronous callback fenced the view', async () => {
        const f = fixture();
        const stopped = vi.fn<() => void>();
        let staleReadiness!: () => void;
        f.port.subscribeReadiness.mockImplementationOnce((callback) => {
            staleReadiness = callback;
            callback();
            return stopped;
        });
        expect(await f.controller.start()).toBe(false);
        expectWiped(f.controller);
        expect(f.controller.getSnapshot().phase).toBe('unavailable');
        expect(stopped).toHaveBeenCalledTimes(1);
        expect(f.port.subscribe).not.toHaveBeenCalled();
        f.controller.close();
        expect(stopped).toHaveBeenCalledTimes(1);
        expect(await f.controller.start()).toBe(true);
        const checks = f.nativeReadiness.mock.calls.length;
        staleReadiness();
        await flushMicrotasks();
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'ready', authority: auth, inbox: [inboxEntry()] });
        expect(f.nativeReadiness).toHaveBeenCalledTimes(checks);
        expect(stopped).toHaveBeenCalledTimes(1);
    });
    it('coalesces native event refresh work and does not retain a refresh queued before close', async () => {
        const f = fixture();
        await f.controller.start();
        await f.controller.open();
        f.port.getThread.mockClear();
        const held = deferred<unknown>();
        const entered = deferred<void>();
        f.port.getThread.mockImplementationOnce(() => {
            entered.resolve();
            return held.promise;
        });
        for (let index = 0; index < 32; index += 1) f.emit(ok(message()));
        await entered.promise;
        expect(f.port.getThread).toHaveBeenCalledTimes(1);
        f.controller.close();
        held.resolve(ok(thread([message()])));
        await flushMicrotasks();
        expectWiped(f.controller);
        expect(f.port.getThread).toHaveBeenCalledTimes(1);
    });
    it('rejects a held pending snapshot after newer native acceptance and publishes one queued current refresh', async () => {
        const f = fixture();
        const pending = message({ delivery: 'pending' });
        const oldThread = thread([pending]);
        f.setThread(oldThread);
        await f.controller.start();
        await f.controller.open();
        expect(f.controller.getSnapshot().pendingAttemptId).toBe(MESSAGE);
        const observed = vi.fn();
        const stop = f.controller.subscribe(observed);
        f.port.getThread.mockClear();
        const held = deferred<unknown>();
        const entered = deferred<void>();
        f.port.getThread.mockImplementationOnce(() => {
            entered.resolve();
            return held.promise;
        });
        const oldRefresh = f.controller.refresh();
        await entered.promise;
        const accepted = { ...pending, delivery: 'server_accepted' as const };
        f.setThread(thread([accepted]));
        f.emit(ok(accepted));
        expect(f.port.getThread).toHaveBeenCalledTimes(1);
        held.resolve(ok(oldThread));
        expect(await oldRefresh).toBe(false);
        await flushMicrotasks();
        expect(observed.mock.calls.some(([state]) => state.phase === 'unavailable' && state.thread === null)).toBe(
            true,
        );
        expect(f.controller.getSnapshot()).toMatchObject({
            phase: 'ready',
            pendingAttemptId: null,
            thread: { pendingAttemptId: null, messages: [accepted] },
        });
        expect(f.port.getThread).toHaveBeenCalledTimes(2);
        expect(f.port.sendText).not.toHaveBeenCalled();
        expect(f.port.retryPending).not.toHaveBeenCalled();
        expect(f.createClientMessageId).not.toHaveBeenCalled();
        stop();
    });
    it('discovers a newly committed incoming reply through exactly one explicit native inbox scan before local thread reading', async () => {
        const f = fixture();
        const previous = message();
        f.setThread(thread([previous]));
        await f.controller.start();
        await f.controller.open();
        const scans = f.port.getInbox.mock.calls.length;
        const incoming = message({
            direction: 'incoming',
            text: 'Reply committed only by the explicit native inbox scan',
        });
        f.port.getInbox.mockImplementationOnce(async () => {
            f.setThread(thread([previous, incoming]));
            return ok([inboxEntry({ lastText: incoming.text })]);
        });
        expect(await f.controller.refresh()).toBe(true);
        expect(f.port.getInbox).toHaveBeenCalledTimes(scans + 1);
        expect(f.controller.getSnapshot().thread?.messages).toEqual([previous, incoming]);
        expect(f.controller.getSnapshot().phase).toBe('ready');
        expect(f.port.sendText).not.toHaveBeenCalled();
        expect(f.port.retryPending).not.toHaveBeenCalled();
        expect(f.createClientMessageId).not.toHaveBeenCalled();
    });
    it.each(['native refusal', 'throw'] as const)(
        'preserves currently authenticated local history after an explicit inbox scan %s',
        async (failure) => {
            const f = fixture();
            const local = message({ text: 'Readable current-owner local history' });
            f.setThread(thread([local]));
            await f.controller.start();
            await f.controller.open();
            await f.controller.setDraft('Same-owner private draft');
            const scans = f.port.getInbox.mock.calls.length;
            const reads = f.port.getThread.mock.calls.length;
            if (failure === 'throw')
                f.port.getInbox.mockRejectedValueOnce(new Error('synthetic-scan-diagnostics-must-not-render'));
            else f.port.getInbox.mockResolvedValueOnce({ status: 'unavailable', reason: 'transport_failure' });
            expect(await f.controller.refresh()).toBe(true);
            expect(f.port.getInbox).toHaveBeenCalledTimes(scans + 1);
            expect(f.port.getThread).toHaveBeenCalledTimes(reads + 1);
            expect(f.controller.getSnapshot()).toMatchObject({
                phase: 'ready',
                authority: auth,
                draft: 'Same-owner private draft',
                thread: { messages: [local] },
            });
            expect(f.controller.getSnapshot().statusText).toBe(
                'Local history shown. New replies could not be checked.',
            );
            expect(String(f.controller.getSnapshot().statusText)).not.toContain(
                'synthetic-scan-diagnostics-must-not-render',
            );
        },
    );
    it.each([
        ok([{ ...inboxEntry(), wire: 'malformed authoritative projection' }]),
        ok([inboxEntry({ peerAccountId: DEVICE })]),
        { ...ok([inboxEntry()]), authority: { ...auth, lifecycleVersion: MESSAGE } },
        ok([]),
        { status: 'unavailable', reason: 1 },
    ])(
        'refuses authoritative or malformed explicit scan output before further local thread reading (%j)',
        async (scan) => {
            const f = fixture();
            f.setThread(thread([message()]));
            await f.controller.start();
            await f.controller.open();
            const reads = f.port.getThread.mock.calls.length;
            f.port.getInbox.mockResolvedValueOnce(scan);
            expect(await f.controller.refresh()).toBe(false);
            expect(f.port.getThread).toHaveBeenCalledTimes(reads);
            expectRedacted(f.controller);
            expect(f.port.sendText).not.toHaveBeenCalled();
            expect(f.createClientMessageId).not.toHaveBeenCalled();
        },
    );
    it.each(['scopeChanged', 'hidden', 'native descriptor changed'] as const)(
        'does not read or restore the old thread after %s during a held explicit scan',
        async (boundary) => {
            const f = fixture();
            f.setThread(thread([message({ delivery: 'pending' })]));
            await f.controller.start();
            await f.controller.open();
            await f.controller.setDraft('Old-owner private draft');
            const held = deferred<unknown>();
            const entered = deferred<void>();
            const reads = f.port.getThread.mock.calls.length;
            f.port.getInbox.mockImplementationOnce(() => {
                entered.resolve();
                return held.promise;
            });
            const refreshing = f.controller.refresh();
            await entered.promise;
            if (boundary === 'native descriptor changed')
                f.nativeReadiness.mockResolvedValue({ ...ready(), authority: { ...auth, lifecycleVersion: MESSAGE } });
            else {
                f.controller[boundary]();
                expectWiped(f.controller);
            }
            held.resolve(ok([inboxEntry()]));
            expect(await refreshing).toBe(false);
            await flushMicrotasks();
            expectWiped(f.controller);
            expect(f.port.getThread).toHaveBeenCalledTimes(reads);
            expect(f.port.sendText).not.toHaveBeenCalled();
            expect(f.port.retryPending).not.toHaveBeenCalled();
            expect(f.createClientMessageId).not.toHaveBeenCalled();
        },
    );
    it('keeps event refreshes and send/retry reconciliation local-only without implicit inbox scans', async () => {
        const f = fixture();
        const previous = message();
        f.setThread(thread([previous]));
        await f.controller.start();
        await f.controller.open();
        const scans = f.port.getInbox.mock.calls.length;
        const incoming = message({ direction: 'incoming', text: 'Already committed native event reply' });
        f.setThread(thread([previous, incoming]));
        f.emit(ok(incoming));
        await flushMicrotasks();
        expect(f.controller.getSnapshot().thread?.messages).toEqual([previous, incoming]);
        expect(f.port.getInbox).toHaveBeenCalledTimes(scans);
        await f.controller.setDraft('Local guarded send');
        expect(await f.controller.send()).toBe(true);
        await flushMicrotasks();
        expect(f.port.getInbox).toHaveBeenCalledTimes(scans);
        const recovered = fixture();
        recovered.setThread(thread([message({ text: null, localCreatedAtMillis: null, delivery: 'pending' })]));
        await recovered.controller.start();
        await recovered.controller.open();
        const retryScans = recovered.port.getInbox.mock.calls.length;
        expect(await recovered.controller.retry()).toBe(true);
        await flushMicrotasks();
        expect(recovered.port.getInbox).toHaveBeenCalledTimes(retryScans);
        expect(recovered.port.retryPending).toHaveBeenCalledExactlyOnceWith({
            authority: auth,
            peerAccountId: PEER,
            clientMessageId: MESSAGE,
        });
    });
});

describe('mounted private-message DOM — fixture projection only', () => {
    function mounted(f: ReturnType<typeof fixture>) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const view = mountPrivateMessageView(container, f.controller);
        cleanups.push(() => view.destroy());
        return { container, view };
    }
    it('mounts closed with a review label, wipes an old view and waits for explicit start', async () => {
        const f = fixture();
        f.setThread(thread([message({ text: 'Previous private plaintext' })]));
        await f.controller.start();
        await f.controller.open();
        await f.controller.setDraft('Previous private draft');
        const checks = f.nativeReadiness.mock.calls.length;
        const reads = f.port.getThread.mock.calls.length;
        const { container } = mounted(f);
        expectWiped(f.controller);
        expect(getByText(container, 'Encryption test—not reviewed')).toBeTruthy();
        expect(container.textContent).not.toContain('Previous private plaintext');
        expect(container.textContent).not.toContain('Previous private draft');
        expect(f.nativeReadiness).toHaveBeenCalledTimes(checks);
        expect(f.port.getThread).toHaveBeenCalledTimes(reads);
        expect(f.port.fenceSession).not.toHaveBeenCalled();
    });
    it('renders literal, selectable native text and honest unknown metadata without parsing HTML or remote images', async () => {
        const f = fixture();
        const literal = '<img src="https://example.invalid/fixture.png" onerror="fixture()"> berth code B12';
        f.port.getInbox.mockResolvedValue(ok([inboxEntry({ lastText: literal })]));
        f.setThread(
            thread([
                message({ text: literal }),
                message({ direction: 'incoming', text: null }),
                message({ clientMessageId: NEXT_MESSAGE, text: null, localCreatedAtMillis: null, delivery: 'pending' }),
                message({
                    clientMessageId: DEVICE,
                    text: 'Rejected native text',
                    delivery: 'rejected',
                    reason: 'blocked',
                }),
            ]),
        );
        const { container } = mounted(f);
        await f.controller.start();
        fireEvent.click(getByRole(container, 'button', { name: 'Message Paired sailor' }));
        await flushMicrotasks();
        const paragraph = getByText(container, literal);
        expect(paragraph.tagName).toBe('P');
        expect(paragraph.classList.contains('select-text')).toBe(true);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe(literal);
        selection.removeAllRanges();
        expect(getAllByText(container, 'Message text unavailable').length).toBeGreaterThan(0);
        expect(getAllByText(container, 'Time unknown').length).toBeGreaterThan(0);
        expect(container.textContent).toContain('Relay accepted');
        expect(container.textContent).toContain('Pending native relay');
        expect(container.textContent).toContain('Rejected');
        expect(container.textContent).toContain('Read status unknown');
        expect(getByRole(container, 'button', { name: 'Retry pending message' })).toBeTruthy();
        expect(container.querySelectorAll('img,script,iframe,object,[onerror]').length).toBe(0);
    });
    it('connects the labelled draft/send controls to guarded native operations and closes synchronously', async () => {
        const f = fixture();
        const { container, view } = mounted(f);
        await f.controller.start();
        await f.controller.open();
        const input = getByRole(container, 'textbox', { name: 'Message Paired sailor' });
        fireEvent.input(input, { target: { value: 'A guarded native draft' } });
        await flushMicrotasks();
        fireEvent.click(getByRole(container, 'button', { name: 'Send direct message' }));
        await flushMicrotasks();
        expect(f.port.sendText).toHaveBeenCalledExactlyOnceWith({
            authority: auth,
            peerAccountId: PEER,
            clientMessageId: NEXT_MESSAGE,
            text: 'A guarded native draft',
        });
        expect(container.textContent).toContain('A guarded native draft');
        expect(container.textContent).toContain('Relay accepted');
        expect((getByRole(container, 'textbox', { name: 'Message Paired sailor' }) as HTMLTextAreaElement).value).toBe(
            '',
        );
        expect(getByRole(container, 'button', { name: 'Refresh private messages' })).toBeTruthy();
        fireEvent.click(getByRole(container, 'button', { name: 'Close private message test' }));
        expectWiped(f.controller);
        expect(container.textContent).not.toContain('A guarded native draft');
        expect(f.port.fenceSession).not.toHaveBeenCalled();
        view.destroy();
    });
    it('preserves the actual draft input, focus and caret while guarded typing updates publish under the same native authority', async () => {
        const f = fixture();
        const { container } = mounted(f);
        await f.controller.start();
        await f.controller.open();
        const input = getByRole(container, 'textbox', { name: 'Message Paired sailor' }) as HTMLInputElement;
        input.focus();
        fireEvent.input(input, { target: { value: 'Berth B12' } });
        input.setSelectionRange(6, 6);
        await flushMicrotasks();
        expect(getByRole(container, 'textbox', { name: 'Message Paired sailor' })).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('Berth B12');
        expect(input.selectionStart).toBe(6);
        expect(input.selectionEnd).toBe(6);
        fireEvent.input(input, { target: { value: 'Berth XB12' } });
        input.setSelectionRange(7, 7);
        await flushMicrotasks();
        expect(getByRole(container, 'textbox', { name: 'Message Paired sailor' })).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(7);
        expect(input.selectionEnd).toBe(7);
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'ready', authority: auth, draft: 'Berth XB12' });
    });
});
