import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../../services/authIdentityScope';

const api = vi.hoisted(() => ({
    status: vi.fn(),
    thread: vi.fn(),
    block: vi.fn(),
    unblock: vi.fn(),
    send: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
}));
vi.mock('../../services/ChatService', () => ({
    ChatService: {
        getDMBlockStatus: api.status,
        getDMThread: api.thread,
        blockUser: api.block,
        unblockUser: api.unblock,
        sendDM: api.send,
    },
}));
vi.mock('../../services/PushNotificationService', () => ({
    PushNotificationService: { requestPermissionAndRegister: async () => null },
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
    api.block.mockResolvedValue(true);
    api.unblock.mockResolvedValue(true);
    api.send.mockResolvedValue(null);
});

describe('DM blocking hook safety', () => {
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

    it('does not restore an old account’s result into the next identity', async () => {
        const pending = deferred<typeof own>();
        api.status.mockReturnValueOnce(pending.promise);
        const { result } = setup();
        let opened!: Promise<void>;
        act(() => {
            opened = result.current.openDMThread('friend', 'Friend');
        });
        act(() => setAuthIdentityScope('account-b'));
        await act(async () => {
            pending.resolve(own);
            await opened;
        });
        expect(result.current.dmPartner).toBeNull();
        expect(result.current.blockedByMe).toBe(false);
        expect(result.current.dmThread).toEqual([]);
    });
});
