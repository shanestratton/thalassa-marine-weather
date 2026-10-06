/**
 * Import-graph fixtures, not encryption or live native/Auth evidence. A forbidden
 * module fails as soon as its factory is evaluated, before any method can run.
 */
import React, * as ReactModule from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatPageProps, ChatPageSelection } from '../components/ChatPage';
import type { AuthIdentityScope } from '../services/authIdentityScope';
import type {
    NativePrivateMessageAuthority,
    NativePrivateMessageBlockStatus,
    NativePrivateMessageEvent,
    NativePrivateMessageInboxEntry,
    NativePrivateMessageReadiness,
    NativePrivateMessageResult,
    NativePrivateMessageThread,
    NativePrivateTextMessage,
    PrivateMessageNativePort,
    PrivateMessagePilotRuntime,
} from '../services/chat/e2ee/privateMessagePilot';

const forbiddenModules = [
    '../components/chat/ChatDMView',
    '../hooks/chat/useChatDMs',
    '../services/ChatService',
    '../services/GalleyRecipeService',
    '../stores/authStore',
    '../services/PushNotificationService',
    '../services/supabase',
    '@supabase/supabase-js',
] as const;
const legacyPagePath = '../components/LegacyChatPage';
const nativePagePath = '../components/chat/PrivateMessagePilotPage';
const nativeHookPath = '../hooks/chat/usePrivateMessagePilotDMs';
const nativeUnavailableText = 'The native private message test is unavailable. Sending is blocked.';
const account = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333';
const clientMessageId = '44444444-4444-4444-8444-444444444444';
const authority: NativePrivateMessageAuthority = {
    accountId: account,
    deviceId: device,
    lifecycleVersion: 'import-isolation-fixture-owner1:epoch1',
    serverVerified: true,
};
const permissions: NativePrivateMessageBlockStatus = {
    peerAccountId: peer,
    blockedByMe: false,
    blockedEitherDirection: false,
    canSend: true,
    reason: null,
};

let forbiddenEvaluations: string[];
let legacyFactoryEvaluations: number;
let nativeFactoryEvaluations: number;
let allowLegacy: boolean;
let identity: typeof import('../services/authIdentityScope') | undefined;

function forbidFactory(path: string) {
    vi.doMock(path, () => {
        forbiddenEvaluations.push(path);
        throw new Error(`Forbidden native-path module factory: ${path}`);
    });
}

function assertNoLegacyEvaluation() {
    expect(legacyFactoryEvaluations).toBe(0);
    expect(forbiddenEvaluations).toEqual([]);
    expect(screen.queryByText('Explicit legacy fixture')).toBeNull();
}

async function wrapper() {
    return (await import('../components/ChatPage')).ChatPage;
}

async function localIdentity(): Promise<AuthIdentityScope> {
    identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(null);
    return identity.setAuthIdentityScope(account);
}

const nativeOK = <T,>(value: T): NativePrivateMessageResult<T> => ({ status: 'ok', authority, value });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function typedNativePort(text: string) {
    const message: NativePrivateTextMessage = {
        id: `incoming:${clientMessageId}`,
        clientMessageId,
        direction: 'incoming',
        senderAccountId: peer,
        recipientAccountId: account,
        senderName: 'Paired sailor',
        text,
        localCreatedAtMillis: null,
        read: false,
        delivery: 'received',
        reason: null,
    };
    const inbox: NativePrivateMessageInboxEntry[] = [
        {
            peerAccountId: peer,
            displayName: 'Paired sailor',
            lastText: null,
            lastLocalCreatedAtMillis: null,
            unreadCount: 0,
            historyAvailable: true,
        },
    ];
    const thread: NativePrivateMessageThread = {
        peerAccountId: peer,
        messages: [message],
        permissions,
        unresolvedCount: 0,
        pendingAttemptId: null,
    };
    const unsubscribe = vi.fn<() => void>();
    const listeners: Array<(event: NativePrivateMessageEvent) => void> = [];
    const port = {
        readiness: vi.fn<() => Promise<NativePrivateMessageReadiness>>(async () => ({
            status: 'ready',
            authority,
            supportedContent: ['text'],
        })),
        getInbox: vi.fn(async () => nativeOK(inbox)),
        getThread: vi.fn(async () => nativeOK(thread)),
        sendText: vi.fn(async () => nativeOK(message)),
        retryPending: vi.fn(async () => nativeOK(message)),
        getBlockStatus: vi.fn(async () => nativeOK(permissions)),
        setBlocked: vi.fn(async () => nativeOK(permissions)),
        subscribe: vi.fn(
            async (
                _request: { authority: NativePrivateMessageAuthority },
                listener: (event: NativePrivateMessageEvent) => void,
            ): Promise<() => void> => {
                listeners.push(listener);
                return unsubscribe;
            },
        ),
    } satisfies PrivateMessageNativePort;
    return { port, unsubscribe, listeners, message, thread };
}

async function typedNativeRuntime(text: string) {
    const scope = await localIdentity();
    const { createPrivateMessagePilotRuntime } = await import('../services/chat/e2ee/privateMessagePilot');
    const fixture = typedNativePort(text);
    return { runtime: createPrivateMessagePilotRuntime(fixture.port), ...fixture, scope };
}

beforeEach(() => {
    cleanup();
    vi.resetModules();
    // The renderer and each fresh import graph share the React instance that
    // testing-library imported above. resetModules must not split hook dispatch.
    vi.doMock('react', () => ReactModule);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    forbiddenEvaluations = [];
    legacyFactoryEvaluations = 0;
    nativeFactoryEvaluations = 0;
    allowLegacy = false;
    identity = undefined;
    for (const path of forbiddenModules) forbidFactory(path);
    vi.doMock(legacyPagePath, () => {
        legacyFactoryEvaluations += 1;
        if (!allowLegacy) throw new Error('Forbidden legacy page factory on native selection');
        return { LegacyChatPage: () => <div>Explicit legacy fixture</div> };
    });
});

afterEach(() => {
    cleanup();
    identity?.setAuthIdentityScope(null);
    vi.restoreAllMocks();
    for (const path of forbiddenModules) vi.doUnmock(path);
    vi.doUnmock(legacyPagePath);
    vi.doUnmock(nativePagePath);
    vi.doUnmock(nativeHookPath);
    vi.doUnmock('react');
});

describe('ChatPage native import isolation — typed local rendering fixtures', () => {
    it.each([
        ['explicit legacy', { selection: { kind: 'legacy' } }],
        ['default legacy', {}],
        ['disabled compatibility runtime', { privateMessageRuntime: { kind: 'disabled' } }],
    ] as const)('evaluates only the selected lazy legacy fixture for %s', async (_name, props) => {
        allowLegacy = true;
        vi.doMock(nativePagePath, () => {
            nativeFactoryEvaluations += 1;
            throw new Error('Native page must not evaluate for a legacy selection');
        });
        const ChatPage = await wrapper();
        expect(legacyFactoryEvaluations).toBe(0);
        render(<ChatPage {...props} />);
        await screen.findByText('Explicit legacy fixture');
        expect(legacyFactoryEvaluations).toBe(1);
        expect(nativeFactoryEvaluations).toBe(0);
        expect(forbiddenEvaluations).toEqual([]);
    });

    it.each([
        ['provided undefined', undefined],
        ['provided null', null],
        ['provided wrong kind', { kind: 'wrong-runtime' }],
        ['provided incomplete native runtime', { kind: 'native-pilot' }],
        [
            'throwing kind getter',
            {
                get kind() {
                    throw new Error('Fixture kind getter refused');
                },
            },
        ],
        [
            'throwing native method getter',
            {
                kind: 'native-pilot',
                get getInbox() {
                    throw new Error('Fixture native method getter refused');
                },
            },
        ],
    ] as const)(
        'refuses compatibility injection %s without evaluating either implementation',
        async (_name, runtime) => {
            vi.doMock(nativePagePath, () => {
                nativeFactoryEvaluations += 1;
                throw new Error('Invalid compatibility injection must not evaluate the native page');
            });
            const ChatPage = await wrapper();
            const props = { privateMessageRuntime: runtime } as unknown as ChatPageProps;
            render(<ChatPage {...props} />);
            await screen.findByText(nativeUnavailableText);
            expect(nativeFactoryEvaluations).toBe(0);
            assertNoLegacyEvaluation();
        },
    );

    it.each([
        ['provided null selection', null],
        ['provided undefined selection', undefined],
        ['provided false selection', false],
        [
            'throwing selection kind getter',
            {
                get kind() {
                    throw new Error('Fixture selection getter refused');
                },
            },
        ],
        ['explicit native unavailable', { kind: 'native-unavailable' }],
        ['missing native runtime', { kind: 'native-pilot' }],
        ['wrong runtime kind', { kind: 'native-pilot', runtime: { kind: 'disabled' } }],
        ['invalid native methods', { kind: 'native-pilot', runtime: { kind: 'native-pilot' } }],
    ] as const)('refuses %s without evaluating either chat implementation', async (_name, selection) => {
        vi.doMock(nativePagePath, () => {
            nativeFactoryEvaluations += 1;
            throw new Error('Invalid native selection must not evaluate the native page');
        });
        const ChatPage = await wrapper();
        render(<ChatPage selection={selection as unknown as ChatPageSelection} />);
        await screen.findByText(/Encryption test—not reviewed/i);
        await screen.findByText(nativeUnavailableText);
        expect(nativeFactoryEvaluations).toBe(0);
        assertNoLegacyEvaluation();
    });

    it('contains a rejected native lazy import without evaluating the legacy page', async () => {
        const fixture = await typedNativeRuntime('Never rendered rejected-import fixture');
        vi.doMock(nativePagePath, () => {
            nativeFactoryEvaluations += 1;
            throw new Error('Deliberate native lazy-import rejection');
        });
        // React reports the deliberate rejected import while the wrapper's
        // boundary renders its native refusal. No other sample suppresses errors.
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const ChatPage = await wrapper();
        render(<ChatPage selection={{ kind: 'native-pilot', runtime: fixture.runtime }} />);
        await screen.findByText(/Encryption test—not reviewed/i);
        await screen.findByText(nativeUnavailableText);
        expect(nativeFactoryEvaluations).toBe(1);
        expect(fixture.port.getInbox).not.toHaveBeenCalled();
        assertNoLegacyEvaluation();
    });

    it.each(['explicit selection', 'compatibility injection'] as const)(
        'loads the real native page, hook and view through %s with every forbidden factory untouched',
        async (entry) => {
            const fixture = await typedNativeRuntime('Real native graph fixture plaintext');
            const ChatPage = await wrapper();
            const props: ChatPageProps =
                entry === 'explicit selection'
                    ? { selection: { kind: 'native-pilot', runtime: fixture.runtime } }
                    : { privateMessageRuntime: fixture.runtime };
            render(<ChatPage {...props} />);
            fireEvent.click(await screen.findByRole('button', { name: 'Message Paired sailor' }));
            await screen.findByText('Real native graph fixture plaintext');
            expect(fixture.port.getInbox).toHaveBeenCalledWith({ authority });
            expect(fixture.port.getThread).toHaveBeenCalledWith({ authority, peerAccountId: peer });
            expect(fixture.port.readiness).toHaveBeenCalled();
            expect(identity?.getAuthIdentityScope()).toBe(fixture.scope);
            expect(screen.getByRole('textbox', { name: 'Message Paired sailor' })).toHaveValue('');
            assertNoLegacyEvaluation();
        },
    );

    it('keeps native readiness refusal on the native-only graph without a legacy fallback', async () => {
        const fixture = await typedNativeRuntime('Refused native plaintext');
        fixture.port.readiness.mockResolvedValue({ status: 'unavailable', reason: 'unavailable' });
        const ChatPage = await wrapper();
        render(<ChatPage selection={{ kind: 'native-pilot', runtime: fixture.runtime }} />);
        await screen.findByText('The encryption test is unavailable. Sending is blocked.');
        expect(fixture.port.readiness).toHaveBeenCalled();
        expect(fixture.port.getInbox).not.toHaveBeenCalled();
        expect(screen.queryByText('Refused native plaintext')).toBeNull();
        assertNoLegacyEvaluation();
    });

    it('erases the old native plaintext and draft synchronously when the runtime is replaced', async () => {
        const first = await typedNativeRuntime('OLD-NATIVE-PLAINTEXT-TO-ERASE');
        const { createPrivateMessagePilotRuntime } = await import('../services/chat/e2ee/privateMessagePilot');
        const second = typedNativePort('NEW-NATIVE-PLAINTEXT');
        second.port.readiness.mockResolvedValue({ status: 'unavailable', reason: 'unavailable' });
        const replacement: PrivateMessagePilotRuntime = createPrivateMessagePilotRuntime(second.port);
        const ChatPage = await wrapper();
        const mounted = render(<ChatPage selection={{ kind: 'native-pilot', runtime: first.runtime }} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Message Paired sailor' }));
        await screen.findByText('OLD-NATIVE-PLAINTEXT-TO-ERASE');
        const draft = screen.getByRole('textbox', { name: 'Message Paired sailor' });
        fireEvent.change(draft, { target: { value: 'OLD-NATIVE-DRAFT-TO-ERASE' } });
        expect(draft).toHaveValue('OLD-NATIVE-DRAFT-TO-ERASE');
        await waitFor(() => expect(first.port.subscribe).toHaveBeenCalledTimes(1));

        mounted.rerender(<ChatPage selection={{ kind: 'native-pilot', runtime: replacement }} />);
        // These checks intentionally precede any await: another runtime cannot
        // inherit a frame of old plaintext or draft while readiness is pending.
        expect(mounted.container.textContent).not.toContain('OLD-NATIVE-PLAINTEXT-TO-ERASE');
        expect(screen.queryByDisplayValue('OLD-NATIVE-DRAFT-TO-ERASE')).toBeNull();
        expect(identity?.getAuthIdentityScope()).toBe(first.scope);
        await waitFor(() => expect(first.unsubscribe).toHaveBeenCalledTimes(1));
        await screen.findByText('The encryption test is unavailable. Sending is blocked.');
        expect(second.port.getThread).not.toHaveBeenCalled();
        assertNoLegacyEvaluation();
    });

    it('erases visible native text on the local identity fence without evaluating production Auth', async () => {
        const fixture = await typedNativeRuntime('LOCAL-FENCE-PLAINTEXT-TO-ERASE');
        const ChatPage = await wrapper();
        const mounted = render(<ChatPage selection={{ kind: 'native-pilot', runtime: fixture.runtime }} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Message Paired sailor' }));
        await screen.findByText('LOCAL-FENCE-PLAINTEXT-TO-ERASE');
        act(() => {
            identity?.setAuthIdentityScope(null);
        });
        expect(mounted.container.textContent).not.toContain('LOCAL-FENCE-PLAINTEXT-TO-ERASE');
        assertNoLegacyEvaluation();
    });

    it.each(['visibilitychange', 'pagehide'] as const)(
        'closes private rendering on %s and rejects stale native reads/events until explicit retry',
        async (closeEvent) => {
            let visibility: DocumentVisibilityState = 'visible';
            vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
            vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
            const fixture = await typedNativeRuntime('VISIBLE-PRIVATE-TEXT-BEFORE-CLOSE');
            const ChatPage = await wrapper();
            const mounted = render(<ChatPage selection={{ kind: 'native-pilot', runtime: fixture.runtime }} />);
            fireEvent.click(await screen.findByRole('button', { name: 'Message Paired sailor' }));
            await screen.findByText('VISIBLE-PRIVATE-TEXT-BEFORE-CLOSE');
            const draft = screen.getByRole('textbox', { name: 'Message Paired sailor' });
            fireEvent.change(draft, { target: { value: 'PRIVATE-DRAFT-BEFORE-CLOSE' } });
            await waitFor(() => expect(fixture.listeners.length).toBeGreaterThan(0));
            await act(async () => {
                for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
            });
            const lateListener = fixture.listeners.at(-1)!;
            const held = deferred<NativePrivateMessageResult<NativePrivateMessageThread>>();
            const threadCalls = fixture.port.getThread.mock.calls.length;
            fixture.port.getThread.mockImplementationOnce(() => held.promise);
            fireEvent.click(screen.getByRole('button', { name: 'Refresh native messages' }));
            await waitFor(() => expect(fixture.port.getThread).toHaveBeenCalledTimes(threadCalls + 1));
            expect(screen.getByText('VISIBLE-PRIVATE-TEXT-BEFORE-CLOSE')).toBeInTheDocument();
            expect(draft).toHaveValue('PRIVATE-DRAFT-BEFORE-CLOSE');
            // Public refresh scans the native inbox before requesting this
            // held thread; capture the baseline after that scan has entered.
            const inboxCalls = fixture.port.getInbox.mock.calls.length;

            act(() => {
                if (closeEvent === 'visibilitychange') {
                    visibility = 'hidden';
                    document.dispatchEvent(new Event('visibilitychange'));
                } else window.dispatchEvent(new Event('pagehide'));
            });
            const closedText = 'Private message view closed. Recheck native availability to reopen.';
            // Privacy erasure is synchronous and preserves the local account;
            // closing a view does not fabricate native logout or revocation.
            expect(mounted.container.textContent).not.toContain('VISIBLE-PRIVATE-TEXT-BEFORE-CLOSE');
            expect(screen.queryByDisplayValue('PRIVATE-DRAFT-BEFORE-CLOSE')).toBeNull();
            expect(screen.getByText(closedText)).toBeInTheDocument();
            expect(identity?.getAuthIdentityScope()).toBe(fixture.scope);

            const lateID = '55555555-5555-4555-8555-555555555555';
            const lateMessage: NativePrivateTextMessage = {
                ...fixture.message,
                id: `incoming:${lateID}`,
                clientMessageId: lateID,
                text: 'STALE-NATIVE-PLAINTEXT-MUST-STAY-HIDDEN',
            };
            await act(async () => {
                held.resolve(nativeOK({ ...fixture.thread, messages: [lateMessage] }));
                lateListener(nativeOK(lateMessage));
                // Complete bounded readiness/validation promise chains without
                // sleeps or fake timers altering the native event ordering.
                for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
            });
            expect(mounted.container.textContent).not.toContain('STALE-NATIVE-PLAINTEXT-MUST-STAY-HIDDEN');
            expect(screen.getByText(closedText)).toBeInTheDocument();
            expect(fixture.port.getInbox).toHaveBeenCalledTimes(inboxCalls);

            await act(async () => {
                visibility = 'visible';
                document.dispatchEvent(new Event('visibilitychange'));
                for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
            });
            expect(screen.getByText(closedText)).toBeInTheDocument();
            expect(fixture.port.getInbox).toHaveBeenCalledTimes(inboxCalls);
            expect(screen.queryByRole('button', { name: 'Message Paired sailor' })).toBeNull();
            fireEvent.click(screen.getByRole('button', { name: 'Retry native availability' }));
            await screen.findByRole('button', { name: 'Message Paired sailor' });
            expect(fixture.port.getInbox.mock.calls.length).toBeGreaterThan(inboxCalls);
            expect(mounted.container.textContent).not.toContain('STALE-NATIVE-PLAINTEXT-MUST-STAY-HIDDEN');
            expect(screen.queryByDisplayValue('PRIVATE-DRAFT-BEFORE-CLOSE')).toBeNull();
            assertNoLegacyEvaluation();
        },
    );

    it('ignores a rejected old page action after explicit reopening — mocked-hook rejection fixture', async () => {
        // Native adapter/hook normally contain port failures. Mock only the
        // hook boundary here to exercise the page's exceptional rejected action.
        const fixture = await typedNativeRuntime('Unused mocked-hook native port text');
        let visibility: DocumentVisibilityState = 'visible';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
        let rejectOldAction!: (reason: unknown) => void;
        const oldAction = new Promise<void>((_resolve, reject) => {
            rejectOldAction = reject;
        });
        let revision = 0;
        let options!: Parameters<typeof import('../hooks/chat/usePrivateMessagePilotDMs').usePrivateMessagePilotDMs>[0];
        const closeView = vi.fn(() => {
            revision += 1;
        });
        const openInbox = vi.fn(async () => {
            revision += 1;
            options.setView('dm_inbox');
        });
        const refresh = vi.fn(() => oldAction);
        const mockedHook = {
            currentUserId: account,
            identityGeneration: fixture.scope.generation,
            getPrivateMessageViewRevision: () => revision,
            closePrivateMessageView: closeView,
            subscribe: vi.fn(() => vi.fn()),
            openDMInbox: openInbox,
            openDMThread: vi.fn(async () => {
                revision += 1;
                options.setView('dm_thread');
            }),
            refreshNativeMessages: refresh,
            retryBlockStatus: vi.fn(async () => undefined),
            retryPilotPendingMessage: vi.fn(async () => undefined),
            sendDMMessage: vi.fn(async () => undefined),
            setDmPartner: vi.fn(),
            setDmText: vi.fn(),
            dmPartner: { id: peer, name: 'Paired sailor' },
            dmText: '',
            dmThread: [],
            dmConversations: [
                {
                    kind: 'native-pilot',
                    user_id: peer,
                    display_name: 'Paired sailor',
                    last_message: 'FRESH-NATIVE-INBOX-AFTER-REOPEN',
                    last_at: null,
                    unread_count: 0,
                    historyAvailable: true,
                },
            ],
            pilotStatusText: null,
            pilotUnresolvedCount: 0,
            pilotPendingAttemptId: null,
            pilotRetryDisabled: false,
            pilotSendDisabled: false,
            isUserBlocked: false,
            blockStatusLoading: false,
            blockStatusError: null,
        };
        vi.doMock(nativeHookPath, () => ({
            usePrivateMessagePilotDMs: (next: typeof options) => {
                options = next;
                return mockedHook;
            },
        }));
        const errors = vi.spyOn(console, 'error');
        const ChatPage = await wrapper();
        render(<ChatPage selection={{ kind: 'native-pilot', runtime: fixture.runtime }} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Message Paired sailor' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Refresh native messages' }));
        expect(refresh).toHaveBeenCalledTimes(1);

        act(() => {
            visibility = 'hidden';
            document.dispatchEvent(new Event('visibilitychange'));
        });
        const closedText = 'Private message view closed. Recheck native availability to reopen.';
        expect(screen.getByText(closedText)).toBeInTheDocument();
        expect(closeView).toHaveBeenCalledTimes(1);
        act(() => {
            visibility = 'visible';
            document.dispatchEvent(new Event('visibilitychange'));
        });
        fireEvent.click(screen.getByRole('button', { name: 'Retry native availability' }));
        await screen.findByText('FRESH-NATIVE-INBOX-AFTER-REOPEN');
        expect(openInbox).toHaveBeenCalledTimes(2);
        await act(async () => {
            rejectOldAction(new Error('Deliberate old mocked page action rejection'));
            for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        });
        expect(screen.getByText('FRESH-NATIVE-INBOX-AFTER-REOPEN')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Message Paired sailor' })).toBeInTheDocument();
        expect(screen.queryByText(closedText)).toBeNull();
        expect(screen.queryByText(nativeUnavailableText)).toBeNull();
        expect(closeView).toHaveBeenCalledTimes(1);
        expect(openInbox).toHaveBeenCalledTimes(2);
        expect(identity?.getAuthIdentityScope()).toBe(fixture.scope);
        expect(errors).not.toHaveBeenCalled();
        assertNoLegacyEvaluation();
    });
});
