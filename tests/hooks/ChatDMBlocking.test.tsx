import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import type { DirectMessage } from '../../services/ChatService';

const api = vi.hoisted(() => ({
    status: vi.fn(),
    thread: vi.fn(),
    conversations: vi.fn(),
    block: vi.fn(),
    unblock: vi.fn(),
    send: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    subscribe: vi.fn(),
    registerPush: vi.fn(),
}));
vi.mock('../../services/ChatService', () => ({
    ChatService: {
        getDMBlockStatus: api.status,
        getDMThread: api.thread,
        getDMConversations: api.conversations,
        blockUser: api.block,
        unblockUser: api.unblock,
        sendDM: api.send,
        subscribeToDMs: api.subscribe,
    },
}));
vi.mock('../../services/PushNotificationService', () => ({
    PushNotificationService: { requestPermissionAndRegister: api.registerPush },
}));
vi.mock('../../components/Toast', () => ({ toast: { error: api.error, info: api.info } }));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { useChatDMs } from '../../hooks/chat/useChatDMs';

const clear = { blockedByMe: false, blockedEitherDirection: false };
const own = { blockedByMe: true, blockedEitherDirection: true };
const reverse = { blockedByMe: false, blockedEitherDirection: true };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function setup() {
    const options = { setView: vi.fn(), setNavDirection: vi.fn(), setLoading: vi.fn() };
    return renderHook(() => useChatDMs(options));
}
beforeEach(() => {
    vi.resetAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
    api.status.mockResolvedValue(clear);
    api.thread.mockResolvedValue([]);
    api.conversations.mockResolvedValue([]);
    api.block.mockResolvedValue(true);
    api.unblock.mockResolvedValue(true);
    api.send.mockResolvedValue(null);
    api.registerPush.mockResolvedValue(null);
});

describe('DM blocking hook safety', () => {
    it('does not consume another sailor’s unread badge when opening the self test repeatedly', async () => {
        api.conversations.mockResolvedValue([
            {
                user_id: 'friend',
                display_name: 'Friend',
                last_message: 'Unread peer message',
                last_at: new Date().toISOString(),
                unread_count: 2,
            },
        ]);
        const { result } = setup();
        await act(async () => result.current.loadUnreadCount());
        expect(result.current.unreadDMs).toBe(2);
        await act(async () => result.current.openDMThread('account-a', 'Self test'));
        expect(result.current.unreadDMs).toBe(2);
        await act(async () => result.current.openDMThread('account-a', 'Self test'));
        expect(result.current.unreadDMs).toBe(2);
        await act(async () => result.current.openDMThread('friend', 'Friend'));
        expect(result.current.unreadDMs).toBe(1);
    });

    it('opens a labeled self test through the real block check and supports block then unblock', async () => {
        const { result } = setup();
        await act(async () => result.current.openDMThread('account-a', 'My display name'));
        expect(result.current.currentUserId).toBe('account-a');
        expect(result.current.isSelfConversation).toBe(true);
        expect(result.current.dmPartner).toEqual({ id: 'account-a', name: 'Self test' });
        expect(api.status).toHaveBeenCalledWith('account-a');
        expect(api.registerPush).not.toHaveBeenCalled();
        api.status.mockResolvedValueOnce(own);
        await act(async () => result.current.handleBlockUser());
        expect(api.block).toHaveBeenCalledWith('account-a');
        expect(result.current.blockedByMe).toBe(true);
        act(() => result.current.setDmText('My test draft'));
        await act(async () => result.current.sendDMMessage());
        expect(api.send).not.toHaveBeenCalled();
        await act(async () => result.current.handleUnblockUser());
        expect(api.unblock).toHaveBeenCalledWith('account-a');
        expect(result.current.isUserBlocked).toBe(false);
        expect(result.current.dmText).toBe('My test draft');
        await act(async () => result.current.sendDMMessage());
        expect(api.send).toHaveBeenCalledWith('account-a', 'My test draft');
    });

    it('does not bypass unavailable server verification for a self test', async () => {
        api.status.mockRejectedValueOnce(new Error('self RPC unavailable'));
        const { result } = setup();
        await act(async () => result.current.openDMThread('account-a', 'Self test'));
        act(() => result.current.setDmText('Keep my test draft'));
        await act(async () => result.current.sendDMMessage());
        expect(api.send).not.toHaveBeenCalled();
        expect(result.current.blockStatusError).toContain('Unable to verify');
        expect(result.current.dmText).toBe('Keep my test draft');
        await act(async () => result.current.retryBlockStatus());
        expect(result.current.blockStatusError).toBeNull();
    });

    it.each(['echo-first', 'response-first'] as const)(
        'renders one self PM when %s, without an unread self badge',
        async (order) => {
            let receive!: (message: DirectMessage) => void;
            api.subscribe.mockImplementation((callback) => {
                receive = callback;
                return vi.fn();
            });
            const sent: DirectMessage = {
                id: 'server-self',
                sender_id: 'account-a',
                recipient_id: 'account-a',
                sender_name: 'Me',
                message: 'Self message',
                read: true,
                created_at: new Date().toISOString(),
            };
            const pending = deferred<DirectMessage>();
            api.send.mockReturnValueOnce(pending.promise);
            const { result } = setup();
            act(() => {
                result.current.subscribe();
            });
            await act(async () => result.current.openDMThread('account-a', 'Self test'));
            act(() => result.current.setDmText(sent.message));
            let sending!: Promise<void>;
            act(() => {
                sending = result.current.sendDMMessage();
            });
            if (order === 'echo-first') {
                act(() => {
                    receive(sent);
                    receive(sent);
                });
                expect(result.current.dmThread).toHaveLength(1);
                expect(result.current.dmThread[0].delivery_status).toBe('sending');
            }
            await act(async () => {
                pending.resolve(sent);
                await sending;
            });
            act(() => {
                receive(sent);
                receive(sent);
            });
            expect(result.current.dmThread).toEqual([sent]);
            expect(result.current.unreadDMs).toBe(0);
        },
    );

    it('keeps distinct self messages even with equal text and drops old-account echoes after a switch', async () => {
        let receive!: (message: DirectMessage) => void;
        api.subscribe.mockImplementation((callback) => {
            receive = callback;
            return vi.fn();
        });
        const sent: DirectMessage = {
            id: 'local-send',
            sender_id: 'account-a',
            recipient_id: 'account-a',
            sender_name: 'Me',
            message: 'Same words',
            read: true,
            created_at: new Date().toISOString(),
        };
        const otherDevice = { ...sent, id: 'another-device-send' };
        const pending = deferred<DirectMessage>();
        api.send.mockReturnValueOnce(pending.promise);
        const { result } = setup();
        act(() => {
            result.current.subscribe();
        });
        await act(async () => result.current.openDMThread('account-a', 'Self test'));
        act(() => result.current.setDmText(sent.message));
        let sending!: Promise<void>;
        act(() => {
            sending = result.current.sendDMMessage();
            receive(otherDevice);
            receive(sent);
        });
        await act(async () => {
            pending.resolve(sent);
            await sending;
        });
        expect(result.current.dmThread.map((message) => message.id)).toEqual(['local-send', 'another-device-send']);
        act(() => setAuthIdentityScope('account-b'));
        await act(async () => result.current.openDMThread('account-b', 'Self test'));
        act(() => receive(sent));
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.currentUserId).toBe('account-b');
        expect(result.current.dmPartner?.id).toBe('account-b');
    });

    it('keeps lookup failure distinct from blocked and preserves the draft until a successful retry', async () => {
        api.status.mockRejectedValueOnce(new Error('offline'));
        const { result } = setup();
        await act(async () => result.current.openDMThread('friend', 'Friend'));
        expect(result.current.isUserBlocked).toBe(false);
        expect(result.current.blockStatusError).toContain('Unable to verify');
        act(() => result.current.setDmText('Keep this draft'));
        await act(async () => result.current.sendDMMessage());
        expect(api.send).not.toHaveBeenCalled();
        expect(result.current.dmText).toBe('Keep this draft');
        await act(async () => result.current.retryBlockStatus());
        expect(result.current.blockStatusError).toBeNull();
        expect(result.current.blockStatusLoading).toBe(false);
    });

    it('does not send while checking and distinguishes a reverse block from the caller’s own block', async () => {
        const pending = deferred<typeof reverse>();
        api.status.mockReturnValueOnce(pending.promise);
        const { result } = setup();
        let opened!: Promise<void>;
        act(() => {
            opened = result.current.openDMThread('friend', 'Friend');
        });
        act(() => result.current.setDmText('Do not send'));
        expect(result.current.blockStatusLoading).toBe(true);
        await act(async () => result.current.sendDMMessage());
        expect(api.send).not.toHaveBeenCalled();
        await act(async () => {
            pending.resolve(reverse);
            await opened;
        });
        expect(result.current.isUserBlocked).toBe(true);
        expect(result.current.blockedByMe).toBe(false);
        await act(async () => result.current.sendDMMessage());
        expect(api.send).not.toHaveBeenCalled();
    });

    it('does not claim the other direction was unblocked when removing the caller’s block', async () => {
        api.status.mockResolvedValueOnce(own).mockResolvedValueOnce(reverse);
        const { result } = setup();
        await act(async () => result.current.openDMThread('friend', 'Friend'));
        await act(async () => result.current.handleUnblockUser());
        expect(api.unblock).toHaveBeenCalledWith('friend');
        expect(result.current.blockedByMe).toBe(false);
        expect(result.current.isUserBlocked).toBe(true);
    });

    it('prevents duplicate mutations and sending during a block, then removes queued rows only', async () => {
        const pending = deferred<boolean>();
        api.block.mockReturnValueOnce(pending.promise);
        const { result } = setup();
        await act(async () => result.current.openDMThread('friend', 'Friend'));
        act(() => {
            result.current.setDmText('Keep draft');
            result.current.setDmThread([
                { id: 'queued', delivery_status: 'queued' },
                { id: 'sent', delivery_status: 'sent' },
            ] as never);
        });
        let blocked!: Promise<void>;
        act(() => {
            blocked = result.current.handleBlockUser();
        });
        expect(result.current.blockMutationPending).toBe(true);
        await act(async () => {
            await result.current.handleBlockUser();
            await result.current.sendDMMessage();
        });
        expect(api.block).toHaveBeenCalledOnce();
        expect(api.send).not.toHaveBeenCalled();
        api.status.mockResolvedValueOnce(own);
        await act(async () => {
            pending.resolve(true);
            await blocked;
        });
        expect(result.current.blockMutationPending).toBe(false);
        expect(result.current.blockedByMe).toBe(true);
        expect(result.current.dmThread.map((message) => message.id)).toEqual(['sent']);
        expect(result.current.dmText).toBe('Keep draft');
    });

    it.each([false, new Error('unavailable')])(
        'does not show successful blocking after a failed mutation (%j)',
        async (failure) => {
            if (failure instanceof Error) api.block.mockRejectedValueOnce(failure);
            else api.block.mockResolvedValueOnce(failure);
            const { result } = setup();
            await act(async () => result.current.openDMThread('friend', 'Friend'));
            await act(async () => result.current.handleBlockUser());
            expect(result.current.blockedByMe).toBe(false);
            expect(result.current.blockStatusError).toContain('Unable to confirm');
            expect(result.current.blockMutationPending).toBe(false);
            expect(api.error).toHaveBeenCalled();
        },
    );

    it('ignores a previous partner’s delayed thread and block lookup', async () => {
        const oldStatus = deferred<typeof own>();
        const oldThread = deferred<never[]>();
        api.status.mockReturnValueOnce(oldStatus.promise);
        api.thread.mockReturnValueOnce(oldThread.promise);
        const { result } = setup();
        let oldOpened!: Promise<void>;
        act(() => {
            oldOpened = result.current.openDMThread('old', 'Old');
        });
        await act(async () => result.current.openDMThread('new', 'New'));
        act(() => result.current.setDmText('New partner draft'));
        await act(async () => {
            oldStatus.resolve(own);
            oldThread.resolve([{ id: 'old' }] as never);
            await oldOpened;
        });
        expect(result.current.dmPartner?.id).toBe('new');
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmText).toBe('New partner draft');
        expect(result.current.isUserBlocked).toBe(false);
    });

    it('ignores a late block completion after changing partner', async () => {
        const pending = deferred<boolean>();
        api.block.mockReturnValueOnce(pending.promise);
        const { result } = setup();
        await act(async () => result.current.openDMThread('old', 'Old'));
        let blocked!: Promise<void>;
        act(() => {
            blocked = result.current.handleBlockUser();
        });
        await act(async () => result.current.openDMThread('new', 'New'));
        await act(async () => {
            pending.resolve(true);
            await blocked;
        });
        expect(result.current.dmPartner?.id).toBe('new');
        expect(result.current.blockedByMe).toBe(false);
        expect(result.current.blockMutationPending).toBe(false);
    });

    it('restores the draft if a block appears between open and send', async () => {
        api.send.mockResolvedValueOnce('blocked');
        const { result } = setup();
        await act(async () => result.current.openDMThread('friend', 'Friend'));
        act(() => result.current.setDmText('Keep my words'));
        api.status.mockResolvedValueOnce(reverse);
        await act(async () => result.current.sendDMMessage());
        expect(result.current.dmText).toBe('Keep my words');
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.blockedByMe).toBe(false);
        expect(result.current.isUserBlocked).toBe(true);
    });

    it.each(['friend', 'account-a'])(
        'does not restore the old account’s %s result into the next identity',
        async (partner) => {
            const pending = deferred<typeof own>();
            api.status.mockReturnValueOnce(pending.promise);
            const { result } = setup();
            let opened!: Promise<void>;
            act(() => {
                opened = result.current.openDMThread(partner, 'Partner');
            });
            act(() => setAuthIdentityScope('account-b'));
            await act(async () => {
                pending.resolve(own);
                await opened;
            });
            expect(result.current.dmPartner).toBeNull();
            expect(result.current.blockedByMe).toBe(false);
            expect(result.current.dmThread).toEqual([]);
        },
    );
});
