import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: mocks.getUser,
        },
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

import { getMyCrew, removeCrew } from '../services/CrewService';

interface QueryResult {
    data: unknown;
    error: null | { message: string; code?: string };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function queryFor(result: Promise<QueryResult>) {
    const query = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        eq: vi.fn(),
        is: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        contains: vi.fn(),
        single: vi.fn(() => result),
        maybeSingle: vi.fn(() => result),
        then: (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
            result.then(resolve, reject),
    };
    query.select.mockReturnValue(query);
    query.insert.mockReturnValue(query);
    query.update.mockReturnValue(query);
    query.delete.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.is.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.contains.mockReturnValue(query);
    return query;
}

describe('CrewService auth identity fencing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a', email: 'a@example.com' } },
            error: null,
        });
    });

    it('discards a deferred account-A roster after the identity moves to B', async () => {
        const database = deferred<QueryResult>();
        const query = queryFor(database.promise);
        mocks.from.mockReturnValue(query);

        const pending = getMyCrew();
        await vi.waitFor(() => expect(query.eq).toHaveBeenCalledWith('owner_id', 'account-a'));
        setAuthIdentityScope('account-b');
        database.resolve({
            data: [{ id: 'a-private-row', owner_id: 'account-a' }],
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
    });

    it('rejects a mutable Supabase user that no longer matches the captured scope', async () => {
        const auth = deferred<{
            data: { user: { id: string; email: string } };
            error: null;
        }>();
        mocks.getUser.mockReturnValue(auth.promise);

        const pending = getMyCrew();
        setAuthIdentityScope('account-b');
        auth.resolve({
            data: { user: { id: 'account-b', email: 'b@example.com' } },
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('pins a remove mutation to the initiating captain and reports stale completion as failure', async () => {
        const database = deferred<QueryResult>();
        const query = queryFor(database.promise);
        mocks.from.mockReturnValue(query);

        const pending = removeCrew('crew-row-a');
        await vi.waitFor(() => {
            expect(query.eq).toHaveBeenCalledWith('id', 'crew-row-a');
            expect(query.eq).toHaveBeenCalledWith('owner_id', 'account-a');
        });
        setAuthIdentityScope('account-b');
        database.resolve({ data: null, error: null });

        await expect(pending).resolves.toBe(false);
        expect(query.eq).not.toHaveBeenCalledWith('owner_id', 'account-b');
    });
});
