/**
 * Crew read the skipper's watch bill BY NAME (20261003140000).
 *
 * After that migration a crew member's raw read holds only their OWN assigned
 * rows (or nothing), so the service asks get_crew_watch_bill instead: per
 * watch, whether it is assigned, whether it is yours, and the person's name
 * parts. Never an email or a user id. A raw read with a row this account
 * assigned, or a row that is not its own, is the skipper's (or crew's before
 * the push) and stands with no crew read. Before the push the function is
 * missing (PGRST202 / 42883) and the raw read stands, quietly.
 *
 * Fictional people and passages only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope, type AuthIdentityScope } from '../services/authIdentityScope';

const h = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: h.getUser },
        from: h.from,
        rpc: h.rpc,
        channel: h.channel,
        removeChannel: h.removeChannel,
    },
}));

import { WatchAssignmentService, type WatchAssignment } from '../services/WatchAssignmentService';
import { isOwnWatch, isWatchAssigned } from '../services/watchAssignee';

const VOYAGE_ID = '00000000-0000-4000-8000-00000000a001';

function rawRow(index: number, email: string | null, name: string | null): WatchAssignment {
    return {
        id: `row-${index}`,
        voyage_id: VOYAGE_ID,
        watch_index: index,
        watch_label: `Watch ${index + 1}`,
        watch_time_label: '0000–0400',
        assigned_crew_email: email,
        assigned_crew_name: name,
        assigned_crew_user_id: email ? `user-${index}` : null,
        assigned_at: '2026-10-01T00:00:00.000Z',
        assigned_by: 'skipper-1',
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
    };
}

/** A row the crew member's own-rows read returns: assigned to crew-1 by the skipper. */
function ownRow(index: number, fields: Partial<WatchAssignment> = {}): WatchAssignment {
    return {
        ...rawRow(index, 'tom@example.com', 'tom'),
        assigned_crew_user_id: 'crew-1',
        ...fields,
    };
}

function tableQuery(result: { data: WatchAssignment[] | null; error: { message: string } | null }) {
    const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockResolvedValue(result);
    return query;
}

const BILL = {
    version: 1,
    watches: [
        { watchIndex: 0, watchLabel: 'First Watch', watchTimeLabel: '2000–0000', assigned: true, isSelf: true },
        {
            watchIndex: 1,
            watchLabel: 'Middle Watch',
            watchTimeLabel: '0000–0400',
            assigned: true,
            isSelf: false,
            prefix: 'Capt',
            firstName: 'Ana',
            nickname: 'Skip',
            lastName: 'Reyes',
        },
        { watchIndex: 2, watchLabel: 'Morning Watch', watchTimeLabel: '0400–0800', assigned: true, isSelf: false },
        { watchIndex: 3, watchLabel: 'Forenoon Watch', watchTimeLabel: '0800–1200', assigned: false, isSelf: false },
    ],
};

function cacheKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(`thalassa_watch_assignments_${VOYAGE_ID}`, scope);
}

describe('WatchAssignmentService on a passage you crew on', () => {
    let scope: AuthIdentityScope;

    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        vi.clearAllMocks();
        scope = setAuthIdentityScope('crew-1');
        h.getUser.mockResolvedValue({ data: { user: { id: 'crew-1', email: 'tom@example.com' } }, error: null });
    });

    it("the skipper's own rows come straight from the table, with no crew read", async () => {
        h.from.mockReturnValue(tableQuery({ data: [rawRow(0, 'lena@example.com', 'Lena')], error: null }));
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.assigned_crew_email)).toEqual(['lena@example.com']);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it("a row this account assigned is the skipper's read, even when every watch is his own", async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0, { assigned_by: 'crew-1' })], error: null }));
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.assigned_crew_email)).toEqual(['tom@example.com']);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('after the push: your own rows alone mean crew, so the bill is read by name', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0)], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });

        const rows = await WatchAssignmentService.list(VOYAGE_ID);

        expect(h.rpc).toHaveBeenCalledWith('get_crew_watch_bill', { p_voyage_id: VOYAGE_ID });
        expect(rows.map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
        expect(rows.map((row) => row.assigned_crew_name)).toEqual([null, 'Capt Ana "Skip" Reyes', null, null]);
        expect(JSON.stringify(rows)).not.toMatch(/@|crew-1|skipper-1/);
    });

    it('an own row matched by your address alone (no user id on it) is still crew', async () => {
        h.from.mockReturnValue(
            tableQuery({
                data: [ownRow(0, { assigned_crew_email: ' TOM@example.com', assigned_crew_user_id: null })],
                error: null,
            }),
        );
        h.rpc.mockResolvedValue({ data: BILL, error: null });
        expect((await WatchAssignmentService.list(VOYAGE_ID)).map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
        expect(h.rpc).toHaveBeenCalledTimes(1);
    });

    it('after the push: reads the bill by name, never an email or a user id', async () => {
        h.from.mockReturnValue(tableQuery({ data: [], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });

        const rows = await WatchAssignmentService.list(VOYAGE_ID);

        expect(h.rpc).toHaveBeenCalledWith('get_crew_watch_bill', { p_voyage_id: VOYAGE_ID });
        expect(rows.map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
        expect(rows.map((row) => row.watch_time_label)).toEqual(['2000–0000', '0000–0400', '0400–0800', '0800–1200']);
        expect(rows.map(isWatchAssigned)).toEqual([true, true, true, false]);
        expect(rows.map((row) => isOwnWatch(row, { userId: 'crew-1' }))).toEqual([true, false, false, false]);
        expect(rows.map((row) => row.assigned_crew_name)).toEqual([null, 'Capt Ana "Skip" Reyes', null, null]);
        for (const row of rows) {
            expect(row.assigned_crew_email).toBeNull();
            expect(row.assigned_crew_user_id ?? null).toBeNull();
            expect(row.assigned_by).toBeNull();
        }
        expect(JSON.stringify(rows)).not.toMatch(/@|crew-1|skipper-1/);

        // Cached for the watch at sea, still without an email.
        const cached = JSON.parse(localStorage.getItem(cacheKey(scope)) || '[]') as WatchAssignment[];
        expect(cached).toHaveLength(4);
        expect(JSON.stringify(cached)).not.toMatch(/@/);
    });

    it('keeps only the allow-list even if the server sent more', async () => {
        h.from.mockReturnValue(tableQuery({ data: [], error: null }));
        h.rpc.mockResolvedValue({
            data: {
                version: 1,
                watches: [
                    {
                        watchIndex: 0,
                        watchLabel: 'First Watch',
                        watchTimeLabel: '2000–0000',
                        assigned: true,
                        isSelf: false,
                        email: 'tom@example.com',
                        userId: 'user-7',
                        firstName: 'Tom',
                    },
                    { watchIndex: 0, watchLabel: 'Duplicate', watchTimeLabel: '2000–0000', assigned: true },
                    { watchIndex: -1, watchLabel: 'Bad', watchTimeLabel: '2000–0000', assigned: true },
                    { watchIndex: 1.5, watchLabel: 'Bad', watchTimeLabel: '2000–0000', assigned: true },
                    { watchIndex: 2, watchLabel: '', watchTimeLabel: '2000–0000', assigned: true },
                    'not a watch',
                ],
            },
            error: null,
        });

        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ watch_index: 0, watch_label: 'First Watch', assigned_crew_name: 'Tom' });
        expect(JSON.stringify(rows)).not.toMatch(/tom@example\.com|user-7/);
    });

    it.each(['PGRST202', '42883'])('before the push (%s): the empty raw read stands, quietly', async (code) => {
        h.from.mockReturnValue(tableQuery({ data: [], error: null }));
        h.rpc.mockResolvedValue({ data: null, error: { code, message: 'function get_crew_watch_bill not found' } });
        expect(await WatchAssignmentService.list(VOYAGE_ID)).toEqual([]);
    });

    it('before the push: a bill that is all yours stands as the raw read', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0), ownRow(1)], error: null }));
        h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.watch_index)).toEqual([0, 1]);
        expect(rows.every((row) => isOwnWatch(row, { userId: 'crew-1' }))).toBe(true);
        expect(JSON.parse(localStorage.getItem(cacheKey(scope)) || '[]')).toHaveLength(2);
    });

    it('not crew on that passage (NULL): nothing, and the cache is emptied', async () => {
        localStorage.setItem(cacheKey(scope), JSON.stringify([rawRow(0, 'lena@example.com', 'Lena')]));
        h.from.mockReturnValue(tableQuery({ data: [], error: null }));
        h.rpc.mockResolvedValue({ data: null, error: null });
        expect(await WatchAssignmentService.list(VOYAGE_ID)).toEqual([]);
        expect(JSON.parse(localStorage.getItem(cacheKey(scope)) || '[]')).toEqual([]);
    });

    it('a failed crew read keeps the cached bill, so an alarm is not dropped on a bad signal', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0)], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });
        await WatchAssignmentService.list(VOYAGE_ID);

        h.rpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
        expect(rows.map((row) => isOwnWatch(row, { userId: 'crew-1' }))).toEqual([true, false, false, false]);
        expect(rows[1].assigned_crew_name).toBe('Capt Ana "Skip" Reyes');
    });

    it('a failed crew read takes your own watches from the fresh raw read, not the cache', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0)], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });
        await WatchAssignmentService.list(VOYAGE_ID);

        // The skipper moved you from the First to the Morning watch.
        h.from.mockReturnValue(tableQuery({ data: [ownRow(2)], error: null }));
        h.rpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.watch_index)).toEqual([1, 2, 3]);
        expect(rows.map((row) => isOwnWatch(row, { userId: 'crew-1' }))).toEqual([false, true, false]);
        // The cache still holds the last bill read by name, never the raw rows.
        expect(JSON.stringify(JSON.parse(localStorage.getItem(cacheKey(scope)) || '[]'))).not.toMatch(/@/);
    });

    it('a lost signal after a good crew read keeps the bill (it is not an account switch)', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0)], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });
        await WatchAssignmentService.list(VOYAGE_ID);

        h.getUser
            .mockResolvedValueOnce({ data: { user: { id: 'crew-1', email: 'tom@example.com' } }, error: null })
            .mockResolvedValueOnce({ data: { user: { id: 'crew-1', email: 'tom@example.com' } }, error: null })
            .mockResolvedValueOnce({ data: { user: null }, error: { message: 'network' } });
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
        expect(isOwnWatch(rows[0], { userId: 'crew-1' })).toBe(true);
    });

    it('a lost signal after the raw read keeps the cached bill', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0)], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });
        await WatchAssignmentService.list(VOYAGE_ID);
        h.rpc.mockClear();

        h.getUser
            .mockResolvedValueOnce({ data: { user: { id: 'crew-1', email: 'tom@example.com' } }, error: null })
            .mockResolvedValueOnce({ data: { user: null }, error: { message: 'network' } });
        const rows = await WatchAssignmentService.list(VOYAGE_ID);
        expect(rows.map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('an unexpected payload keeps the cached bill', async () => {
        h.from.mockReturnValue(tableQuery({ data: [ownRow(0)], error: null }));
        h.rpc.mockResolvedValue({ data: BILL, error: null });
        await WatchAssignmentService.list(VOYAGE_ID);

        h.rpc.mockResolvedValue({ data: { version: 1, watches: 'nope' }, error: null });
        expect((await WatchAssignmentService.list(VOYAGE_ID)).map((row) => row.watch_index)).toEqual([0, 1, 2, 3]);
    });

    it('a crew read that lands after an account switch is discarded, never cached', async () => {
        h.from.mockReturnValue(tableQuery({ data: [], error: null }));
        let resolveRpc!: (value: { data: typeof BILL; error: null }) => void;
        h.rpc.mockReturnValue(
            new Promise((resolve) => {
                resolveRpc = resolve;
            }),
        );

        const pending = WatchAssignmentService.list(VOYAGE_ID);
        await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
        const other = setAuthIdentityScope('crew-2');
        resolveRpc({ data: BILL, error: null });

        expect(await pending).toEqual([]);
        expect(localStorage.getItem(cacheKey(scope))).toBeNull();
        expect(localStorage.getItem(cacheKey(other))).toBeNull();
    });
});

describe('whose watch it is', () => {
    const row = (fields: Partial<WatchAssignment>): WatchAssignment => ({ ...rawRow(0, null, null), ...fields });

    it("is the skipper's rule for assigned: an email, or the crew view's flag", () => {
        expect(isWatchAssigned(row({ assigned_crew_email: 'ana@example.com' }))).toBe(true);
        expect(isWatchAssigned(row({ is_assigned: true }))).toBe(true);
        expect(isWatchAssigned(row({}))).toBe(false);
        expect(isWatchAssigned(row({ assigned_crew_email: '' }))).toBe(false);
        expect(isWatchAssigned(null)).toBe(false);
    });

    it('is yours by the crew view, your user id, or your own address', () => {
        expect(isOwnWatch(row({ is_assigned: true, is_self: true }), {})).toBe(true);
        expect(
            isOwnWatch(row({ assigned_crew_email: 'x@example.com', assigned_crew_user_id: 'me' }), { userId: 'me' }),
        ).toBe(true);
        expect(isOwnWatch(row({ assigned_crew_email: ' Me@Example.com ' }), { email: 'me@example.com' })).toBe(true);
        expect(
            isOwnWatch(row({ assigned_crew_email: 'x@example.com' }), { userId: 'me', email: 'me@example.com' }),
        ).toBe(false);
        // An unassigned slot is nobody's, whatever it carries.
        expect(isOwnWatch(row({ is_self: true }), { userId: 'me' })).toBe(false);
        expect(isOwnWatch(row({ assigned_crew_user_id: 'me' }), { userId: 'me' })).toBe(false);
    });
});
