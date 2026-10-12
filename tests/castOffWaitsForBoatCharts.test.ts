/**
 * Cast Off just after a relaunch aboard (127-C-c, the stage-3 review): her
 * licensed charts are still opening from the Pi (the registry is 'pending'
 * during the auto-sync's 10 s deferral and the index fetch). A route checked
 * on them yesterday must not be told "recheck there" while the skipper IS
 * there: Cast Off waits for the registry, bounded, before it compares the
 * chart fingerprint. Still not open after the wait: the boat words, as before.
 *
 * Fictional boat, OC-99-ZZ… licensed id and a NOAA-shaped US5ZZ… open one,
 * in a synthetic box off Papeete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const ABOARD = 'OC-99-ZZ0001@4@2026-01-01@2000|US5ZZ01M@2@2026-01-01@1000';
const ASHORE = 'US5ZZ01M@2@2026-01-01@1000';

const h = vi.hoisted(() => ({
    rpc: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    fingerprint: '',
    registry: 'pending' as 'none' | 'pending' | 'loaded' | 'away',
    settle: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: { auth: { getUser: h.getUser }, rpc: h.rpc, from: h.from },
}));
vi.mock('../services/VoyageLegService', () => ({
    startLeg: vi.fn(),
    getActiveLeg: () => ({ id: 'leg-1', status: 'active' }),
    closeLeg: vi.fn(),
    deleteLegsForVoyage: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { vessel: { draft: 1.8 * 3.28084, estimatedFields: [] } } }),
    },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => h.fingerprint,
}));
vi.mock('../services/enc/piCellSync', () => ({
    boatRegistryState: () => h.registry,
    whenBoatRegistrySettled: h.settle,
    boatName: () => 'Te Moana Iti',
}));

import { castOff } from '../services/VoyageService';
import { evaluateTraceRelease, serialiseTraceVerificationNote } from '../services/traceVerification';

const OWNER = '00000000-0000-4000-8000-000000000201';
const VOYAGE = '00000000-0000-4000-8000-000000000301';
const points = [
    { lat: -17.53, lon: -149.57 },
    { lat: -17.6, lon: -149.62 },
];

function setUpVoyage(): void {
    const now = Date.now();
    const verification = evaluateTraceRelease(
        points,
        'ready',
        [
            {
                grade: 'clear',
                issues: [],
                minDepthM: 9,
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
            encRegistryFingerprint: ABOARD,
            departureMs: now,
            tideWindowLabel: '',
        },
        new Date(now).toISOString(),
    ).verification!;
    const planning = {
        id: VOYAGE,
        user_id: OWNER,
        vessel_id: null,
        voyage_name: 'Papeete to Moorea',
        departure_port: 'Papeete',
        destination_port: 'Moorea',
        departure_time: new Date(now).toISOString(),
        eta: null,
        crew_count: 2,
        status: 'planning',
        weather_master_id: OWNER,
        saved_route_id: 'trace-papeete',
        notes: serialiseTraceVerificationNote(verification),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        manifest_locked_at: null,
    };
    const active = { ...planning, status: 'active', manifest_locked_at: new Date(now).toISOString() };
    const queryFor = (result: unknown) => {
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = vi.fn().mockResolvedValue({ data: result, error: null });
        return query;
    };
    h.from.mockImplementation((table: string) =>
        table === 'saved_routes'
            ? queryFor({
                  id: 'trace-papeete',
                  user_id: OWNER,
                  points: points.map((p) => [p.lat, p.lon]),
                  deleted: false,
              })
            : queryFor(planning),
    );
    h.rpc.mockResolvedValue({ data: active, error: null });
}

describe('Cast Off waits for her charts to open (127-C-c)', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope(OWNER);
        vi.clearAllMocks();
        h.getUser.mockResolvedValue({ data: { user: { id: OWNER } }, error: null });
        h.fingerprint = ASHORE;
        h.registry = 'pending';
        setUpVoyage();
    });

    it('aboard, seconds after a relaunch: waits for the registry and casts off with no recheck', async () => {
        h.settle.mockImplementation(async () => {
            // The index lands: her licensed charts are registered again.
            h.registry = 'loaded';
            h.fingerprint = ABOARD;
            return 'loaded';
        });
        const result = await castOff(VOYAGE);
        expect(result).toMatchObject({ ok: true });
        expect(result.caution).toBeUndefined();
        expect(h.settle).toHaveBeenCalledWith(8_000);
    });

    it('still opening after the wait: the boat words, never "your chart library has changed"', async () => {
        h.settle.mockResolvedValue('pending');
        const result = await castOff(VOYAGE);
        expect(result.ok).toBe(true);
        expect(result.caution).toBe(
            "Checked on Te Moana Iti's charts. They open on the boat's Wi-Fi; recheck there before Cast Off.",
        );
    });

    it('not paired: no wait, and an honest chart-change caution', async () => {
        h.registry = 'none';
        const result = await castOff(VOYAGE);
        expect(h.settle).not.toHaveBeenCalled();
        expect(result.caution).toContain('chart library has changed under this route since it was checked');
    });
});
