import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const harness = vi.hoisted(() => ({
    rpc: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    preflightMaybeSingle: vi.fn(),
    startLeg: vi.fn(),
    getActiveLeg: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: harness.getUser,
        },
        rpc: harness.rpc,
        from: harness.from,
    },
}));

vi.mock('../services/VoyageLegService', () => ({
    startLeg: harness.startLeg,
    getActiveLeg: harness.getActiveLeg,
    closeLeg: vi.fn(),
    deleteLegsForVoyage: vi.fn(),
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { vessel: { draft: 1.8 * 3.28084, estimatedFields: [] } } }),
    },
}));

vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => 'AU5@1@2026-01-01@100@cloud-local',
}));

import { castOff, startVoyage, type Voyage } from '../services/VoyageService';
import { evaluateTraceRelease, serialiseTraceVerificationNote } from '../services/traceVerification';

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
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = harness.preflightMaybeSingle;
        harness.from.mockReturnValue(query);
        harness.preflightMaybeSingle.mockResolvedValue({
            data: { ...voyage, status: 'planning', manifest_locked_at: null },
            error: null,
        });
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
        expect(harness.startLeg).toHaveBeenCalledWith(voyage.id, 'Brisbane', null);
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

    it.each(['startVoyage', 'castOff'] as const)(
        'traced-route drift is an advisory caution, never a refusal, through %s',
        async (api) => {
            const now = Date.now();
            const points = [
                { lat: -27.471, lon: 153.024 },
                { lat: -27.57, lon: 153.1 },
            ];
            const verification = evaluateTraceRelease(
                points,
                'ready',
                [
                    {
                        grade: 'clear',
                        issues: [],
                        minDepthM: 8,
                        minAt: points[1],
                        needsTide: false,
                        nudge: null,
                        nudgeTo: null,
                    },
                ],
                new Set(),
                {
                    draftM: 1.8,
                    draftAssumed: false,
                    encRegistryVersion: 1,
                    encRegistryFingerprint: 'AU5@1@2026-01-01@100@cloud-local',
                    departureMs: now,
                    tideWindowLabel: '',
                },
                new Date(now).toISOString(),
            ).verification!;
            const planning = {
                ...voyage,
                status: 'planning' as const,
                departure_time: new Date(now).toISOString(),
                manifest_locked_at: null,
                saved_route_id: 'trace-exact',
                notes: serialiseTraceVerificationNote(verification),
            };
            const active = { ...planning, status: 'active' as const, manifest_locked_at: new Date(now).toISOString() };
            const queryFor = (result: unknown) => {
                const query: Record<string, ReturnType<typeof vi.fn>> = {};
                query.select = vi.fn(() => query);
                query.eq = vi.fn(() => query);
                query.maybeSingle = vi.fn().mockResolvedValue({ data: result, error: null });
                return query;
            };
            harness.from.mockImplementation((table: string) =>
                table === 'saved_routes'
                    ? queryFor({
                          id: 'trace-exact',
                          user_id: voyage.user_id,
                          points: points.map((p) => [p.lat, p.lon]),
                          deleted: false,
                      })
                    : queryFor(planning),
            );
            harness.rpc.mockResolvedValue({ data: active, error: null });

            if (api === 'startVoyage') {
                expect(await startVoyage(voyage.id)).toEqual(active);
            } else {
                const clean = await castOff(voyage.id);
                expect(clean).toMatchObject({ ok: true, voyage: active });
                // A healthy check must not nag — the advisory only exists
                // when there is genuinely something to say.
                expect(clean.caution).toBeUndefined();
            }
            expect(harness.rpc).toHaveBeenCalledOnce();

            harness.rpc.mockClear();
            harness.from.mockImplementation((table: string) =>
                table === 'saved_routes'
                    ? queryFor({
                          id: 'trace-exact',
                          user_id: voyage.user_id,
                          points: [
                              [-27.0, 153.0],
                              [-27.1, 153.1],
                          ],
                          deleted: false,
                      })
                    : queryFor(planning),
            );
            // Advisory, not a gate (Shane 2026-08-26: "allow it through
            // first, then we will put the gates on"): drifted geometry still
            // casts off — the RPC runs and the reason rides along as caution.
            harness.rpc.mockResolvedValue({ data: active, error: null });
            if (api === 'startVoyage') {
                expect(await startVoyage(voyage.id)).toEqual(active);
            } else {
                expect(await castOff(voyage.id)).toMatchObject({
                    ok: true,
                    voyage: active,
                    caution: expect.stringMatching(/current waypoints/i),
                });
            }
            expect(harness.rpc).toHaveBeenCalledOnce();
        },
    );
});
