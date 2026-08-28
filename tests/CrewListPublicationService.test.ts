import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setAuthIdentityScope } from '../services/authIdentityScope';

const supabaseMocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: supabaseMocks.getUser },
        functions: { invoke: supabaseMocks.invoke },
    },
}));

import { LonelyHeartsService } from '../services/LonelyHeartsService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('Crew List publication service', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.clearAllMocks();
        supabaseMocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });
    });

    it.each(['published', 'manual_review'] as const)('accepts the authoritative %s outcome', async (outcome) => {
        supabaseMocks.invoke.mockResolvedValue({ data: { outcome }, error: null });

        await expect(LonelyHeartsService.submitCrewProfileForReview()).resolves.toBe(true);
        expect(supabaseMocks.invoke).toHaveBeenCalledWith('crew-profile-publication', {
            body: { action: 'submit' },
        });
    });

    it('rejects malformed, unknown, and Edge-error responses', async () => {
        supabaseMocks.invoke
            .mockResolvedValueOnce({ data: { outcome: 'approved' }, error: null })
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: { outcome: 'published' }, error: new Error('edge unavailable') });

        await expect(LonelyHeartsService.submitCrewProfileForReview()).resolves.toBe(false);
        await expect(LonelyHeartsService.submitCrewProfileForReview()).resolves.toBe(false);
        await expect(LonelyHeartsService.submitCrewProfileForReview()).resolves.toBe(false);
    });

    it('drops a publication response if the signed-in identity changes while it is in flight', async () => {
        const pending = deferred<{ data: { outcome: string }; error: null }>();
        supabaseMocks.invoke.mockReturnValueOnce(pending.promise);

        const publication = LonelyHeartsService.submitCrewProfileForReview();
        await vi.waitFor(() => expect(supabaseMocks.invoke).toHaveBeenCalledTimes(1));
        setAuthIdentityScope('account-b');
        pending.resolve({ data: { outcome: 'published' }, error: null });

        await expect(publication).resolves.toBe(false);
    });
});
