import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getCrewManifestForClearance, getMyProfile, saveProfile, updateProfile } from '../services/CrewProfileService';
import type { CrewProfile } from '../services/CrewProfileService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const profile = (userId: string): CrewProfile => ({
    id: 'profile-a',
    user_id: userId,
    full_name: 'Account A',
    nationality: 'Australian',
    date_of_birth: null,
    passport_number: null,
    passport_expiry: null,
    passport_country: null,
    emergency_name: null,
    emergency_phone: null,
    emergency_relation: null,
    medical_notes: null,
    dietary_notes: null,
    sailing_experience: 'experienced',
    profile_photo_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
});

describe('CrewProfileService identity isolation', () => {
    const from = supabase!.from as ReturnType<typeof vi.fn>;
    const getUser = supabase!.auth.getUser as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });
    });

    it('cannot override the captured owner while saving a profile', async () => {
        const upsert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: profile('account-a'), error: null }),
            }),
        });
        from.mockReturnValue({ upsert });

        await expect(
            saveProfile({
                full_name: 'Account A',
                nationality: 'Australian',
                user_id: 'account-b',
            }),
        ).resolves.toMatchObject({ user_id: 'account-a' });
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                full_name: 'Account A',
                user_id: 'account-a',
            }),
            { onConflict: 'user_id' },
        );
    });

    it('drops a deferred A profile load after switching to B', async () => {
        const load = deferred<{ data: CrewProfile; error: null }>();
        const maybeSingle = vi.fn().mockReturnValue(load.promise);
        const eq = vi.fn().mockReturnValue({ maybeSingle });
        from.mockReturnValue({
            select: vi.fn().mockReturnValue({ eq }),
        });

        const pending = getMyProfile();
        await vi.waitFor(() => expect(maybeSingle).toHaveBeenCalledOnce());
        expect(eq).toHaveBeenCalledWith('user_id', 'account-a');
        setAuthIdentityScope('account-b');
        load.resolve({ data: profile('account-a'), error: null });

        await expect(pending).resolves.toBeNull();
    });

    it('updates by immutable record and owner filters and strips ownership changes', async () => {
        const eq = vi.fn();
        const maybeSingle = vi.fn().mockResolvedValue({ data: profile('account-a'), error: null });
        const select = vi.fn().mockReturnValue({ maybeSingle });
        const query = { eq, select };
        eq.mockImplementation(() => query);
        const update = vi.fn().mockReturnValue(query);
        from.mockReturnValue({ update });

        await expect(
            updateProfile('profile-a', {
                id: 'profile-b',
                user_id: 'account-b',
                full_name: 'Still Account A',
            }),
        ).resolves.toMatchObject({ user_id: 'account-a' });

        expect(update).toHaveBeenCalledWith({
            full_name: 'Still Account A',
        });
        expect(eq).toHaveBeenNthCalledWith(1, 'id', 'profile-a');
        expect(eq).toHaveBeenNthCalledWith(2, 'user_id', 'account-a');
    });

    it('does not expose a deferred A shared manifest to B', async () => {
        const load = deferred<{ data: CrewProfile[]; error: null }>();
        const order = vi.fn().mockReturnValue(load.promise);
        from.mockReturnValue({
            select: vi.fn().mockReturnValue({ order }),
        });

        const pending = getCrewManifestForClearance();
        await vi.waitFor(() => expect(order).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        load.resolve({ data: [profile('account-a')], error: null });

        await expect(pending).resolves.toEqual([]);
    });
});
