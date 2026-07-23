import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    getUser: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: mocks.getUser },
        from: mocks.from,
    },
}));

import { PinService } from '../services/PinService';
import type { SavedPin } from '../services/PinService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('PinService identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });
    });

    it('does not start A work if Supabase authentication resolves after switching to B', async () => {
        const auth = deferred<{ data: { user: { id: string } }; error: null }>();
        mocks.getUser.mockReturnValue(auth.promise);

        const pending = PinService.savePin({
            latitude: -27,
            longitude: 153,
            caption: 'Account A',
        });
        setAuthIdentityScope('account-b');
        auth.resolve({ data: { user: { id: 'account-a' } }, error: null });

        await expect(pending).resolves.toBeNull();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('uses the captured owner in both insert payload and stale-result fence', async () => {
        const insertResult = deferred<{ data: SavedPin; error: null }>();
        const single = vi.fn().mockReturnValue(insertResult.promise);
        const select = vi.fn().mockReturnValue({ single });
        const insert = vi.fn().mockReturnValue({ select });
        mocks.from.mockReturnValue({ insert });

        const pending = PinService.savePin({
            latitude: -27,
            longitude: 153,
            caption: 'Account A',
        });
        await vi.waitFor(() => expect(insert).toHaveBeenCalledOnce());
        expect(insert).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: 'account-a',
                caption: 'Account A',
            }),
        );

        setAuthIdentityScope('account-b');
        insertResult.resolve({
            data: {
                id: 'pin-a',
                user_id: 'account-a',
                latitude: -27,
                longitude: 153,
                caption: 'Account A',
                category: 'general',
                created_at: '2026-01-01T00:00:00.000Z',
            },
            error: null,
        });

        await expect(pending).resolves.toBeNull();
    });

    it('deletes by immutable pin and owner filters', async () => {
        const eq = vi.fn();
        const completion = Promise.resolve({ error: null });
        const query: { eq: ReturnType<typeof vi.fn>; then?: typeof completion.then } = { eq };
        eq.mockImplementation(() => query);
        query.then = completion.then.bind(completion);
        mocks.from.mockReturnValue({
            delete: vi.fn().mockReturnValue(query),
        });

        await expect(PinService.deletePin('pin-a')).resolves.toBe(true);
        expect(eq).toHaveBeenNthCalledWith(1, 'id', 'pin-a');
        expect(eq).toHaveBeenNthCalledWith(2, 'user_id', 'account-a');
    });

    it('drops a deferred A pin list after switching to B', async () => {
        const list = deferred<{ data: SavedPin[]; error: null }>();
        const limit = vi.fn().mockReturnValue(list.promise);
        const order = vi.fn().mockReturnValue({ limit });
        const eq = vi.fn().mockReturnValue({ order });
        const select = vi.fn().mockReturnValue({ eq });
        mocks.from.mockReturnValue({ select });

        const pending = PinService.getMyPins();
        await vi.waitFor(() => expect(limit).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        list.resolve({
            data: [
                {
                    id: 'pin-a',
                    user_id: 'account-a',
                    latitude: -27,
                    longitude: 153,
                    caption: 'Private A pin',
                    category: 'general',
                    created_at: '2026-01-01T00:00:00.000Z',
                },
            ],
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
        expect(eq).toHaveBeenCalledWith('user_id', 'account-a');
    });
});
