/** These are hook and screen fixtures, not native crypto or live relay tests. */
import { act, cleanup, render, renderHook, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import {
    createPrivateMessagePilotRuntime,
    type NativePrivateMessageEvent,
    type NativePrivateMessageResult,
    type NativePrivateMessageAuthority,
    type NativePrivateMessageReadiness,
    type NativePrivateMessageInboxEntry,
    type NativePrivateMessageThread,
    type NativePrivateTextMessage,
    type PrivateMessageNativePort,
    type PrivateMessagePilotEvent,
    type PrivateMessagePilotResult,
    type PrivateMessagePilotRuntime,
    type PrivateMessagePilotMessage,
    type PrivateMessagePilotConversation,
    type PrivateMessagePilotThread,
} from '../../services/chat/e2ee/privateMessagePilot';

const legacy = vi.hoisted(() => ({
    status: vi.fn(),
    thread: vi.fn(),
    inbox: vi.fn(),
    send: vi.fn(),
    block: vi.fn(),
    unblock: vi.fn(),
    subscribe: vi.fn(),
    push: vi.fn(),
}));
vi.mock('../../services/ChatService', () => ({
    ChatService: {
        getDMBlockStatus: legacy.status,
        getDMThread: legacy.thread,
        getDMConversations: legacy.inbox,
        sendDM: legacy.send,
        blockUser: legacy.block,
        unblockUser: legacy.unblock,
        subscribeToDMs: legacy.subscribe,
    },
    parsePinDrop: vi.fn(),
}));
vi.mock('../../services/PushNotificationService', () => ({
    PushNotificationService: { requestPermissionAndRegister: legacy.push },
}));
vi.mock('../../services/GalleyRecipeService', () => ({ parseRecipeShareMessage: vi.fn() }));
vi.mock('../../components/chat/RecipeCard', () => ({ RecipeCard: () => null }));
vi.mock('../../components/Toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { useChatDMs } from '../../hooks/chat/useChatDMs';
import { ChatDMCompose, ChatDMInbox, ChatDMThread, PrivateMessagePilotNotice } from '../../components/chat/ChatDMView';

const account = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const fixtureId = '44444444-4444-4444-8444-444444444444';
const localCreatedAtMillis = 1790899200000;
const authority: NativePrivateMessageAuthority = {
    accountId: account,
    deviceId: '33333333-3333-4333-8333-333333333333',
    lifecycleVersion: 'fixture:epoch1',
    serverVerified: true,
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
const nativeInbox = (lastText: string | null = null): NativePrivateMessageInboxEntry[] => [
    {
        peerAccountId: peer,
        displayName: 'Paired sailor',
        lastText,
        lastLocalCreatedAtMillis: localCreatedAtMillis,
        unreadCount: 0,
        historyAvailable: true,
    },
];
const ok = <T,>(value: T): NativePrivateMessageResult<T> => ({ status: 'ok', authority, value });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function fixture() {
    const port = {
        readiness: vi.fn(async () => ({ status: 'ready' as const, authority, supportedContent: ['text'] as ['text'] })),
        getInbox: vi.fn(async () => ok(nativeInbox())),
        getThread: vi.fn(async () => ok(nativeThread())),
        sendText: vi.fn(async ({ clientMessageId, text }: { clientMessageId: string; text: string }) =>
            ok({
                id: `outgoing:${clientMessageId}` as const,
                clientMessageId,
                direction: 'outgoing' as const,
                senderAccountId: account,
                recipientAccountId: peer,
                senderName: 'You' as const,
                text,
                localCreatedAtMillis,
                read: false as const,
                delivery: 'server_accepted' as const,
                reason: null,
            }),
        ),
        retryPending: vi.fn(async ({ clientMessageId }: { clientMessageId: string }) =>
            ok({
                id: `outgoing:${clientMessageId}` as const,
                clientMessageId,
                direction: 'outgoing' as const,
                senderAccountId: account,
                recipientAccountId: peer,
                senderName: 'You' as const,
                text: null,
                localCreatedAtMillis: null,
                read: false as const,
                delivery: 'server_accepted' as const,
                reason: null,
            }),
        ),
        getBlockStatus: vi.fn(async () => ok(permissions)),
        setBlocked: vi.fn(async ({ blocked }: { blocked: boolean }) =>
            ok(
                blocked
                    ? {
                          peerAccountId: peer,
                          blockedByMe: true,
                          blockedEitherDirection: true,
                          canSend: false,
                          reason: 'unavailable' as const,
                      }
                    : permissions,
            ),
        ),
        subscribe: vi.fn(async (_request: unknown, _receive: (event: NativePrivateMessageEvent) => void) => vi.fn()),
    } satisfies PrivateMessageNativePort;
    const options = {
        setView: vi.fn(),
        setNavDirection: vi.fn(),
        setLoading: vi.fn(),
        privateMessageRuntime: createPrivateMessagePilotRuntime(port),
    };
    return { port, ...renderHook(() => useChatDMs(options)) };
}
const renderedMessage = (overrides: Partial<PrivateMessagePilotMessage> = {}): PrivateMessagePilotMessage => {
    const direction = overrides.direction ?? (overrides.sender_id === account ? 'outgoing' : 'incoming');
    const clientMessageId = overrides.clientMessageId ?? overrides.id?.split(':')[1] ?? fixtureId;
    return {
        kind: 'native-pilot',
        id: `${direction}:${clientMessageId}`,
        clientMessageId,
        direction,
        sender_id: direction === 'outgoing' ? account : peer,
        recipient_id: direction === 'outgoing' ? peer : account,
        sender_name: direction === 'outgoing' ? 'You' : 'Paired sailor',
        message: 'Incoming fixture',
        read: false,
        created_at: direction === 'outgoing' ? '2026-10-02T00:00:00.000Z' : null,
        localCreatedAtMillis: direction === 'outgoing' ? localCreatedAtMillis : null,
        delivery: direction === 'outgoing' ? 'server_accepted' : 'received',
        reason: null,
        ...overrides,
    };
};
const renderedInbox = (message: string | null = null): PrivateMessagePilotConversation[] => [
    {
        kind: 'native-pilot',
        user_id: peer,
        display_name: 'Paired sailor',
        last_message: message,
        last_at: '2026-10-02T00:00:00.000Z',
        unread_count: 0,
        historyAvailable: true,
    },
];
const renderedThread = (
    messages: PrivateMessagePilotMessage[] = [],
    overrides: Partial<PrivateMessagePilotThread> = {},
): PrivateMessagePilotThread => ({ messages, permissions, unresolvedCount: 0, pendingAttemptId: null, ...overrides });
const renderedOk = <T,>(value: T): PrivateMessagePilotResult<T> => ({ status: 'ok', value });
/** Already-validated runtime responses isolate the screen's own async fence. */
function renderingFixture() {
    let receive: ((event: PrivateMessagePilotEvent) => void) | undefined;
    const runtime = {
        kind: 'native-pilot' as const,
        getInbox: vi.fn(async (): ReturnType<PrivateMessagePilotRuntime['getInbox']> => renderedOk(renderedInbox())),
        getThread: vi.fn(async (): ReturnType<PrivateMessagePilotRuntime['getThread']> => renderedOk(renderedThread())),
        getBlockStatus: vi.fn(
            async (): ReturnType<PrivateMessagePilotRuntime['getBlockStatus']> => renderedOk(permissions),
        ),
        setBlocked: vi.fn(async (): ReturnType<PrivateMessagePilotRuntime['setBlocked']> => renderedOk(permissions)),
        sendText: vi.fn(
            async (
                ...args: Parameters<PrivateMessagePilotRuntime['sendText']>
            ): ReturnType<PrivateMessagePilotRuntime['sendText']> =>
                renderedOk(
                    renderedMessage({
                        id: `outgoing:${args[2]}`,
                        clientMessageId: args[2],
                        message: args[3],
                        sender_id: account,
                        recipient_id: peer,
                    }),
                ),
        ),
        retryPending: vi.fn(
            async (
                ...args: Parameters<PrivateMessagePilotRuntime['retryPending']>
            ): ReturnType<PrivateMessagePilotRuntime['retryPending']> =>
                renderedOk(
                    renderedMessage({
                        id: `outgoing:${args[2]}`,
                        clientMessageId: args[2],
                        direction: 'outgoing',
                        sender_id: account,
                        recipient_id: peer,
                        message: null,
                        created_at: null,
                        localCreatedAtMillis: null,
                    }),
                ),
        ),
        subscribe: vi.fn(
            (
                _scope: Parameters<PrivateMessagePilotRuntime['subscribe']>[0],
                listener: (event: PrivateMessagePilotEvent) => void,
            ) => {
                receive = listener;
                return vi.fn();
            },
        ),
    } satisfies PrivateMessagePilotRuntime;
    const options = { setView: vi.fn(), setNavDirection: vi.fn(), setLoading: vi.fn(), privateMessageRuntime: runtime };
    const hook = renderHook(({ runtime: supplied }) => useChatDMs({ ...options, privateMessageRuntime: supplied }), {
        initialProps: { runtime: runtime as PrivateMessagePilotRuntime },
    });
    act(() => {
        hook.result.current.subscribe();
    });
    return { ...hook, runtime, emit: (event: PrivateMessagePilotEvent) => receive!(event) };
}
function expectNoLegacyPath() {
    for (const callback of Object.values(legacy)) expect(callback).not.toHaveBeenCalled();
}
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope(account);
});
afterEach(cleanup);

describe('injected native-only PM hook fixtures', () => {
    it('routes inbox, thread, text send and subscription exclusively through the native port, with block controls unavailable', async () => {
        const { result, port } = fixture();
        let unsubscribe!: () => void;
        act(() => {
            unsubscribe = result.current.subscribe();
        });
        await act(async () => {
            await result.current.openDMInbox();
            await result.current.loadUnreadCount();
            await result.current.openDMThread(peer, 'Paired sailor');
        });
        act(() => result.current.setDmText('Fixture draft'));
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).toHaveBeenCalledTimes(1);
        expect(result.current.dmThread[0].message).toBe('Fixture draft');
        expect(result.current.dmText).toBe('');
        await act(async () => {
            await result.current.handleBlockUser();
            await result.current.handleUnblockUser();
        });
        expect(port.setBlocked).not.toHaveBeenCalled();
        unsubscribe();
        expectNoLegacyPath();
    });
    it('preserves a failed draft, blocks sending, and retries with the same message ID', async () => {
        const { result, port } = fixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        port.sendText.mockResolvedValueOnce({ status: 'unavailable', reason: 'transport_failure' } as never);
        act(() => result.current.setDmText('Keep fixture draft'));
        await act(async () => result.current.sendDMMessage());
        const firstId = port.sendText.mock.calls[0][0].clientMessageId;
        expect(result.current.pilotSendDisabled).toBe(true);
        expect(result.current.dmText).toBe('Keep fixture draft');
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.pilotPendingAttemptId).toBe(firstId);
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).toHaveBeenCalledTimes(1);
        await act(async () => result.current.retryBlockStatus());
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).toHaveBeenCalledTimes(1);
        await act(async () => result.current.retryPilotPendingMessage());
        expect(port.sendText.mock.calls[1][0].clientMessageId).toBe(firstId);
        expect(port.sendText.mock.calls[1][0].text).toBe('Keep fixture draft');
        expect(port.retryPending).not.toHaveBeenCalled();
        expectNoLegacyPath();
    });
    it('recovers the exact native pending ID after reopening even when its plaintext and time are unavailable', async () => {
        const { result, port } = fixture();
        const recovered: NativePrivateTextMessage = {
            id: `outgoing:${fixtureId}`,
            clientMessageId: fixtureId,
            direction: 'outgoing',
            senderAccountId: account,
            recipientAccountId: peer,
            senderName: 'You',
            text: null,
            localCreatedAtMillis: null,
            read: false,
            delivery: 'pending',
            reason: null,
        };
        port.getThread.mockResolvedValue(
            ok(nativeThread([recovered], { unresolvedCount: 1, pendingAttemptId: fixtureId })),
        );
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        expect(result.current.pilotPendingAttemptId).toBe(fixtureId);
        expect(result.current.dmThread[0].message).toBeNull();
        expect(result.current.dmThread[0].created_at).toBeNull();
        act(() => result.current.setDmText('A different new draft'));
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).not.toHaveBeenCalled();
        await act(async () => result.current.retryPilotPendingMessage());
        expect(port.retryPending).toHaveBeenCalledExactlyOnceWith({
            authority,
            peerAccountId: peer,
            clientMessageId: fixtureId,
        });
        expect(result.current.dmText).toBe('A different new draft');
        expect(result.current.dmThread[0]).toMatchObject({
            id: `outgoing:${fixtureId}`,
            message: null,
            created_at: null,
            delivery: 'server_accepted',
            read: false,
        });
        expect(result.current.pilotPendingAttemptId).toBeNull();
        expectNoLegacyPath();
    });
    it('reconciles native pending state before a new send and retries the pending ID rather than an earlier settled row', async () => {
        const { result, port } = fixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const pendingId = '55555555-5555-4555-8555-555555555555';
        const pendingMessage = (clientMessageId: string): NativePrivateTextMessage => ({
            id: `outgoing:${clientMessageId}`,
            clientMessageId,
            direction: 'outgoing',
            senderAccountId: account,
            recipientAccountId: peer,
            senderName: 'You',
            text: null,
            localCreatedAtMillis: null,
            read: false,
            delivery: 'pending',
            reason: null,
        });
        port.getThread.mockResolvedValue(
            ok(
                nativeThread(
                    [{ ...pendingMessage(fixtureId), delivery: 'server_accepted' }, pendingMessage(pendingId)],
                    {
                        unresolvedCount: 2,
                        pendingAttemptId: pendingId,
                    },
                ),
            ),
        );
        act(() => result.current.setDmText('Do not replace unresolved native work'));
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).not.toHaveBeenCalled();
        expect(result.current.pilotPendingAttemptId).toBe(pendingId);
        await act(async () => result.current.retryPilotPendingMessage());
        expect(port.retryPending.mock.calls[0][0].clientMessageId).toBe(pendingId);
        expect(port.sendText).not.toHaveBeenCalled();
        expect(result.current.dmText).toBe('Do not replace unresolved native work');
        expectNoLegacyPath();
    });
    it('retains the original local preparation ID across permission retry and sends its original text', async () => {
        const { result, port } = fixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        port.sendText.mockResolvedValueOnce({ status: 'unavailable', reason: 'transport_failure' } as never);
        act(() => result.current.setDmText('Original attempted draft'));
        await act(async () => result.current.sendDMMessage());
        const original = port.sendText.mock.calls[0][0];
        act(() => result.current.setDmText('Changed draft stays separate'));
        await act(async () => result.current.retryBlockStatus());
        expect(result.current.pilotPendingAttemptId).toBe(original.clientMessageId);
        await act(async () => result.current.retryPilotPendingMessage());
        expect(port.sendText.mock.calls[1][0]).toEqual(original);
        expect(result.current.dmText).toBe('Changed draft stays separate');
        expectNoLegacyPath();
    });
    it('never sends a structured share or a self message through a legacy path', async () => {
        const { result, port } = fixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('📍PIN|1|2|Fixture'));
        await act(async () => result.current.sendDMMessage());
        expect(result.current.pilotStatusText).toContain('text only');
        expect(port.sendText).not.toHaveBeenCalled();
        await act(async () => result.current.openDMThread(account, 'Self test'));
        expect(result.current.pilotStatusText).toContain('Self messages are unavailable');
        expect(port.getThread).toHaveBeenCalledTimes(1);
        expectNoLegacyPath();
    });
    it('drops a late thread result after an account switch', async () => {
        const { result, port } = fixture();
        const thread = deferred<Awaited<ReturnType<PrivateMessageNativePort['getThread']>>>();
        port.getThread.mockReturnValueOnce(thread.promise as never);
        let opening!: Promise<void>;
        act(() => {
            opening = result.current.openDMThread(peer, 'Paired sailor');
        });
        await vi.waitFor(() => expect(port.getThread).toHaveBeenCalledTimes(1));
        act(() => setAuthIdentityScope(peer));
        await act(async () => {
            thread.resolve(ok(nativeThread()));
            await opening;
        });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmPartner).toBeNull();
        expect(result.current.dmText).toBe('');
        expectNoLegacyPath();
    });
    it('cannot enable a changed peer from a late inbox response', async () => {
        const { result, port } = fixture();
        const inbox = deferred<Awaited<ReturnType<PrivateMessageNativePort['getInbox']>>>();
        port.getInbox.mockReturnValueOnce(inbox.promise as never);
        let opening!: Promise<void>;
        act(() => {
            opening = result.current.openDMInbox();
        });
        port.getThread.mockResolvedValueOnce({ status: 'unavailable', reason: 'peer_changed' } as never);
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        await act(async () => {
            inbox.resolve(ok([]));
            await opening;
        });
        expect(result.current.pilotStatusText).toContain('identity changed');
        expect(result.current.pilotSendDisabled).toBe(true);
        expectNoLegacyPath();
    });
    it('drops a late send after logout and prevents concurrent duplicate native sends', async () => {
        const { result, port } = fixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const pending = deferred<Awaited<ReturnType<PrivateMessageNativePort['sendText']>>>();
        port.sendText.mockReturnValueOnce(pending.promise as never);
        act(() => result.current.setDmText('Pending fixture text'));
        let sending!: Promise<void>;
        act(() => {
            sending = result.current.sendDMMessage();
        });
        await vi.waitFor(() => expect(port.sendText).toHaveBeenCalledTimes(1));
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).toHaveBeenCalledTimes(1);
        const request = port.sendText.mock.calls[0][0];
        act(() => setAuthIdentityScope(null));
        await act(async () => {
            pending.resolve(
                ok({
                    id: `outgoing:${request.clientMessageId}`,
                    clientMessageId: request.clientMessageId,
                    direction: 'outgoing',
                    senderAccountId: account,
                    recipientAccountId: peer,
                    senderName: 'You',
                    text: request.text,
                    localCreatedAtMillis,
                    read: false,
                    delivery: 'server_accepted',
                    reason: null,
                }),
            );
            await sending;
        });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmText).toBe('');
        expect(result.current.dmPartner).toBeNull();
        expectNoLegacyPath();
    });
    it('deduplicates native callbacks without inventing an unread count', async () => {
        const { result, port } = fixture();
        let receive!: (event: NativePrivateMessageEvent) => void;
        port.subscribe.mockImplementation(async (_request, callback) => {
            receive = callback;
            return vi.fn();
        });
        let unsubscribe!: () => void;
        await act(async () => {
            unsubscribe = result.current.subscribe();
        });
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const incoming: NativePrivateTextMessage = {
            id: `incoming:${fixtureId}`,
            clientMessageId: fixtureId,
            direction: 'incoming',
            senderAccountId: peer,
            recipientAccountId: account,
            senderName: 'Paired sailor',
            text: 'Incoming fixture',
            localCreatedAtMillis: null,
            read: false,
            delivery: 'received',
            reason: null,
        };
        await act(async () => {
            receive(ok(incoming));
            receive(ok(incoming));
        });
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.unreadDMs).toBe(0);
        unsubscribe();
        expectNoLegacyPath();
    });
    it('rebinds after native lease refresh without losing the view or draft, then receives a message', async () => {
        const { port, unmount } = fixture();
        unmount();
        let notifyReadiness!: () => void;
        let receive!: (event: NativePrivateMessageEvent) => void;
        let ready: NativePrivateMessageReadiness = { status: 'ready', authority, supportedContent: ['text'] };
        const changingPort: PrivateMessageNativePort = {
            ...port,
            readiness: async () => ready,
            subscribeReadiness: (listener) => {
                notifyReadiness = listener;
                return vi.fn();
            },
        };
        const runtime = createPrivateMessagePilotRuntime(changingPort);
        const options = {
            setView: vi.fn(),
            setNavDirection: vi.fn(),
            setLoading: vi.fn(),
            privateMessageRuntime: runtime,
        };
        const fresh = renderHook(() => useChatDMs(options));
        port.subscribe.mockImplementation(async (_request, callback) => {
            receive = callback;
            return vi.fn();
        });
        await act(async () => fresh.result.current.openDMThread(peer, 'Paired sailor'));
        act(() => fresh.result.current.setDmText('Draft across renewal'));
        let unsubscribe!: () => void;
        await act(async () => {
            unsubscribe = fresh.result.current.subscribe();
        });
        await vi.waitFor(() => expect(port.subscribe).toHaveBeenCalledTimes(1));
        await act(async () => {
            ready = { status: 'unavailable', reason: 'unavailable' };
            notifyReadiness();
        });
        expect(fresh.result.current.pilotSendDisabled).toBe(true);
        const renewedAuthority = { ...authority, lifecycleVersion: 'fixture:epoch2' };
        port.getThread.mockImplementation(async () => ({
            status: 'ok',
            authority: renewedAuthority,
            value: nativeThread(),
        }));
        port.getInbox.mockImplementation(async () => ({
            status: 'ok',
            authority: renewedAuthority,
            value: nativeInbox(),
        }));
        await act(async () => {
            ready = { status: 'ready', authority: renewedAuthority, supportedContent: ['text'] };
            notifyReadiness();
        });
        await vi.waitFor(() => expect(port.subscribe).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(fresh.result.current.pilotSendDisabled).toBe(false));
        expect(fresh.result.current.dmText).toBe('Draft across renewal');
        expect(fresh.result.current.dmPartner?.id).toBe(peer);
        const incoming: NativePrivateTextMessage = {
            id: 'incoming:55555555-5555-4555-8555-555555555555',
            clientMessageId: '55555555-5555-4555-8555-555555555555',
            direction: 'incoming',
            senderAccountId: peer,
            recipientAccountId: account,
            senderName: 'Paired sailor',
            text: 'After renewal',
            localCreatedAtMillis: null,
            read: false,
            delivery: 'received',
            reason: null,
        };
        await act(async () => receive({ status: 'ok', authority: renewedAuthority, value: incoming }));
        expect(fresh.result.current.dmThread[0].message).toBe('After renewal');
        unsubscribe();
        fresh.unmount();
        expectNoLegacyPath();
    });
});

describe('pilot rendering lease and native snapshot races — runtime fixtures only', () => {
    it('blocks a send synchronously when readiness closes, before React commits new failure state', async () => {
        const { result, runtime, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Do not dispatch while checking'));
        await act(async () => {
            emit({ status: 'unavailable', reason: 'unavailable' });
            await result.current.sendDMMessage();
        });
        expect(runtime.sendText).not.toHaveBeenCalled();
        expect(result.current.dmText).toBe('Do not dispatch while checking');
        expect(result.current.pilotSendDisabled).toBe(true);
        expectNoLegacyPath();
    });
    it('does not invoke unavailable pilot block or unblock controls or alter the draft', async () => {
        const { result, runtime } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => {
            result.current.setDmText('Draft across peer control');
        });
        await act(async () => {
            await result.current.handleBlockUser();
            await result.current.handleUnblockUser();
        });
        expect(result.current.showBlockConfirm).toBe(false);
        expect(result.current.blockedByMe).toBe(false);
        expect(runtime.setBlocked).not.toHaveBeenCalled();
        expect(result.current.pilotSendDisabled).toBe(false);
        expect(result.current.blockMutationPending).toBe(false);
        expect(result.current.dmText).toBe('Draft across peer control');
        expectNoLegacyPath();
    });
    it.each(['ready read', 'open thread', 'inbox', 'unread', 'permissions', 'send', 'control'] as const)(
        'does not restore old rendering or send authority from a late %s after checking',
        async (operation) => {
            const { result, runtime, emit } = renderingFixture();
            await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
            act(() => result.current.setDmText('Keep same-owner draft'));
            let completion: Promise<void> | undefined;
            let resolve!: () => void;
            act(() => {
                if (operation === 'ready read' || operation === 'open thread') {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
                    runtime.getThread.mockReturnValueOnce(pending.promise);
                    resolve = () =>
                        pending.resolve(renderedOk(renderedThread([renderedMessage({ message: 'Old plaintext' })])));
                    if (operation === 'ready read') emit({ status: 'ready' });
                    else completion = result.current.openDMThread(peer, 'Paired sailor');
                } else if (operation === 'inbox' || operation === 'unread') {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getInbox']>>>();
                    runtime.getInbox.mockReturnValueOnce(pending.promise);
                    resolve = () => pending.resolve(renderedOk(renderedInbox('Old inbox plaintext')));
                    completion =
                        operation === 'inbox' ? result.current.openDMInbox() : result.current.loadUnreadCount();
                } else if (operation === 'permissions' || operation === 'control') {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
                    resolve = () => pending.resolve(renderedOk(renderedThread()));
                    if (operation === 'permissions') {
                        runtime.getThread.mockReturnValueOnce(pending.promise);
                        completion = result.current.retryBlockStatus();
                    } else {
                        completion = result.current.handleUnblockUser();
                    }
                } else {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['sendText']>>>();
                    runtime.sendText.mockReturnValueOnce(pending.promise);
                    resolve = () =>
                        pending.resolve(
                            renderedOk(
                                renderedMessage({
                                    id: `outgoing:${runtime.sendText.mock.calls[0][2]}`,
                                    clientMessageId: runtime.sendText.mock.calls[0][2],
                                    sender_id: account,
                                    recipient_id: peer,
                                    message: 'Keep same-owner draft',
                                }),
                            ),
                        );
                    completion = result.current.sendDMMessage();
                }
                // Opening a new thread deliberately resets a draft; native
                // lease renewal must not erase a draft already in that view.
                result.current.setDmText('Keep same-owner draft');
                if (operation !== 'send') emit({ status: 'unavailable', reason: 'unavailable' });
            });
            if (operation === 'send') {
                await vi.waitFor(() => expect(runtime.sendText).toHaveBeenCalledTimes(1));
                act(() => emit({ status: 'unavailable', reason: 'unavailable' }));
            }
            expect(result.current.pilotSendDisabled).toBe(true);
            await act(async () => {
                resolve();
                await completion;
                for (let index = 0; index < 10; index += 1) await Promise.resolve();
            });
            expect(result.current.dmThread).toEqual([]);
            expect(result.current.dmConversations).toEqual([]);
            expect(result.current.unreadDMs).toBe(0);
            expect(result.current.dmText).toBe('Keep same-owner draft');
            expect(result.current.pilotSendDisabled).toBe(true);
            expect(result.current.blockMutationPending).toBe(false);
            expect(result.current.blockStatusLoading).toBe(false);
            expect(runtime.setBlocked).not.toHaveBeenCalled();
            expectNoLegacyPath();
        },
    );
    it('merges a message received after a renewed thread snapshot started, without doubling native unread', async () => {
        const { result, runtime, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Draft across renewal'));
        const snapshot = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
        runtime.getThread.mockReturnValueOnce(snapshot.promise);
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Incoming fixture')));
        act(() => emit({ status: 'ready' }));
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmThread).toHaveLength(1);
        await act(async () => snapshot.resolve(renderedOk(renderedThread())));
        expect(result.current.dmThread.map((message) => message.message)).toEqual(['Incoming fixture']);
        expect(result.current.unreadDMs).toBe(0);
        expect(result.current.dmText).toBe('Draft across renewal');
        expect(result.current.pilotSendDisabled).toBe(false);
        const inboxReads = runtime.getInbox.mock.calls.length;
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.unreadDMs).toBe(0);
        expect(runtime.getInbox).toHaveBeenCalledTimes(inboxReads);
        expectNoLegacyPath();
    });
    it('never replaces a later event-derived native inbox with an older pending snapshot', async () => {
        const { result, runtime, emit } = renderingFixture();
        const snapshot = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getInbox']>>>();
        runtime.getInbox.mockReturnValueOnce(snapshot.promise);
        act(() => emit({ status: 'ready' }));
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Incoming fixture')));
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmConversations[0].last_message).toBe('Incoming fixture');
        await act(async () => snapshot.resolve(renderedOk(renderedInbox())));
        expect(result.current.dmConversations[0].last_message).toBe('Incoming fixture');
        expect(result.current.unreadDMs).toBe(0);
        expectNoLegacyPath();
    });
    it('preserves newer native relay acceptance when an older pending send snapshot resolves', async () => {
        const { result, runtime, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Outbound fixture'));
        const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['sendText']>>>();
        runtime.sendText.mockReturnValueOnce(pending.promise);
        let sending!: Promise<void>;
        act(() => {
            sending = result.current.sendDMMessage();
        });
        await vi.waitFor(() => expect(runtime.sendText).toHaveBeenCalledTimes(1));
        const message = renderedMessage({
            id: `outgoing:${runtime.sendText.mock.calls[0][2]}`,
            clientMessageId: runtime.sendText.mock.calls[0][2],
            sender_id: account,
            recipient_id: peer,
            message: 'Outbound fixture',
        });
        await act(async () => emit(renderedOk(message)));
        await act(async () => {
            pending.resolve(renderedOk({ ...message, delivery: 'pending' }));
            await sending;
        });
        expect(result.current.dmThread).toEqual([message]);
        expect(result.current.dmText).toBe('');
        expectNoLegacyPath();
    });
    it('clears runtime A plaintext and draft and requires runtime B permissions before sending', async () => {
        const { result, runtime, rerender, emit } = renderingFixture();
        runtime.getThread.mockResolvedValueOnce(renderedOk(renderedThread([renderedMessage()])));
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Runtime A private preview')));
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Runtime A private draft'));
        const staleSend = result.current.sendDMMessage;
        const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
        const replacement: PrivateMessagePilotRuntime = {
            ...runtime,
            getThread: vi.fn(() => pending.promise),
            getInbox: vi.fn(async () => renderedOk(renderedInbox())),
            sendText: vi.fn(async () => renderedOk(renderedMessage())),
        };
        rerender({ runtime: replacement });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmConversations).toEqual([]);
        expect(result.current.dmText).toBe('');
        expect(result.current.dmPartner).toBeNull();
        expect(result.current.pilotSendDisabled).toBe(true);
        await act(async () => {
            await staleSend();
            emit(renderedOk(renderedMessage()));
        });
        expect(runtime.sendText).not.toHaveBeenCalled();
        expect(result.current.dmThread).toEqual([]);
        let opening!: Promise<void>;
        act(() => {
            opening = result.current.openDMThread(peer, 'Paired sailor');
        });
        act(() => result.current.setDmText('New runtime B draft'));
        await act(async () => result.current.sendDMMessage());
        expect(replacement.sendText).not.toHaveBeenCalled();
        await act(async () => {
            pending.resolve(renderedOk(renderedThread()));
            await opening;
        });
        expect(result.current.pilotSendDisabled).toBe(false);
        expect(result.current.dmText).toBe('New runtime B draft');
        expectNoLegacyPath();
    });
    it('never downgrades relay acceptance or fabricates reading, even if pending arrives later', async () => {
        const { result, emit, runtime } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const message = renderedMessage({ sender_id: account, recipient_id: peer });
        await act(async () => emit(renderedOk(message)));
        const reads = runtime.getInbox.mock.calls.length;
        await act(async () => emit(renderedOk({ ...message, delivery: 'pending' })));
        expect(result.current.dmThread).toEqual([message]);
        expect(result.current.dmThread[0].read).toBe(false);
        expect(runtime.getInbox).toHaveBeenCalledTimes(reads);
        expectNoLegacyPath();
    });
    it.each(['readiness refresh', 'permission retry', 'same-peer reopen', 'pending retry'] as const)(
        'does not restore a settled attempt from an older pending %s snapshot',
        async (operation) => {
            const { result, runtime, emit } = renderingFixture();
            const pending = renderedMessage({
                sender_id: account,
                recipient_id: peer,
                message: 'Native pending fixture',
                delivery: 'pending',
            });
            const oldThread = renderedThread([pending], { pendingAttemptId: fixtureId });
            runtime.getThread.mockResolvedValueOnce(renderedOk(oldThread));
            await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
            expect(result.current.pilotPendingAttemptId).toBe(fixtureId);
            const snapshot = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
            runtime.getThread.mockReturnValueOnce(snapshot.promise);
            let completion: Promise<void> | undefined;
            act(() => {
                if (operation === 'readiness refresh') emit({ status: 'ready' });
                else if (operation === 'permission retry') completion = result.current.retryBlockStatus();
                else if (operation === 'same-peer reopen')
                    completion = result.current.openDMThread(peer, 'Paired sailor');
                else completion = result.current.retryPilotPendingMessage();
            });
            await act(async () => emit(renderedOk({ ...pending, delivery: 'server_accepted' })));
            expect(result.current.pilotPendingAttemptId).toBeNull();
            await act(async () => {
                snapshot.resolve(renderedOk(oldThread));
                await completion;
                for (let index = 0; index < 10; index += 1) await Promise.resolve();
            });
            expect(result.current.dmThread).toHaveLength(1);
            expect(result.current.dmThread[0]).toMatchObject({
                id: `outgoing:${fixtureId}`,
                delivery: 'server_accepted',
            });
            expect(result.current.pilotPendingAttemptId).toBeNull();
            expect(result.current.pilotSendDisabled).toBe(false);
            expect(runtime.sendText).not.toHaveBeenCalled();
            expect(runtime.retryPending).not.toHaveBeenCalled();
            expectNoLegacyPath();
        },
    );
    it.each(['text', 'local timestamp', 'raw timestamp outside the Date range'] as const)(
        'remembers known native %s through an unknown rendering update and closes conflicting content',
        async (field) => {
            const { result, emit } = renderingFixture();
            await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
            const known = renderedMessage({
                sender_id: account,
                recipient_id: peer,
                message: 'Original native plaintext',
                ...(field === 'raw timestamp outside the Date range'
                    ? { created_at: null, localCreatedAtMillis: Number.MAX_SAFE_INTEGER }
                    : {}),
            });
            const unknown = {
                ...known,
                ...(field === 'text' ? { message: null } : { created_at: null, localCreatedAtMillis: null }),
            };
            const conflict = {
                ...known,
                ...(field === 'text'
                    ? { message: 'Conflicting native plaintext' }
                    : field === 'local timestamp'
                      ? { created_at: '2026-10-02T00:00:01.000Z', localCreatedAtMillis: localCreatedAtMillis + 1000 }
                      : { localCreatedAtMillis: Number.MAX_SAFE_INTEGER - 1 }),
            };
            await act(async () => emit(renderedOk(known)));
            await act(async () => emit(renderedOk(unknown)));
            expect(result.current.dmThread).toHaveLength(1);
            expect(result.current.dmThread[0]).toMatchObject({
                message: unknown.message,
                created_at: unknown.created_at,
                localCreatedAtMillis: unknown.localCreatedAtMillis,
            });
            await act(async () => emit(renderedOk(conflict)));
            expect(result.current.dmThread).toEqual([]);
            expect(result.current.pilotSendDisabled).toBe(true);
            expect(result.current.pilotStatusText).toContain('unavailable');
            expectNoLegacyPath();
        },
    );
    it('keeps opposite-direction messages with the same client UUID as separate rendered records', async () => {
        const { result, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const incoming = renderedMessage();
        const outgoing = renderedMessage({ sender_id: account, recipient_id: peer, message: 'Outgoing fixture' });
        await act(async () => {
            emit(renderedOk(incoming));
            emit(renderedOk(outgoing));
        });
        expect(result.current.dmThread.map((message) => message.id)).toEqual([
            `incoming:${fixtureId}`,
            `outgoing:${fixtureId}`,
        ]);
        expect(result.current.dmThread.map((message) => message.message)).toEqual([
            'Incoming fixture',
            'Outgoing fixture',
        ]);
        expect(result.current.unreadDMs).toBe(0);
        expect(result.current.pilotSendDisabled).toBe(false);
        expectNoLegacyPath();
    });
    it('deduplicates an event already present in a snapshot instead of incrementing unread', async () => {
        const { result, runtime, emit } = renderingFixture();
        runtime.getThread.mockResolvedValueOnce(renderedOk(renderedThread([renderedMessage()])));
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Incoming fixture')));
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const inboxReads = runtime.getInbox.mock.calls.length;
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.unreadDMs).toBe(0);
        expect(runtime.getInbox).toHaveBeenCalledTimes(inboxReads);
        expectNoLegacyPath();
    });
    it('fails closed on conflicting message IDs and bounds retained event plaintext to 32 messages', async () => {
        const { result, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Preserve bounded draft'));
        await act(async () => emit(renderedOk(renderedMessage())));
        act(() => emit(renderedOk(renderedMessage({ message: 'Conflicting fixture payload' }))));
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.pilotSendDisabled).toBe(true);
        await act(async () => emit({ status: 'ready' }));
        act(() => {
            for (let index = 0; index < 33; index += 1) {
                emit(
                    renderedOk(
                        renderedMessage({
                            id: `incoming:44444444-4444-4444-8444-${index.toString().padStart(12, '0')}`,
                        }),
                    ),
                );
            }
        });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmConversations).toEqual([]);
        expect(result.current.pilotSendDisabled).toBe(true);
        expect(result.current.pilotStatusText).toContain('store is full');
        expect(result.current.dmText).toBe('Preserve bounded draft');
        expectNoLegacyPath();
    });
});

describe('pilot screen rendering fixtures', () => {
    it('uses an unmistakable review warning and hides the legacy self test', () => {
        render(
            <>
                <PrivateMessagePilotNotice />
                <ChatDMInbox conversations={[]} onOpenThread={vi.fn()} currentUserId={account} pilotActive />
            </>,
        );
        expect(screen.getByText('Encryption test—not reviewed')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Open self-test conversation' })).toBeNull();
    });
    it('renders structured-looking fixture data as text without remote recipe/photo rendering', () => {
        render(
            <ChatDMThread
                thread={[renderedMessage({ message: '🍳RECIPE:fixture' })]}
                pilotActive
                currentUserId={account}
            />,
        );
        expect(screen.getByText('🍳RECIPE:fixture')).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();
    });
    it('renders missing native text and time explicitly and keeps recipient read status unknown', () => {
        render(
            <ChatDMThread
                thread={[renderedMessage({ message: null, created_at: null, localCreatedAtMillis: null })]}
                pilotActive
                currentUserId={account}
            />,
        );
        expect(screen.getByText('Message text unavailable')).toBeTruthy();
        expect(screen.getByText('Time unknown')).toBeTruthy();
        expect(screen.getByText('· Received · Read status unknown')).toBeTruthy();
        expect(screen.queryByText('· Relay accepted')).toBeNull();
    });
    it('renders unavailable native inbox history without inventing a preview, timestamp or unread badge', () => {
        render(
            <ChatDMInbox
                conversations={[
                    {
                        ...renderedInbox()[0],
                        last_message: null,
                        last_at: null,
                        historyAvailable: false,
                    },
                ]}
                onOpenThread={vi.fn()}
                currentUserId={account}
                pilotActive
            />,
        );
        expect(screen.getByText('Native history unavailable')).toBeTruthy();
        expect(screen.getByText('Time unknown')).toBeTruthy();
        expect(screen.getByRole('listitem').getAttribute('aria-label')).toBe('Message Paired sailor');
        expect(screen.queryByText(/\d+ unread/)).toBeNull();
    });
    it('makes the actual pilot message paragraph selectable for copying berth codes', () => {
        render(
            <ChatDMThread
                thread={[renderedMessage({ message: 'Berth B12 · access code 6842' })]}
                pilotActive
                currentUserId={account}
            />,
        );
        const paragraph = screen.getByText('Berth B12 · access code 6842');
        expect(paragraph.tagName).toBe('P');
        expect(paragraph.classList.contains('select-text')).toBe(true);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe('Berth B12 · access code 6842');
        selection.removeAllRanges();
    });
    it('hides pilot block and unblock controls even when legacy confirmation state is supplied', () => {
        const block = vi.fn();
        const unblock = vi.fn();
        render(
            <ChatDMCompose
                dmText="Fixture"
                setDmText={vi.fn()}
                partnerName="Paired sailor"
                keyboardOffset={0}
                isUserBlocked={false}
                blockedByMe={false}
                blockStatusLoading={false}
                blockStatusError={null}
                blockMutationPending={false}
                onRetryBlockStatus={vi.fn()}
                showBlockConfirm
                setShowBlockConfirm={vi.fn()}
                onSendDM={vi.fn()}
                onBlock={block}
                onUnblock={unblock}
                pilotActive
            />,
        );
        expect(screen.queryByRole('button', { name: /block|unblock/i })).toBeNull();
        expect(screen.queryByText(/Block Paired sailor\?/)).toBeNull();
        expect(block).not.toHaveBeenCalled();
        expect(unblock).not.toHaveBeenCalled();
    });
    it('blocks both button and Enter while native capability is unavailable', () => {
        const send = vi.fn();
        render(
            <ChatDMCompose
                dmText="Fixture"
                setDmText={vi.fn()}
                partnerName="Peer"
                keyboardOffset={0}
                isUserBlocked={false}
                blockedByMe={false}
                blockStatusLoading={false}
                blockStatusError={null}
                blockMutationPending={false}
                onRetryBlockStatus={vi.fn()}
                showBlockConfirm={false}
                setShowBlockConfirm={vi.fn()}
                onSendDM={send}
                onBlock={vi.fn()}
                onUnblock={vi.fn()}
                pilotActive
                pilotSendDisabled
            />,
        );
        const button = screen.getByRole('button', { name: 'Send direct message' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
        expect(send).not.toHaveBeenCalled();
    });
});
