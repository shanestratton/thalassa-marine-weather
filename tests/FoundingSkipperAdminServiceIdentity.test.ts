import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const harness = vi.hoisted(() => ({
    getUser: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: harness.getUser },
        rpc: harness.rpc,
    },
}));

import { FoundingSkipperAdminService } from '../services/FoundingSkipperAdminService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const row = {
    id: '1b29ebd3-95be-4738-90be-c82b6acde44d',
    name: 'Shane Stratton',
    email: 'shane.stratton@gmail.com',
    boat_type: 'sail_monohull',
    home_waters: 'Moreton Bay',
    apple_device: 'iphone_and_ipad',
    boating_frequency: 'weekly_plus',
    interests: ['marine_weather'],
    notes: null,
    source: 'personal-email',
    consent_version: 'founding-skippers-v1',
    consented_at: '2026-08-25T10:37:11.807Z',
    status: 'new',
    status_updated_at: null,
    status_updated_by: null,
    created_at: '2026-08-25T10:37:11.807Z',
    expires_at: '2027-02-21T10:37:11.807Z',
};

describe('FoundingSkipperAdminService identity boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        harness.getUser.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
    });

    it('calls only the bounded admin RPC and parses valid rows', async () => {
        harness.rpc.mockResolvedValue({ data: [row], error: null });

        const page = await FoundingSkipperAdminService.list({ status: 'new', limit: 50 });

        expect(page.applications).toEqual([row]);
        expect(page.nextCursor).toBeNull();
        expect(harness.rpc).toHaveBeenCalledWith('list_founding_skipper_applications', {
            p_status: 'new',
            p_before_created_at: null,
            p_before_id: null,
            p_limit: 50,
        });
    });

    it('drops a deferred account-A result after the identity fence moves to B', async () => {
        const result = deferred<{ data: unknown[]; error: null }>();
        harness.rpc.mockReturnValue(result.promise);

        const pending = FoundingSkipperAdminService.list();
        await vi.waitFor(() => expect(harness.rpc).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        result.resolve({ data: [row], error: null });

        await expect(pending).rejects.toMatchObject({
            code: 'identity_changed',
        });
    });

    it('rejects a mismatched authenticated user before requesting private rows', async () => {
        harness.getUser.mockResolvedValue({ data: { user: { id: 'account-b' } }, error: null });

        await expect(FoundingSkipperAdminService.list()).rejects.toMatchObject({
            code: 'identity_changed',
        });
        expect(harness.rpc).not.toHaveBeenCalled();
    });

    it('fails the whole page closed when an RPC row is malformed', async () => {
        harness.rpc.mockResolvedValue({
            data: [
                { ...row, email: { hostile: true } },
                { ...row, id: 'not-a-uuid' },
            ],
            error: null,
        });

        await expect(FoundingSkipperAdminService.list()).rejects.toMatchObject({
            code: 'load_failed',
        });
    });

    it('distinguishes capability outages from a normal non-reviewer result', async () => {
        harness.rpc.mockResolvedValueOnce({ data: null, error: { code: '503', message: 'network unavailable' } });
        await expect(FoundingSkipperAdminService.canReview()).rejects.toMatchObject({
            code: 'load_failed',
        });

        harness.rpc.mockResolvedValueOnce({ data: false, error: null });
        await expect(FoundingSkipperAdminService.canReview()).resolves.toBe(false);
    });

    it('uses an expected-current-status compare-and-set review call', async () => {
        harness.rpc.mockResolvedValue({ data: true, error: null });

        await FoundingSkipperAdminService.review(row.id, 'new', 'contacted');

        expect(harness.rpc).toHaveBeenCalledWith('review_founding_skipper_application', {
            p_application_id: row.id,
            p_expected_status: 'new',
            p_status: 'contacted',
        });
    });
});
