import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => {
    const rpc = vi.fn();
    const insert = vi.fn();
    const records = new Map<string, string>();
    const getUser = vi.fn();
    return { rpc, insert, records, getUser };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        rpc: backend.rpc,
        auth: { getUser: backend.getUser, getSession: vi.fn() },
        from: vi.fn(() => ({ insert: backend.insert })),
        removeChannel: vi.fn(),
    },
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: backend.records.get(key) ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            backend.records.set(key, value);
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            backend.records.delete(key);
        }),
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ChatService } from '../services/ChatService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const clear = { blockedByMe: false, blockedEitherDirection: false };
const own = { blockedByMe: true, blockedEitherDirection: true };
const reverse = { blockedByMe: false, blockedEitherDirection: true };

beforeEach(() => {
    ChatService.destroy();
    vi.clearAllMocks();
    backend.records.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
    backend.getUser.mockResolvedValue({ data: { user: { id: 'account-a', user_metadata: {} } }, error: null });
    backend.rpc.mockResolvedValue({ data: clear, error: null });
    backend.insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'sent' }, error: null }) }) });
});
afterEach(() => ChatService.destroy());

describe('ChatService bilateral blocking', () => {
    it('gets caller-scoped status without trying to read recipient-owned rows', async () => {
        backend.rpc.mockResolvedValueOnce({ data: reverse, error: null });
        await expect(ChatService.getDMBlockStatus('friend')).resolves.toEqual(reverse);
        expect(backend.rpc).toHaveBeenCalledWith('get_chat_dm_block_status', { p_other_user_id: 'friend' });
    });

    it.each([own, reverse])('never inserts or queues when either direction is blocked (%j)', async (status) => {
        backend.rpc.mockResolvedValueOnce({ data: status, error: null });
        await expect(ChatService.sendDM('friend', 'Do not send')).resolves.toBe('blocked');
        expect(backend.insert).not.toHaveBeenCalled();
        expect(backend.records.size).toBe(0);
    });

    it.each([
        { data: null, error: { message: 'network down' } },
        { data: null, error: null },
        { data: { blockedByMe: true, blockedEitherDirection: false }, error: null },
    ])('fails closed without claiming blocked or queuing on unavailable status (%j)', async (response) => {
        backend.rpc.mockResolvedValue(response);
        await expect(ChatService.getDMBlockStatus('friend')).rejects.toThrow('Unable to verify');
        await expect(ChatService.sendDM('friend', 'Keep my draft')).resolves.toBeNull();
        expect(backend.insert).not.toHaveBeenCalled();
        expect(backend.records.size).toBe(0);
    });

    it('uses the idempotent block RPC and removes only that partner’s owned queued DMs', async () => {
        const key = authScopedStorageKey('chat_offline_queue', getAuthIdentityScope());
        const base = { owner_user_id: 'account-a', message: 'queued', timestamp: new Date().toISOString() };
        backend.records.set(
            key,
            JSON.stringify([
                { ...base, queue_id: 'cancel', type: 'dm', recipient_id: 'friend' },
                { ...base, queue_id: 'keep-dm', type: 'dm', recipient_id: 'other' },
                { ...base, queue_id: 'keep-channel', type: 'channel', channel_id: 'channel' },
            ]),
        );
        backend.rpc.mockResolvedValue({ data: own, error: null });
        await expect(ChatService.blockUser('friend')).resolves.toBe(true);
        await expect(ChatService.blockUser('friend')).resolves.toBe(true);
        expect(backend.rpc).toHaveBeenCalledWith('set_chat_user_block', { p_other_user_id: 'friend', p_blocked: true });
        expect(JSON.parse(backend.records.get(key)!)).toHaveLength(2);
        expect(JSON.parse(backend.records.get(key)!).map((message: { queue_id: string }) => message.queue_id)).toEqual([
            'keep-dm',
            'keep-channel',
        ]);
    });

    it('unblocks only the caller’s side and retains the reverse block in status', async () => {
        backend.rpc.mockResolvedValue({ data: reverse, error: null });
        await expect(ChatService.unblockUser('friend')).resolves.toBe(true);
        await expect(ChatService.isBlocked('friend')).resolves.toBe(true);
    });

    it('rejects a mutation error or a response contradicting the requested action', async () => {
        backend.rpc.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
        await expect(ChatService.blockUser('friend')).resolves.toBe(false);
        backend.rpc.mockResolvedValueOnce({ data: clear, error: null });
        await expect(ChatService.blockUser('friend')).resolves.toBe(false);
    });

    it('rejects stale status and mutation results after an account switch', async () => {
        let resolve!: (value: unknown) => void;
        backend.rpc.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const pending = ChatService.getDMBlockStatus('friend');
        await vi.waitFor(() => expect(backend.rpc).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        resolve({ data: own, error: null });
        await expect(pending).rejects.toThrow('Unable to verify');
    });

    it('does not request caller-scoped state when the remote identity differs', async () => {
        backend.getUser.mockResolvedValue({ data: { user: { id: 'account-b' } }, error: null });
        await expect(ChatService.getDMBlockStatus('friend')).rejects.toThrow('Unable to verify');
        expect(backend.rpc).not.toHaveBeenCalled();
    });

    it('rechecks a cached block online so a later remote unblock is respected', async () => {
        backend.rpc.mockResolvedValueOnce({ data: own, error: null });
        await expect(ChatService.getDMBlockStatus('friend')).resolves.toEqual(own);
        await expect(ChatService.sendDM('friend', 'Allowed after unblock')).resolves.toEqual({ id: 'sent' });
        expect(backend.insert).toHaveBeenCalledOnce();
    });

    it('does not queue a permission denial that races the preflight', async () => {
        backend.insert.mockReturnValue({
            select: () => ({
                single: async () => ({ data: null, error: { code: '42501', message: 'blocked by policy' } }),
            }),
        });
        await expect(ChatService.sendDM('friend', 'Rejected after preflight')).resolves.toBeNull();
        expect(backend.records.size).toBe(0);
    });

    it('rejects self and malformed targets without an RPC', async () => {
        await expect(ChatService.blockUser('account-a')).resolves.toBe(false);
        await expect(ChatService.sendDM('friend),blocked_id.neq.x', 'bad target')).resolves.toBeNull();
        expect(backend.rpc).not.toHaveBeenCalled();
    });

    it.each(['blocked', '42501', '23514', '23503'])(
        'cancels queued DMs permanently without a delivered event (%s)',
        async (reason) => {
            const key = authScopedStorageKey('chat_offline_queue', getAuthIdentityScope());
            backend.records.set(
                key,
                JSON.stringify([
                    {
                        queue_id: 'cancel',
                        owner_user_id: 'account-a',
                        type: 'dm',
                        recipient_id: 'friend',
                        message: 'queued',
                        timestamp: new Date().toISOString(),
                    },
                ]),
            );
            if (reason === 'blocked') backend.rpc.mockResolvedValueOnce({ data: reverse, error: null });
            else
                backend.insert.mockReturnValue({
                    select: () => ({
                        single: async () => ({ data: null, error: { code: reason, message: 'denied' } }),
                    }),
                });
            const delivered = vi.fn();
            window.addEventListener('thalassa:queued-dm-sent', delivered);
            try {
                const internal = ChatService as unknown as { syncOfflineQueue(): Promise<number> };
                await expect(internal.syncOfflineQueue()).resolves.toBe(0);
                expect(backend.records.has(key)).toBe(false);
                expect(delivered).not.toHaveBeenCalled();
                backend.rpc.mockResolvedValue({ data: clear, error: null });
                const insertsBefore = backend.insert.mock.calls.length;
                await expect(internal.syncOfflineQueue()).resolves.toBe(0);
                expect(backend.insert).toHaveBeenCalledTimes(insertsBefore);
            } finally {
                window.removeEventListener('thalassa:queued-dm-sent', delivered);
            }
        },
    );

    it('does not revive a failed in-flight send after block then unblock', async () => {
        let resolveInsert!: (value: unknown) => void;
        backend.insert.mockReturnValue({
            select: () => ({
                single: () =>
                    new Promise((resolve) => {
                        resolveInsert = resolve;
                    }),
            }),
        });
        const sending = ChatService.sendDM('friend', 'Old send must stay cancelled');
        await vi.waitFor(() => expect(backend.insert).toHaveBeenCalledOnce());
        backend.rpc.mockResolvedValueOnce({ data: own, error: null });
        await expect(ChatService.blockUser('friend')).resolves.toBe(true);
        backend.rpc.mockResolvedValueOnce({ data: clear, error: null });
        await expect(ChatService.unblockUser('friend')).resolves.toBe(true);
        resolveInsert({ data: null, error: { message: 'transport lost' } });
        await expect(sending).resolves.toBeNull();
        expect(backend.records.size).toBe(0);
    });

    it('cannot overwrite a new block with an older status response', async () => {
        let resolveStatus!: (value: unknown) => void;
        backend.rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        const pending = ChatService.getDMBlockStatus('friend');
        await vi.waitFor(() => expect(backend.rpc).toHaveBeenCalledOnce());
        backend.rpc.mockResolvedValueOnce({ data: own, error: null });
        await expect(ChatService.blockUser('friend')).resolves.toBe(true);
        resolveStatus({ data: clear, error: null });
        await expect(pending).rejects.toThrow('Unable to verify');
        expect((ChatService as unknown as { dmBlockStatus: Map<string, unknown> }).dmBlockStatus.get('friend')).toEqual(
            own,
        );
    });

    it('preserves a confirmed delivery that completed while blocking was pending', async () => {
        let resolveInsert!: (value: unknown) => void;
        backend.insert.mockReturnValue({
            select: () => ({
                single: () =>
                    new Promise((resolve) => {
                        resolveInsert = resolve;
                    }),
            }),
        });
        const sending = ChatService.sendDM('friend', 'Already in flight');
        await vi.waitFor(() => expect(backend.insert).toHaveBeenCalledOnce());
        backend.rpc.mockResolvedValueOnce({ data: own, error: null });
        await expect(ChatService.blockUser('friend')).resolves.toBe(true);
        resolveInsert({ data: { id: 'confirmed-in-flight' }, error: null });
        await expect(sending).resolves.toEqual({ id: 'confirmed-in-flight' });
        expect(backend.records.size).toBe(0);
    });

    it('rejects stale status that started during a pending block mutation', async () => {
        let resolveBlock!: (value: unknown) => void;
        let resolveStatus!: (value: unknown) => void;
        backend.rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveBlock = resolve;
                }),
        );
        const blocking = ChatService.blockUser('friend');
        await vi.waitFor(() => expect(backend.rpc).toHaveBeenCalledOnce());
        backend.rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        const status = ChatService.getDMBlockStatus('friend');
        await vi.waitFor(() => expect(backend.rpc).toHaveBeenCalledTimes(2));
        resolveBlock({ data: own, error: null });
        await expect(blocking).resolves.toBe(true);
        resolveStatus({ data: clear, error: null });
        await expect(status).rejects.toThrow('Unable to verify');
        expect((ChatService as unknown as { dmBlockStatus: Map<string, unknown> }).dmBlockStatus.get('friend')).toEqual(
            own,
        );
    });
});
