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
    type NativePrivateTextMessage,
    type PrivateMessageNativePort,
    type PrivateMessagePilotEvent,
    type PrivateMessagePilotResult,
    type PrivateMessagePilotRuntime,
} from '../../services/chat/e2ee/privateMessagePilot';
import type { DirectMessage, DMConversation } from '../../services/ChatService';

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
const authority: NativePrivateMessageAuthority = {
    accountId: account,
    deviceId: '33333333-3333-4333-8333-333333333333',
    lifecycleVersion: 'fixture:epoch1',
    serverVerified: true,
};
const permissions = { peerAccountId: peer, blockedByMe: false, blockedEitherDirection: false, canSend: true };
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
        getInbox: vi.fn(async () =>
            ok([
                {
                    user_id: peer,
                    display_name: 'Paired sailor',
                    last_message: '',
                    last_at: '2026-10-02T00:00:00.000Z',
                    unread_count: 1,
                },
            ]),
        ),
        getThread: vi.fn(async () => ok({ messages: [] as NativePrivateTextMessage[], ...permissions })),
        sendText: vi.fn(async ({ clientMessageId, text }: { clientMessageId: string; text: string }) =>
            ok({
                id: clientMessageId,
                senderAccountId: account,
                recipientAccountId: peer,
                senderName: 'You',
                text,
                createdAt: '2026-10-02T00:00:00.000Z',
                read: true,
                delivery: 'server_accepted' as const,
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
                          reason: 'blocked' as const,
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
const renderedMessage = (overrides: Partial<DirectMessage> = {}): DirectMessage => ({
    id: '44444444-4444-4444-8444-444444444444',
    sender_id: peer,
    recipient_id: account,
    sender_name: 'Peer',
    message: 'Incoming fixture',
    read: false,
    created_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
});
const renderedInbox = (message = '', unread = 0): DMConversation[] => [
    {
        user_id: peer,
        display_name: 'Paired sailor',
        last_message: message,
        last_at: '2026-10-02T00:00:00.000Z',
        unread_count: unread,
    },
];
const renderedOk = <T,>(value: T): PrivateMessagePilotResult<T> => ({ status: 'ok', value });
/** Already-validated runtime responses isolate the screen's own async fence. */
function renderingFixture() {
    let receive: ((event: PrivateMessagePilotEvent) => void) | undefined;
    const runtime = {
        kind: 'native-pilot' as const,
        getInbox: vi.fn(async (): ReturnType<PrivateMessagePilotRuntime['getInbox']> => renderedOk(renderedInbox())),
        getThread: vi.fn(
            async (): ReturnType<PrivateMessagePilotRuntime['getThread']> => renderedOk({ messages: [], permissions }),
        ),
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
                        id: args[2],
                        message: args[3],
                        sender_id: account,
                        recipient_id: peer,
                        read: true,
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
    it('routes inbox, thread, text send, block and subscription exclusively through the native port', async () => {
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
        expect(port.setBlocked).toHaveBeenCalledTimes(2);
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
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText).toHaveBeenCalledTimes(1);
        await act(async () => result.current.retryBlockStatus());
        await act(async () => result.current.sendDMMessage());
        expect(port.sendText.mock.calls[1][0].clientMessageId).toBe(firstId);
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
            thread.resolve(ok({ messages: [], ...permissions }));
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
        port.getThread.mockResolvedValueOnce(
            ok({ messages: [], ...permissions, canSend: false, reason: 'peer_changed' }) as never,
        );
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
                    id: request.clientMessageId,
                    senderAccountId: account,
                    recipientAccountId: peer,
                    senderName: 'You',
                    text: request.text,
                    createdAt: '2026-10-02T00:00:00.000Z',
                    read: true,
                    delivery: 'server_accepted',
                }),
            );
            await sending;
        });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmText).toBe('');
        expect(result.current.dmPartner).toBeNull();
        expectNoLegacyPath();
    });
    it('counts one unread message for duplicate native callbacks with the same ID', async () => {
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
            id: '44444444-4444-4444-8444-444444444444',
            senderAccountId: peer,
            recipientAccountId: account,
            senderName: 'Peer',
            text: 'Incoming fixture',
            createdAt: '2026-10-02T00:00:00.000Z',
            read: false,
            delivery: 'server_accepted',
        };
        await act(async () => {
            receive(ok(incoming));
            receive(ok(incoming));
        });
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.unreadDMs).toBe(1);
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
            value: { ...permissions, messages: [] },
        }));
        port.getInbox.mockImplementation(async () => ({
            status: 'ok',
            authority: renewedAuthority,
            value: renderedInbox('', 1),
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
            id: '55555555-5555-4555-8555-555555555555',
            senderAccountId: peer,
            recipientAccountId: account,
            senderName: 'Peer',
            text: 'After renewal',
            createdAt: '2026-10-02T00:00:00.000Z',
            read: false,
            delivery: 'server_accepted',
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
    it('closes block confirmation when the control fences and renews its rendering lease', async () => {
        const { result, runtime, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => {
            result.current.setDmText('Draft across peer control');
            result.current.setShowBlockConfirm(true);
        });
        const blockedPermissions = {
            ...permissions,
            blockedByMe: true,
            blockedEitherDirection: true,
            canSend: false,
            reason: 'blocked' as const,
        };
        runtime.getThread.mockResolvedValueOnce(renderedOk({ messages: [], permissions: blockedPermissions }));
        runtime.setBlocked.mockImplementationOnce(async () => {
            // Faithful control-state order of the separate SDK/native adapter.
            emit({ status: 'unavailable', reason: 'stale_authority' });
            emit({ status: 'ready' });
            return renderedOk(blockedPermissions);
        });
        await act(async () => result.current.handleBlockUser());
        expect(result.current.showBlockConfirm).toBe(false);
        expect(result.current.blockedByMe).toBe(true);
        expect(result.current.pilotSendDisabled).toBe(true);
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
                        pending.resolve(
                            renderedOk({ messages: [renderedMessage({ message: 'Old plaintext' })], permissions }),
                        );
                    if (operation === 'ready read') emit({ status: 'ready' });
                    else completion = result.current.openDMThread(peer, 'Paired sailor');
                } else if (operation === 'inbox' || operation === 'unread') {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getInbox']>>>();
                    runtime.getInbox.mockReturnValueOnce(pending.promise);
                    resolve = () => pending.resolve(renderedOk(renderedInbox('Old inbox plaintext', 3)));
                    completion =
                        operation === 'inbox' ? result.current.openDMInbox() : result.current.loadUnreadCount();
                } else if (operation === 'permissions' || operation === 'control') {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getBlockStatus']>>>();
                    resolve = () => pending.resolve(renderedOk(permissions));
                    if (operation === 'permissions') {
                        runtime.getBlockStatus.mockReturnValueOnce(pending.promise);
                        completion = result.current.retryBlockStatus();
                    } else {
                        runtime.setBlocked.mockReturnValueOnce(pending.promise);
                        completion = result.current.handleUnblockUser();
                    }
                } else {
                    const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['sendText']>>>();
                    runtime.sendText.mockReturnValueOnce(pending.promise);
                    resolve = () =>
                        pending.resolve(
                            renderedOk(
                                renderedMessage({
                                    sender_id: account,
                                    recipient_id: peer,
                                    message: 'Keep same-owner draft',
                                    read: true,
                                }),
                            ),
                        );
                    completion = result.current.sendDMMessage();
                }
                // Opening a new thread deliberately resets a draft; native
                // lease renewal must not erase a draft already in that view.
                result.current.setDmText('Keep same-owner draft');
                emit({ status: 'unavailable', reason: 'unavailable' });
            });
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
            expectNoLegacyPath();
        },
    );
    it('merges a message received after a renewed thread snapshot started, without doubling native unread', async () => {
        const { result, runtime, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Draft across renewal'));
        const snapshot = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
        runtime.getThread.mockReturnValueOnce(snapshot.promise);
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Incoming fixture', 1)));
        act(() => emit({ status: 'ready' }));
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmThread).toHaveLength(1);
        await act(async () => snapshot.resolve(renderedOk({ messages: [], permissions })));
        expect(result.current.dmThread.map((message) => message.message)).toEqual(['Incoming fixture']);
        expect(result.current.unreadDMs).toBe(1);
        expect(result.current.dmText).toBe('Draft across renewal');
        expect(result.current.pilotSendDisabled).toBe(false);
        const inboxReads = runtime.getInbox.mock.calls.length;
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.unreadDMs).toBe(1);
        expect(runtime.getInbox).toHaveBeenCalledTimes(inboxReads);
        expectNoLegacyPath();
    });
    it('never replaces a later event-derived native inbox with an older pending snapshot', async () => {
        const { result, runtime, emit } = renderingFixture();
        const snapshot = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getInbox']>>>();
        runtime.getInbox.mockReturnValueOnce(snapshot.promise);
        act(() => emit({ status: 'ready' }));
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Incoming fixture', 1)));
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmConversations[0].last_message).toBe('Incoming fixture');
        await act(async () => snapshot.resolve(renderedOk(renderedInbox('', 0))));
        expect(result.current.dmConversations[0].last_message).toBe('Incoming fixture');
        expect(result.current.unreadDMs).toBe(1);
        expectNoLegacyPath();
    });
    it('preserves newer native acceptance/read status when an older send snapshot resolves', async () => {
        const { result, runtime, emit } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Outbound fixture'));
        const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['sendText']>>>();
        runtime.sendText.mockReturnValueOnce(pending.promise);
        let sending!: Promise<void>;
        act(() => {
            sending = result.current.sendDMMessage();
        });
        const message = renderedMessage({
            id: runtime.sendText.mock.calls[0][2],
            sender_id: account,
            recipient_id: peer,
            message: 'Outbound fixture',
            read: true,
        });
        await act(async () => emit(renderedOk(message)));
        await act(async () => {
            pending.resolve(renderedOk({ ...message, read: false, delivery_status: 'sending' }));
            await sending;
        });
        expect(result.current.dmThread).toEqual([message]);
        expect(result.current.dmText).toBe('');
        expectNoLegacyPath();
    });
    it('clears runtime A plaintext and draft and requires runtime B permissions before sending', async () => {
        const { result, runtime, rerender, emit } = renderingFixture();
        runtime.getThread.mockResolvedValueOnce(renderedOk({ messages: [renderedMessage()], permissions }));
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Runtime A private preview', 1)));
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        act(() => result.current.setDmText('Runtime A private draft'));
        const staleSend = result.current.sendDMMessage;
        const pending = deferred<Awaited<ReturnType<PrivateMessagePilotRuntime['getThread']>>>();
        const replacement: PrivateMessagePilotRuntime = {
            ...runtime,
            getThread: vi.fn(() => pending.promise),
            getInbox: vi.fn(async () => renderedOk(renderedInbox('', 0))),
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
            pending.resolve(renderedOk({ messages: [], permissions }));
            await opening;
        });
        expect(result.current.pilotSendDisabled).toBe(false);
        expect(result.current.dmText).toBe('New runtime B draft');
        expectNoLegacyPath();
    });
    it('never downgrades accepted/read native events, even if pending arrives later', async () => {
        const { result, emit, runtime } = renderingFixture();
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const message = renderedMessage({ sender_id: account, recipient_id: peer, read: true });
        await act(async () => emit(renderedOk(message)));
        const reads = runtime.getInbox.mock.calls.length;
        await act(async () => emit(renderedOk({ ...message, read: false, delivery_status: 'sending' })));
        expect(result.current.dmThread).toEqual([message]);
        expect(runtime.getInbox).toHaveBeenCalledTimes(reads);
        expectNoLegacyPath();
    });
    it('deduplicates an event already present in a snapshot instead of incrementing unread', async () => {
        const { result, runtime, emit } = renderingFixture();
        runtime.getThread.mockResolvedValueOnce(renderedOk({ messages: [renderedMessage()], permissions }));
        runtime.getInbox.mockResolvedValue(renderedOk(renderedInbox('Incoming fixture', 1)));
        await act(async () => result.current.openDMThread(peer, 'Paired sailor'));
        const inboxReads = runtime.getInbox.mock.calls.length;
        await act(async () => emit(renderedOk(renderedMessage())));
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.unreadDMs).toBe(1);
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
                        renderedMessage({ id: `44444444-4444-4444-8444-${index.toString().padStart(12, '0')}` }),
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
                thread={[
                    {
                        id: 'fixture',
                        sender_id: peer,
                        recipient_id: account,
                        sender_name: 'Peer',
                        message: '🍳RECIPE:fixture',
                        read: false,
                        created_at: '2026-10-02T00:00:00.000Z',
                    },
                ]}
                pilotActive
                currentUserId={account}
            />,
        );
        expect(screen.getByText('🍳RECIPE:fixture')).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();
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
