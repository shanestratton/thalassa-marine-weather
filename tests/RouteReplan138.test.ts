import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { IsochroneResult } from '../services/isochrone/types';
const f = vi.hoisted(() => ({
    owner: { key: 'user-a', userId: 'user-a', generation: 1 },
    boat: 'boat-a',
    model: 'ecmwf',
    authority: 'confirm',
    voyage: '30000000-0000-4000-8000-000000000001',
    trackingBoat: 'boat-a',
    fix: { lat: 0, lon: 0.1, timestamp: 0, source: 'gps' },
    settings: { vessel: { type: 'sail', cruisingSpeed: 6 } },
    follow: {
        isFollowing: true,
        voyageId: 'old',
        startedAt: 'start',
        routeCoords: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.1 },
            { lat: 0, lon: 0.12 },
        ],
        voyagePlan: {
            origin: 'Fictional start',
            destination: 'Fictional end',
            departureDate: '2026-10-16T12:00:00Z',
            destinationCoordinates: { lat: 0, lon: 0.12 },
            waypoints: [] as Array<{ name: string; coordinates?: { lat: number; lon: number } }>,
            distanceApprox: '7 NM',
            durationApprox: '2 hours',
            overview: '',
        },
    },
    pending: null as unknown,
    save: vi.fn(),
    rpc: vi.fn(),
    load: vi.fn(),
    followWrite: vi.fn(),
    link: vi.fn(),
    mark: vi.fn(),
    scopeChanged: () => {},
}));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: { getState: () => ({ ...f.follow, startFollowing: f.followWrite }) },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ activeVesselId: f.boat, settings: f.settings }) },
}));
vi.mock('../stores/WindStore', () => ({ WindStore: { getState: () => ({ model: f.model }) } }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.owner,
    isAuthIdentityScopeCurrent: (s: typeof f.owner) => s.key === f.owner.key && s.generation === f.owner.generation,
    subscribeAuthIdentityScope: (fn: () => void) => {
        f.scopeChanged = fn;
        return () => {};
    },
}));
vi.mock('../services/ownshipPosition', () => ({ acquireFreshOwnshipPosition: async () => f.fix }));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getCurrentVoyageId: () => f.voyage,
        getTrackingStatus: () => ({ boatId: f.trackingBoat, isPaused: false }),
    },
}));
vi.mock('../services/VoyageLogService', () => ({ VoyageLogService: { getPlanLink: f.link } }));
vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getSession: async () => ({
                data: {
                    session: {
                        access_token: `header.${btoa(JSON.stringify({ session_id: 'session-a' }))}.signature`,
                        user: { id: f.owner.userId },
                    },
                },
                error: null,
            }),
        },
        rpc: f.rpc,
    },
}));
vi.mock('../services/shiplog/routeAuthority', () => ({ currentRouteReplaceDecision: () => f.authority }));
vi.mock('../services/skipperDevice', () => ({
    getDeviceId: () => 'dev-reviewed',
    getDeviceName: () => 'Fictional device',
}));
vi.mock('../services/passageHandoff', () => ({
    requestPassageMode: (value: unknown) => {
        f.pending = value;
    },
    peekPassageRequest: () => f.pending,
}));
vi.mock('../services/shiplog/planLinkIntent', () => ({ markWrittenHere: f.mark }));
vi.mock('../services/routing/isochronePolicy', () => ({ isochroneRoutingContext: () => JSON.stringify(f.settings) }));
vi.mock('../services/routing/offshoreModelComparison', () => ({
    OFFSHORE_COMPARISON_MODELS: [{ id: 'ecmwf', label: 'ECMWF', domain: 'ecmwf_ifs' }],
}));
vi.mock('../services/weather/OpenMeteoWindFetcher', () => ({ fetchModelWindGrid: f.load }));
vi.mock('../services/shiplog/PassagePlanSave', () => ({ savePassagePlanToLogbook: f.save }));
import {
    requestRouteReplan,
    offerRouteReplanCandidate,
    acceptRouteReplan,
    dismissRouteReplan,
} from '../services/routing/routeReplan';
import { readRouteReplan, setRouteReplan } from '../services/routing/routeReplanSession';
const epoch = Date.parse('2026-10-16T12:00:00Z');
function candidate(): { result: IsochroneResult; turns: []; caveats: string[]; cells: string[]; geometryKey: string } {
    const result: IsochroneResult = {
        route: [0, 1].map((timeHours, i) => ({
            lat: 0,
            lon: [0.1, 0.12][i],
            timeHours,
            bearing: 90,
            speed: 1.2,
            tws: 10,
            twa: 90,
            parentIndex: null,
            distance: i * 1.2,
        })),
        routeCoordinates: [
            [0.1, 0],
            [0.12, 0],
        ],
        totalDistanceNM: 1.2,
        totalDurationHours: 1,
        arrivalTime: new Date(epoch + 3600000).toISOString(),
        isochrones: [],
        shallowFlags: [false, false],
    };
    return {
        result,
        turns: [],
        caveats: ['Synthetic chart advisory'],
        cells: [],
        geometryKey: 'verified-synthetic-geometry',
    };
}
async function ready() {
    await requestRouteReplan(epoch + 7200000);
    const base = readRouteReplan().base;
    expect(base).not.toBeNull();
    offerRouteReplanCandidate(base!.token, candidate());
    expect(readRouteReplan().phase).toBe('ready');
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    vi.stubGlobal('crypto', webcrypto);
    f.owner = { key: 'user-a', userId: 'user-a', generation: 1 };
    f.boat = 'boat-a';
    f.authority = 'confirm';
    f.voyage = '30000000-0000-4000-8000-000000000001';
    f.trackingBoat = 'boat-a';
    f.follow.voyageId = 'old';
    f.model = 'ecmwf';
    f.fix.timestamp = epoch;
    f.pending = null;
    f.follow.voyagePlan.waypoints = [];
    f.follow.routeCoords = [0, 0.1, 0.12].map((lon) => ({ lat: 0, lon }));
    f.link.mockResolvedValue({
        ok: true,
        row: {
            voyageId: f.voyage,
            planVoyageId: 'old',
            deviceId: 'dev-original',
            deviceName: 'Other fictional device',
            updatedAt: '2026-10-16T11:00:00Z',
        },
    });
    f.load.mockResolvedValue({
        u: [new Float32Array(4).fill(3), new Float32Array(4).fill(3)],
        v: [new Float32Array(4), new Float32Array(4)],
        speed: [new Float32Array(4).fill(3), new Float32Array(4).fill(3)],
        width: 2,
        height: 2,
        lats: [-1, 1],
        lons: [0, 1],
        south: -1,
        north: 1,
        west: 0,
        east: 1,
        totalHours: 2,
        stepHours: [0, 2],
        refTime: new Date(epoch).toISOString(),
    });
    f.save.mockResolvedValue('new');
    f.rpc.mockResolvedValue({ data: { applied: true }, error: null });
    setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe('reviewed route replacement', () => {
    it('prepares a private same-router handoff without following, saving or publishing', async () => {
        await requestRouteReplan();
        expect(readRouteReplan().phase).toBe('computing');
        expect(f.pending).toMatchObject({
            departure: { lat: 0, lon: 0.1 },
            arrival: { lat: 0, lon: 0.12 },
            via: [],
            speed: 6,
        });
        expect(f.save).not.toHaveBeenCalled();
        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.followWrite).not.toHaveBeenCalled();
    });
    it('retains every remaining accepted via in the actual shared planner handoff and refuses a dropped candidate', async () => {
        f.follow.routeCoords = [0, 0.1, 0.11, 0.12].map((lon) => ({ lat: 0, lon }));
        f.follow.voyagePlan.waypoints = [{ name: 'Required via', coordinates: { lat: 0, lon: 0.11 } }];
        await requestRouteReplan();
        expect(readRouteReplan().phase).toBe('computing');
        expect(f.pending).toMatchObject({ via: [{ lat: 0, lon: 0.11, name: 'Required via' }] });
        offerRouteReplanCandidate(readRouteReplan().base!.token, candidate());
        expect(readRouteReplan().phase).toBe('error');
        expect(f.followWrite).not.toHaveBeenCalled();
    });
    it('requires final covered geometry before offering acceptance', async () => {
        await requestRouteReplan();
        const value = candidate();
        value.result.routeCoordinates[1] = [10, 10];
        offerRouteReplanCandidate(readRouteReplan().base!.token, value);
        expect(readRouteReplan().phase).toBe('error');
        expect(await acceptRouteReplan()).toBe(false);
        expect(f.rpc).not.toHaveBeenCalled();
    });
    it('accepts a complete verified via candidate only through the same atomic CAS and persists its constraints', async () => {
        f.follow.routeCoords = [0, 0.1, 0.11, 0.12].map((lon) => ({ lat: 0, lon }));
        f.follow.voyagePlan.waypoints = [{ name: 'Required via', coordinates: { lat: 0, lon: 0.11 } }];
        await requestRouteReplan();
        const value = candidate(),
            middle = { ...value.result.route[0], lon: 0.11, timeHours: 0.5, distance: 0.6 };
        value.result.route.splice(1, 0, middle);
        value.result.routeCoordinates.splice(1, 0, [0.11, 0]);
        value.result.shallowFlags.splice(1, 0, false);
        offerRouteReplanCandidate(readRouteReplan().base!.token, value);
        expect(readRouteReplan().phase).toBe('ready');
        expect(await acceptRouteReplan()).toBe(true);
        expect(f.save.mock.calls[0][0].routeConstraints).toEqual([{ lat: 0, lon: 0.11, name: 'Required via' }]);
        expect(f.followWrite.mock.calls[0][0].routeConstraints).toEqual([{ lat: 0, lon: 0.11, name: 'Required via' }]);
        expect(f.rpc).toHaveBeenCalledWith(
            'accept_reviewed_route_replan',
            expect.objectContaining({
                p_expected_plan: 'old',
                p_geometry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        );
    });
    it('keeps Cast Off passage identity separate from its planned-route mirror', async () => {
        f.follow.voyageId = f.voyage;
        await ready();
        expect(await acceptRouteReplan()).toBe(true);
        expect(f.rpc).toHaveBeenCalledWith(
            'accept_reviewed_route_replan',
            expect.objectContaining({
                p_voyage_id: f.voyage,
                p_expected_plan: 'old',
                p_expected_geometry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                p_reviewed_at: new Date(epoch).toISOString(),
            }),
        );
    });
    it('refuses an unregistered text track or a tracker bound to another boat before fetching', async () => {
        f.voyage = 'voyage_fictional';
        await requestRouteReplan();
        expect(readRouteReplan().phase).toBe('error');
        expect(f.load).not.toHaveBeenCalled();
        f.voyage = '30000000-0000-4000-8000-000000000001';
        f.trackingBoat = 'boat-b';
        await requestRouteReplan();
        expect(readRouteReplan().phase).toBe('error');
        expect(f.load).not.toHaveBeenCalled();
    });
    it('only follows after the reviewed exact-stamp CAS succeeds', async () => {
        await ready();
        expect(await acceptRouteReplan()).toBe(true);
        expect(f.rpc).toHaveBeenCalledWith(
            'accept_reviewed_route_replan',
            expect.objectContaining({
                p_expected_plan: 'old',
                p_expected_device: 'dev-original',
                p_expected_updated_at: '2026-10-16T11:00:00Z',
                p_plan: 'new',
                p_plan_rows: 2,
                p_geometry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        );
        expect(f.followWrite).toHaveBeenCalledOnce();
        expect(f.followWrite.mock.calls[0][2]).toEqual([
            { lat: 0, lon: 0.1 },
            { lat: 0, lon: 0.12 },
        ]);
        expect(f.mark).toHaveBeenCalledWith(f.voyage, 'new');
    });
    it('preserves the original on a failed or unavailable atomic server check without an upsert fallback', async () => {
        await ready();
        f.rpc.mockResolvedValue({ data: { applied: false, reason: 'link-changed' }, error: null });
        expect(await acceptRouteReplan()).toBe(false);
        expect(f.followWrite).not.toHaveBeenCalled();
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.rpc).toHaveBeenCalledOnce();
        expect(f.follow.voyageId).toBe('old');
    });
    it('rechecks boat identity after a delayed save and never sends its old acceptance', async () => {
        await ready();
        let finish!: (id: string) => void;
        f.save.mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        const accepted = acceptRouteReplan();
        await vi.waitFor(() => expect(f.save).toHaveBeenCalled());
        f.boat = 'boat-b';
        finish('new');
        expect(await accepted).toBe(false);
        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.followWrite).not.toHaveBeenCalled();
    });
    it('does not accept a candidate that expires while its private save is pending', async () => {
        await ready();
        f.save.mockImplementation(async () => {
            vi.mocked(Date.now).mockReturnValue(epoch + 300001);
            return 'new';
        });
        expect(await acceptRouteReplan()).toBe(false);
        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.followWrite).not.toHaveBeenCalled();
        expect(readRouteReplan().message).toContain('expired');
    });
    it('rejects an authority change, leaves the prior route on save failure, and rejects cancelled late results', async () => {
        await ready();
        f.authority = 'refuse';
        expect(await acceptRouteReplan()).toBe(false);
        expect(f.save).not.toHaveBeenCalled();
        f.authority = 'confirm';
        setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
        await ready();
        f.save.mockRejectedValue(Error('Offline'));
        expect(await acceptRouteReplan()).toBe(false);
        expect(f.followWrite).not.toHaveBeenCalled();
        setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
        await requestRouteReplan();
        const token = readRouteReplan().base!.token;
        dismissRouteReplan();
        offerRouteReplanCandidate(token, candidate());
        expect(readRouteReplan().phase).toBe('idle');
    });
});
