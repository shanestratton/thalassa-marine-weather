import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../services/supabase', () => ({ supabase: db }));
import {
    listDiaryGuestComments,
    listPendingDiaryCommentCounts,
    moderateDiaryGuestComment,
    subscribeDiaryCommentChanges,
} from '../services/DiaryCommentService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const rows = [{ id: 'one', status: 'approved', reviewed_by: 'old-owner' }];
let query: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    in: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    or: ReturnType<typeof vi.fn>;
    range: ReturnType<typeof vi.fn>;
    abortSignal: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
    setAuthIdentityScope('owner');
    query = {
        select: vi.fn(),
        eq: vi.fn(),
        in: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        or: vi.fn(),
        range: vi.fn(),
        abortSignal: vi.fn(),
    };
    for (const key of ['select', 'eq', 'in', 'order', 'or', 'abortSignal'] as const) query[key].mockReturnValue(query);
    query.limit.mockResolvedValue({ data: rows, error: null });
    query.range.mockResolvedValue({ data: [], error: null });
    db.from.mockReset().mockReturnValue(query);
    db.rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
describe('diary comment owner service', () => {
    it('prioritizes pending rows and reopens prior-owner approvals for the new skipper', async () => {
        expect(await listDiaryGuestComments('entry')).toMatchObject([{ id: 'one', status: 'pending' }]);
        expect(query.order.mock.calls).toEqual([
            ['status', { ascending: false }],
            ['created_at', { ascending: false }],
        ]);
        expect(query.limit).toHaveBeenCalledWith(200);
        expect(query.eq).toHaveBeenCalledWith('entry_id', 'entry');
    });
    it('does not expose a response across identity changes', async () => {
        let finish!: (value: unknown) => void;
        query.limit.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const pending = listDiaryGuestComments('entry');
        setAuthIdentityScope('other');
        finish({ data: rows, error: null });
        await expect(pending).rejects.toThrow('Account changed');
    });
    it('requires explicit server confirmation instead of treating revoked permission as success', async () => {
        db.rpc.mockResolvedValue({ data: false, error: null });
        await expect(moderateDiaryGuestComment('one', 'approve')).rejects.toThrow('Only the public-log owner');
        expect(db.rpc).toHaveBeenCalledWith('moderate_diary_guest_comment', {
            p_comment_id: 'one',
            p_action: 'approve',
        });
    });
    it('does not request private rows or mutation while signed out', async () => {
        setAuthIdentityScope(null);
        await expect(listDiaryGuestComments('entry')).rejects.toThrow('Sign in');
        await expect(moderateDiaryGuestComment('one', 'reject')).rejects.toThrow('Sign in');
        await expect(listPendingDiaryCommentCounts(['entry'], new AbortController().signal)).rejects.toThrow('Sign in');
        expect(db.from).not.toHaveBeenCalled();
        expect(db.rpc).not.toHaveBeenCalled();
    });
    it('counts only reviewable metadata in a batch, excluding offline IDs and duplicate rows', async () => {
        query.range.mockResolvedValue({
            data: [
                { id: 'a', entry_id: 'entry-1' },
                { id: 'b', entry_id: 'entry-1' },
                { id: 'b', entry_id: 'entry-1' },
                { id: 'c', entry_id: 'entry-2' },
                { id: 'outside', entry_id: 'not-requested' },
            ],
            error: null,
        });
        const signal = new AbortController().signal;
        expect(await listPendingDiaryCommentCounts(['entry-1', 'entry-2', 'entry-1', 'offline-one'], signal)).toEqual({
            'entry-1': 2,
            'entry-2': 1,
        });
        expect(db.from).toHaveBeenCalledOnce();
        expect(query.select).toHaveBeenCalledExactlyOnceWith('id, entry_id');
        expect(query.in).toHaveBeenCalledWith('entry_id', ['entry-1', 'entry-2']);
        expect(query.in).toHaveBeenCalledWith('status', ['pending', 'approved']);
        expect(query.or).toHaveBeenCalledWith('status.eq.pending,reviewed_by.is.null,reviewed_by.neq.owner');
        expect(query.abortSignal).toHaveBeenCalledWith(signal);
    });
    it('paginates counts beyond one response and batches long ID lists', async () => {
        query.range
            .mockResolvedValueOnce({
                data: Array.from({ length: 500 }, (_, i) => ({ id: `c-${i}`, entry_id: 'entry-0' })),
                error: null,
            })
            .mockResolvedValueOnce({ data: [{ id: 'last', entry_id: 'entry-1' }], error: null })
            .mockResolvedValueOnce({ data: [{ id: 'other-batch', entry_id: 'entry-100' }], error: null });
        expect(
            await listPendingDiaryCommentCounts(
                Array.from({ length: 101 }, (_, i) => `entry-${i}`),
                new AbortController().signal,
            ),
        ).toEqual({ 'entry-0': 500, 'entry-1': 1, 'entry-100': 1 });
        expect(query.range.mock.calls).toEqual([
            [0, 499],
            [500, 999],
            [0, 499],
        ]);
        expect(query.in).toHaveBeenLastCalledWith('status', ['pending', 'approved']);
        expect(query.in).toHaveBeenCalledWith('entry_id', ['entry-100']);
    });
    it('does not turn a failed count request into an empty successful queue', async () => {
        query.range.mockResolvedValue({ data: null, error: { message: 'offline' } });
        await expect(listPendingDiaryCommentCounts(['entry'], new AbortController().signal)).rejects.toThrow(
            'Comment checks unavailable',
        );
    });
    it('ignores count results from a previous identity', async () => {
        let finish!: (value: unknown) => void;
        query.range.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const pending = listPendingDiaryCommentCounts(['entry'], new AbortController().signal);
        setAuthIdentityScope('other');
        finish({ data: [{ id: 'old', entry_id: 'entry' }], error: null });
        await expect(pending).rejects.toThrow('Account changed');
    });
    it('does not request counts for an empty or offline-only diary', async () => {
        expect(await listPendingDiaryCommentCounts(['offline-one'], new AbortController().signal)).toEqual({});
        expect(db.from).not.toHaveBeenCalled();
    });
    it('only notifies badge subscribers after the server confirms moderation', async () => {
        const onChange = vi.fn();
        const unsubscribe = subscribeDiaryCommentChanges(onChange);
        try {
            db.rpc.mockResolvedValueOnce({ data: false, error: null });
            await expect(moderateDiaryGuestComment('one', 'approve')).rejects.toThrow();
            expect(onChange).not.toHaveBeenCalled();
            await moderateDiaryGuestComment('one', 'reject');
            expect(onChange).toHaveBeenCalledOnce();
        } finally {
            unsubscribe();
        }
        await moderateDiaryGuestComment('one', 'approve');
        expect(onChange).toHaveBeenCalledOnce();
    });
});
