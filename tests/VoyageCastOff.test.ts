import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const harness = vi.hoisted(() => ({
    rpc: vi.fn(),
    getUser: vi.fn(),
    startLeg: vi.fn(),
    getActiveLeg: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: harness.getUser,
        },
        rpc: harness.rpc,
    },
}));

vi.mock('../services/VoyageLegService', () => ({
    startLeg: harness.startLeg,
    getActiveLeg: harness.getActiveLeg,
    closeLeg: vi.fn(),
    deleteLegsForVoyage: vi.fn(),
}));

import { castOff, startVoyage, type Voyage } from '../services/VoyageService';

const voyage: Voyage = {
    id: '00000000-0000-4000-8000-000000000101',
    user_id: '00000000-0000-4000-8000-000000000201',
    vessel_id: null,
    voyage_name: 'Brisbane to Noumea',
    departure_port: 'Brisbane',
    destination_port: 'Noumea',
    departure_time: '2026-07-23T01:00:00.000Z',
    eta: null,
    crew_count: 4,
    status: 'active',
    weather_master_id: '00000000-0000-4000-8000-000000000201',
    notes: null,
    created_at: '2026-07-22T01:00:00.000Z',
    updated_at: '2026-07-23T01:00:00.000Z',
    manifest_locked_at: '2026-07-23T01:00:00.000Z',
};

describe('VoyageService atomic Cast Off', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope(voyage.user_id);
        vi.clearAllMocks();
        harness.getUser.mockResolvedValue({
            data: { user: { id: voyage.user_id } },
            error: null,
        });
        harness.rpc.mockResolvedValue({ data: voyage, error: null });
        harness.getActiveLeg.mockReturnValue(null);
    });

    it('starts a voyage through the owner-only Cast Off RPC and caches its result', async () => {
        const result = await startVoyage(voyage.id);

        expect(harness.rpc).toHaveBeenCalledWith('cast_off_voyage', {
            p_voyage_id: voyage.id,
        });
        expect(result).toEqual(voyage);
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_active_voyage')) || 'null')).toEqual(
            voyage,
        );
    });

    it('creates Leg 1 after the atomic server transaction succeeds', async () => {
        const result = await castOff(voyage.id);

        expect(result).toEqual({ ok: true, voyage });
        expect(harness.startLeg).toHaveBeenCalledTimes(1);
        expect(harness.startLeg).toHaveBeenCalledWith(voyage.id, 'Brisbane');
    });

    it('does not create a duplicate leg when Cast Off is retried after response loss', async () => {
        harness.getActiveLeg
            .mockReturnValueOnce(null)
            .mockReturnValueOnce({ id: 'existing-leg', voyage_id: voyage.id, status: 'active' });

        await castOff(voyage.id);
        await castOff(voyage.id);

        expect(harness.rpc).toHaveBeenCalledTimes(2);
        expect(harness.startLeg).toHaveBeenCalledTimes(1);
    });

    it('surfaces the server conflict without creating a leg', async () => {
        harness.rpc.mockResolvedValue({
            data: null,
            error: { message: '"Sydney to Hobart" is already active. End it first.' },
        });

        const result = await castOff(voyage.id);

        expect(result).toEqual({
            ok: false,
            error: '"Sydney to Hobart" is already active. End it first.',
        });
        expect(harness.startLeg).not.toHaveBeenCalled();
    });

    it('rejects an RPC row that does not match the captured owner and voyage', async () => {
        harness.rpc.mockResolvedValue({
            data: {
                ...voyage,
                id: '00000000-0000-4000-8000-000000000999',
                user_id: '00000000-0000-4000-8000-000000000998',
            },
            error: null,
        });

        const result = await castOff(voyage.id);

        expect(result.ok).toBe(false);
        expect(harness.startLeg).not.toHaveBeenCalled();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_active_voyage'))).toBeNull();
    });

    it('discards a Cast Off response that resolves after an account switch', async () => {
        const ownerScope = getAuthIdentityScope();
        let resolveRpc!: (value: { data: Voyage; error: null }) => void;
        harness.rpc.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRpc = resolve;
            }),
        );

        const pending = startVoyage(voyage.id);
        await vi.waitFor(() => expect(harness.rpc).toHaveBeenCalledTimes(1));
        setAuthIdentityScope('different-account');
        resolveRpc({ data: voyage, error: null });

        expect(await pending).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_active_voyage', ownerScope))).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_active_voyage'))).toBeNull();
    });
});
