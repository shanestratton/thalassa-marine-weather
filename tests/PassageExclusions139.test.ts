import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureCollection, Polygon } from 'geojson';
import type { IsochroneNode } from '../services/isochrone/types';
import type { CurrentRoutingExclusions } from '../services/routing/routingExclusions';
const h = vi.hoisted(() => ({
    read: vi.fn(),
    queries: vi.fn(),
    segments: vi.fn(),
    find: vi.fn(),
    publish: vi.fn(),
    release: vi.fn(),
    generation: 0,
    valid: true,
    manual: undefined as FeatureCollection<Polygon> | undefined,
    parks: undefined as FeatureCollection | undefined,
    notes: [] as string[],
    coverage: true,
}));
vi.mock('../services/routing/routingExclusions', () => ({
    readCurrentRoutingExclusions: h.read,
    routingExclusionContextKey: () => `fixture:${h.generation}:${h.valid}`,
}));
vi.mock('../services/HazardQueryService', () => ({
    GEBCO_MSL_TO_LAT_PESSIMISM_M: 1.3,
    regionalGebcoDatumDeltaM: () => 1.3,
    hazardDepthForDraft: () => -3,
    hasEncCoverageFor: () => h.coverage,
    preloadEncForBBox: async () => {},
    queryHazards: h.queries,
    querySegmentHazards: h.segments,
    querySegmentCautions: async (segments: unknown[]) => segments.map(() => []),
}));
vi.mock('../services/enc/EncHazardReportService', () => ({ setLastReport: h.publish, findHazardsAlongRoute: h.find }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => [], getVersion: () => 0 }));
vi.mock('../services/enc/encIndexCache', () => ({ failedCellIds: () => [] }));
import { validateRouteSegments } from '../services/isochrone/landAvoidance';
import { ROUTING_AREA_CAVEATS, knownRouteAreaCaveats } from '../services/routing/routeAreaWords';
import {
    auditPassageRoutingAreas,
    passageRoutingWindow,
    isRoutingExclusionFailure,
} from '../services/routing/passageExclusions';
function route(): IsochroneNode[] {
    return [0, 0.01].map((lon) => ({
        lat: 0,
        lon,
        timeHours: lon * 10,
        bearing: 90,
        speed: 6,
        tws: 15,
        twa: 90,
        distance: lon * 60,
        parentIndex: null,
    }));
}
function rect(w: number, s: number, e: number, n: number): FeatureCollection<Polygon> {
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [w, s],
                            [e, s],
                            [e, n],
                            [w, n],
                            [w, s],
                        ],
                    ],
                },
            },
        ],
    };
}
function lease(): CurrentRoutingExclusions {
    const generation = h.generation;
    let active = true;
    return {
        manual: h.manual,
        marineParks: h.parks,
        advisories: h.notes,
        isCurrent: () => active && h.valid && h.generation === generation,
        release: () => {
            if (active) h.release();
            active = false;
        },
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
const clearPoints = (points: { lat: number; lon: number }[]) =>
    points.map((point) => ({ ...point, isHazard: false, depth_m: -40, source: 'enc', catzoc: 1 }));
const report = () => ({ cellsConsulted: 1, bufferNm: 1, entries: [], advisories: [] });
beforeEach(() => {
    vi.clearAllMocks();
    h.generation = 0;
    h.valid = true;
    h.manual = undefined;
    h.parks = undefined;
    h.notes = [];
    h.coverage = true;
    h.read.mockImplementation(async () => lease());
    h.queries.mockImplementation(async (points) => clearPoints(points));
    h.segments.mockImplementation(async (segments: unknown[]) =>
        segments.map(() => ({ isHazard: false, source: 'enc', depth_m: -40 })),
    );
    h.find.mockImplementation(async () => report());
});
describe('passage-final actual policy lease and staged emission', () => {
    it('emits no success or report until the final asynchronous hazard walk and exact audit finish', async () => {
        const gate = deferred<ReturnType<typeof report>>();
        h.find.mockReturnValueOnce(gate.promise);
        const outcome = vi.fn(),
            hazard = vi.fn();
        const task = validateRouteSegments(route(), {
            vesselDraftM: 2,
            onVerificationOutcome: outcome,
            onHazardReport: hazard,
        });
        await vi.waitFor(() => expect(h.find).toHaveBeenCalledOnce());
        expect(outcome).not.toHaveBeenCalled();
        expect(hazard).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        gate.resolve(report());
        await task;
        expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: 'verified' });
        expect(hazard).toHaveBeenCalledOnce();
        expect(h.publish).toHaveBeenCalledOnce();
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('refuses a private polygon across the finished line, including a terminal, before any success publication', async () => {
        h.manual = rect(-0.001, -0.001, 0.006, 0.001);
        const outcome = vi.fn(),
            hazard = vi.fn();
        await expect(
            validateRouteSegments(route(), { onVerificationOutcome: outcome, onHazardReport: hazard }),
        ).rejects.toMatchObject({ code: 'route-exclusion' });
        expect(outcome).not.toHaveBeenCalled();
        expect(hazard).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('checks a newly inserted island detour against the same original private source window', async () => {
        h.manual = rect(0.004, 0.07, 0.006, 0.1);
        h.segments.mockImplementationOnce(async (segments: unknown[]) =>
            segments.map(() => ({ isHazard: true, source: 'enc', depth_m: -1 })),
        );
        await expect(validateRouteSegments(route())).rejects.toMatchObject({ code: 'route-exclusion' });
        expect(h.read).toHaveBeenCalledOnce();
        expect(h.publish).not.toHaveBeenCalled();
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('cannot let the depth-service outage early return bypass a hard polygon', async () => {
        h.manual = rect(0.004, -0.001, 0.006, 0.001);
        h.queries.mockRejectedValueOnce(Error('depth outage'));
        const outcome = vi.fn();
        await expect(validateRouteSegments(route(), { onVerificationOutcome: outcome })).rejects.toMatchObject({
            code: 'route-exclusion',
        });
        expect(outcome).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('preserves an explicit unverified depth-outage result after private proof, without claiming chart authority', async () => {
        h.queries.mockRejectedValueOnce(Error('depth outage'));
        const outcome = vi.fn();
        const result = await validateRouteSegments(route(), { onVerificationOutcome: outcome });
        expect(result).toHaveLength(2);
        expect(outcome).toHaveBeenCalledExactlyOnceWith({
            status: 'unverified',
            reason: 'chart/depth hazard query failed',
        });
        expect(h.publish.mock.calls[0][0].advisories[0].text).toContain('NOT been validated');
    });
    it('keeps retained parks indicative caution and emits their exact final intersection only after proof', async () => {
        h.parks = rect(0.004, -0.001, 0.006, 0.001);
        h.notes = ['Retained source caution'];
        const caveats = vi.fn(),
            outcome = vi.fn();
        await validateRouteSegments(route(), {
            publishReport: false,
            onRouteAreaCaveats: caveats,
            onVerificationOutcome: outcome,
        });
        expect(caveats.mock.calls[0][0]).toEqual([
            'Retained source caution',
            ROUTING_AREA_CAVEATS[5],
            ROUTING_AREA_CAVEATS[6],
        ]);
        expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: 'verified' });
        expect(h.publish).not.toHaveBeenCalled();
    });
    it.each(['account A/B/A', 'overlay edit', 'retained source expiry'])(
        'rejects %s during the final hazard await and releases without callbacks',
        async (kind) => {
            const gate = deferred<ReturnType<typeof report>>();
            h.find.mockReturnValueOnce(gate.promise);
            const outcome = vi.fn();
            const task = validateRouteSegments(route(), { onVerificationOutcome: outcome });
            const rejection = expect(task).rejects.toMatchObject({ code: 'exclusion-unavailable' });
            await vi.waitFor(() => expect(h.find).toHaveBeenCalledOnce());
            if (kind === 'retained source expiry') h.valid = false;
            else h.generation += kind === 'account A/B/A' ? 2 : 1;
            gate.resolve(report());
            await rejection;
            expect(outcome).not.toHaveBeenCalled();
            expect(h.publish).not.toHaveBeenCalled();
            expect(h.release).toHaveBeenCalledOnce();
        },
    );
    it('refuses corrupt/unavailable hard policy before consulting depth and never substitutes an empty source', async () => {
        h.read.mockRejectedValueOnce(Error('corrupt signed-in overlay bytes'));
        await expect(validateRouteSegments(route())).rejects.toMatchObject({ code: 'exclusion-unavailable' });
        expect(h.queries).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
    });
    it('cancels during a private read immediately and releases a non-cooperative late reader', async () => {
        const gate = deferred<CurrentRoutingExclusions>();
        h.read.mockReturnValueOnce(gate.promise);
        const abort = new AbortController();
        const task = validateRouteSegments(route(), { signal: abort.signal });
        const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' });
        abort.abort();
        await rejection;
        expect(h.queries).not.toHaveBeenCalled();
        gate.resolve(lease());
        await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
        expect(h.publish).not.toHaveBeenCalled();
    });
    it('releases exactly once when resolution is followed by a queued abort before assignment', async () => {
        const gate = deferred<CurrentRoutingExclusions>();
        h.read.mockReturnValueOnce(gate.promise);
        const original = lease(),
            dispose = vi.fn(() => original.release());
        const owned = { ...original, release: dispose };
        const abort = new AbortController();
        const task = validateRouteSegments(route(), { signal: abort.signal });
        const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' });
        gate.resolve(owned);
        queueMicrotask(() => abort.abort());
        await rejection;
        expect(dispose).toHaveBeenCalledOnce();
        expect(h.release).toHaveBeenCalledOnce();
        expect(h.queries).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
    });
    it('cancels an outstanding hazard await without waiting for its provider to finish', async () => {
        const gate = deferred<ReturnType<typeof clearPoints>>();
        h.queries.mockReturnValueOnce(gate.promise);
        const abort = new AbortController(),
            outcome = vi.fn();
        const task = validateRouteSegments(route(), { signal: abort.signal, onVerificationOutcome: outcome });
        const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(h.queries).toHaveBeenCalledOnce());
        abort.abort();
        await rejection;
        expect(h.release).toHaveBeenCalledOnce();
        gate.resolve([]);
        await Promise.resolve();
        expect(outcome).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
    });
    it.each(['onRouteAreaCaveats', 'onHazardReport', 'onVerificationOutcome'] as const)(
        'rejects a failing final %s callback and releases before returning any geometry',
        async (name) => {
            const outcome = vi.fn();
            const callbacks = {
                onVerificationOutcome: outcome,
                [name]: () => {
                    throw Error('consumer failed');
                },
            };
            await expect(validateRouteSegments(route(), callbacks)).rejects.toMatchObject({
                code: 'exclusion-unavailable',
            });
            expect(h.publish).not.toHaveBeenCalled();
            expect(h.release).toHaveBeenCalledOnce();
            if (name !== 'onVerificationOutcome') expect(outcome).not.toHaveBeenCalled();
        },
    );
    it('refuses context mutation inside a final callback before verified/global publication', async () => {
        const outcome = vi.fn();
        await expect(
            validateRouteSegments(route(), {
                onRouteAreaCaveats: () => {
                    h.generation++;
                },
                onVerificationOutcome: outcome,
            }),
        ).rejects.toMatchObject({ code: 'exclusion-unavailable' });
        expect(outcome).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('snapshots caller geometry before awaits and binds the original immutable window', async () => {
        const input = route(),
            gate = deferred<ReturnType<typeof report>>();
        h.find.mockReturnValueOnce(gate.promise);
        const task = validateRouteSegments(input);
        await vi.waitFor(() => expect(h.find).toHaveBeenCalledOnce());
        input[1].lon = 10;
        gate.resolve(report());
        const result = await task;
        expect(result[1].lon).toBe(0.01);
        expect(Object.isFrozen(h.read.mock.calls[0][0].bbox)).toBe(true);
    });
});
describe('bounded original passage window and exact negative geometry', () => {
    it('rejects a finished nudge outside its original read window instead of changing cohorts', () => {
        const original = route(),
            window = passageRoutingWindow(original);
        expect(() => auditPassageRoutingAreas([original[0], { lat: 3, lon: 0.01 }], lease(), window, () => {})).toThrow(
            expect.objectContaining({ code: 'exclusion-unavailable' }),
        );
    });
    it('bounds invalid/oversized/orbital geometry before any private read', async () => {
        for (const points of [
            [
                { lat: 86, lon: 0 },
                { lat: 86, lon: 1 },
            ],
            [
                { lat: 0, lon: NaN },
                { lat: 0, lon: 1 },
            ],
            Array.from({ length: 8193 }, () => ({ lat: 0, lon: 0 })),
        ])
            expect(() => passageRoutingWindow(points)).toThrow(
                expect.objectContaining({ code: 'exclusion-unavailable' }),
            );
        const abort = new AbortController();
        abort.abort();
        await expect(validateRouteSegments(route(), { signal: abort.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(h.read).not.toHaveBeenCalled();
    });
    it('keeps a short dateline read window local but refuses unsupported unsplit constrained geometry', () => {
        const points = [
                { lat: 0, lon: 179.9 },
                { lat: 0, lon: -179.9 },
            ],
            window = passageRoutingWindow(points);
        expect(window[0]).toBeGreaterThan(170);
        expect(window[2]).toBeLessThan(-170);
        h.manual = rect(179, -1, 180, 1);
        expect(() => auditPassageRoutingAreas(points, lease(), window, () => {})).toThrow(
            expect.objectContaining({ code: 'exclusion-unavailable' }),
        );
    });
    it('retains the exact accepted passage park caution in saved/UI whitelists without adding source prose', () => {
        expect(
            knownRouteAreaCaveats([ROUTING_AREA_CAVEATS[5], ROUTING_AREA_CAVEATS[6], 'borrowed chart prose']),
        ).toEqual([ROUTING_AREA_CAVEATS[5], ROUTING_AREA_CAVEATS[6]]);
    });
    it('recognizes structured policy failures across independently bundled callers only', () => {
        expect(isRoutingExclusionFailure({ code: 'route-exclusion' })).toBe(true);
        expect(isRoutingExclusionFailure({ code: 'exclusion-unavailable' })).toBe(true);
        expect(isRoutingExclusionFailure({ code: 'tide-route-unavailable' })).toBe(false);
        expect(isRoutingExclusionFailure(null)).toBe(false);
    });
});
