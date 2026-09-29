import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VesselProfile } from '../types/vessel';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../types/autorouting';
import type { DayPlanRequest, DayPlannerDependencies, DayPlanCandidate } from '../services/dayPlanner/engine';
import type { TrialRouteReview } from '../services/autoroutingReview';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';
import { FEET_PER_METRE } from '../services/units';

const api = vi.hoisted(() => ({
    status: vi.fn(),
    calculate: vi.fn(),
    review: vi.fn(),
    load: vi.fn(),
    discover: vi.fn(),
    weather: vi.fn(),
    cached: vi.fn(),
    build: vi.fn(),
    guidance: vi.fn(),
    canal: vi.fn(),
    resolveExit: vi.fn(),
    verifyExit: vi.fn(),
    catalogue: vi.fn(),
    revalidateCatalogue: vi.fn(),
    currentAccount: true,
    fingerprint: 'charts-v1',
    authListeners: new Set<() => void>(),
    chartListeners: new Set<() => void>(),
    profiles: [] as unknown[],
}));
vi.mock('../services/autoroutingTrial', () => ({
    calculateAutoroutingTrial: api.calculate,
    getAutoroutingTrialStatus: api.status,
}));
vi.mock('../services/autoroutingReview', () => ({ reviewAutoroutingProposal: api.review }));
vi.mock('../services/anchorages/AnchorageService', () => ({ AnchorageService: { loadNear: api.load } }));
vi.mock('../services/dayPlanner/discovery', () => ({ discoverMappedDayPlanCandidates: api.discover }));
vi.mock('../services/dayPlanner/cataloguePlanning', () => ({
    loadCataloguePlan: api.catalogue,
    revalidateCataloguePlan: api.revalidateCatalogue,
}));
vi.mock('../services/anchorages/PlaceConditionsService', () => ({
    cachedConditionsForecast: api.cached,
    loadPlaceConditions: api.weather,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ userId: 'account-a', key: 'user:account-a', generation: 1 }),
    isAuthIdentityScopeCurrent: () => api.currentAccount,
    subscribeAuthIdentityScope: (listener: () => void) => {
        api.authListeners.add(listener);
        return () => api.authListeners.delete(listener);
    },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => api.fingerprint,
    subscribe: (listener: () => void) => {
        api.chartListeners.add(listener);
        return () => api.chartListeners.delete(listener);
    },
}));
vi.mock('../services/automaticCanalExit', () => ({
    VERIFIED_CANAL_EXIT_PROFILES: api.profiles,
    resolveAutomaticCanalExit: api.resolveExit,
}));
vi.mock('../services/verifyCanalExitChart', () => ({ verifyCanalExitChart: api.verifyExit }));
vi.mock('../services/chartGuidedAutorouting', () => ({ createChartGuidedTrialCalculator: api.guidance }));
vi.mock('../services/autoroutingCanalDeparture', () => ({ calculateWithCanalDeparture: api.canal }));
vi.mock('../services/dayPlanner/engine', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/dayPlanner/engine')>()),
    buildFlexibleDayPlan: api.build,
}));
import {
    DAY_PLANNER_TIMEOUT_MS,
    dayPlannerCanalExitRefusal,
    dayPlannerVesselInputs,
    runDayPlanner,
} from '../services/dayPlanner/runtime';

const now = Date.UTC(2026, 8, 27, 0);
const NEXT_STEP =
    'Move the departure to open water outside the canal entrance, or set the canal exit by hand in Auto routing, under Canal / marina.';
const vessel = (): VesselProfile => ({
    name: 'Test vessel',
    type: 'sail',
    length: 40,
    beam: 12,
    draft: 6,
    displacement: 10000,
    maxWaveHeight: 6,
    maxWindSpeed: 20,
    cruisingSpeed: 6,
    airDraft: 50,
});
const request = (): DayPlanRequest => ({
    start: { lat: -20.25, lon: 148.82, label: 'Selected start' },
    departureMs: now + 3600000,
    maxSailingHours: 8,
    stopHours: 2,
    mode: 'return',
    activities: ['beach'],
    speedKts: 6,
    draftM: 6 / FEET_PER_METRE,
});
const emptyResult = () => ({ options: [], excluded: [], calculatedAt: now });
const catalogueSelection = { id: '00000000-0000-4000-8000-000000000101', version: 1 };
const catalogueCandidate = (): DayPlanCandidate => {
    const destination: DayPlanCandidate['destination'] = {
        ...structuredClone(WHITSUNDAYS_DAY_DESTINATIONS[0]),
        catalogueQuality: 'catalogue-reference',
        referencePosition: 'catalogue-reference',
    };
    const points = [request().start, { lat: -20.26, lon: 148.9 }, destination];
    const result: DayPlanCandidate = {
        destination,
        place: { id: 'catalogue-stop', lat: destination.lat, lon: destination.lon, kind: 'anchorage' },
        catalogue: {
            mode: 'return',
            selection: catalogueSelection,
            details: [],
            outbound: {
                variant: { id: '00000000-0000-4000-8000-000000000102', version: 1 },
                direction: 'outbound',
                checkpoints: points.map((point, i) => ({
                    lat: point.lat,
                    lon: point.lon,
                    sequence: i + 1,
                    required: true,
                    name: `Point ${i}`,
                    evidenceNote: 'Synthetic fixture',
                })),
            },
        },
    };
    const constraint = result.catalogue!.outbound!;
    result.catalogue!.details = [
        {
            ...constraint.variant,
            kind: 'route_variant',
            name: 'Synthetic route variant',
            summary: 'Synthetic fixture only.',
            position: { lat: constraint.checkpoints[0].lat, lon: constraint.checkpoints[0].lon },
            review: {
                reviewedAt: new Date(now).toISOString(),
                reviewDueAt: new Date(now + 86400000).toISOString(),
                reviewerLabel: 'Fixture',
                scope: 'Synthetic test',
            },
            evidence: [
                {
                    sourceUrl: 'https://example.org/test',
                    sourceLabel: 'Fixture',
                    retrievedAt: new Date(now).toISOString(),
                    licence: 'Fixture',
                    licenceUrl: 'https://example.org/licence',
                    attribution: 'Fixture',
                    scope: 'Synthetic test',
                },
            ],
            limitations: ['Current clearance remains unverified.'],
            activities: [],
            trip: result.catalogue!.selection,
            direction: constraint.direction,
            checkpoints: structuredClone(constraint.checkpoints),
        },
    ];
    return result;
};
function withCatalogueRoute() {
    api.catalogue.mockResolvedValue(catalogueCandidate());
    api.build.mockImplementation(
        async (
            input: DayPlanRequest,
            candidates: DayPlanCandidate[],
            deps: DayPlannerDependencies,
            runOptions: { signal: AbortSignal },
        ) => {
            await deps.route(
                input.start,
                candidates[0].destination,
                runOptions.signal,
                candidates[0].catalogue?.outbound,
            );
            return emptyResult();
        },
    );
}
const data = () => ({
    points: {
        type: 'FeatureCollection',
        features: WHITSUNDAYS_DAY_DESTINATIONS.map((destination) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [destination.lon, destination.lat] },
            properties: {
                id: destination.anchorageId,
                name: destination.anchorageName,
                kind: 'anchorage',
                source: 'OpenStreetMap',
                fetchLandNM: Array(36).fill(0.3),
            },
        })),
    },
    noAnchor: { type: 'FeatureCollection', features: [] as unknown[] },
    zoning: { type: 'FeatureCollection', features: [] },
    tiles: ['pilot'],
});
const route = (input: AutoroutingTrialRequest): AutoroutingTrialRoute => ({
    id: 'provider-proposal',
    provider: 'SevenCs',
    createdAt: new Date(now).toISOString(),
    warnings: [],
    coordinates: [
        [input.departure.lon, input.departure.lat],
        [input.destination.lon, input.destination.lat],
    ],
    vesselProfile: structuredClone(input.vesselProfile),
});
const review = (): TrialRouteReview => ({
    phase: 'complete',
    legs: [
        {
            incomplete: false,
            verdict: {
                grade: 'clear',
                issues: [],
                minDepthM: 10,
                minAt: null,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            },
        },
    ],
});
const options = () => ({ signal: new AbortController().signal, mapboxToken: 'test-map-token' });
const invalidRings = [
    {
        name: 'duplicate collapsed vertices',
        ring: [
            [148, -20],
            [148, -20],
            [148, -20],
            [148, -20],
        ],
    },
    {
        name: 'three unique but collinear vertices',
        ring: [
            [148, -20],
            [149, -20],
            [150, -20],
            [148, -20],
        ],
    },
    {
        name: 'nonzero-area self-crossing ring',
        ring: [
            [148, -20],
            [150, -18],
            [148, -18],
            [149, -20],
            [148, -20],
        ],
    },
    {
        name: 'adjacent backtracking edge',
        ring: [
            [148, -20],
            [151, -20],
            [149, -20],
            [149, -18],
            [148, -18],
            [148, -20],
        ],
    },
    {
        name: 'repeated non-closure vertex',
        ring: [
            [148, -20],
            [150, -20],
            [150, -18],
            [149, -19],
            [150, -20],
            [148, -20],
        ],
    },
];
function withRoute() {
    api.build.mockImplementation(
        async (
            input: DayPlanRequest,
            candidates: DayPlanCandidate[],
            deps: DayPlannerDependencies,
            runOptions: { signal: AbortSignal },
        ) => {
            await deps.route(input.start, candidates[0].destination, runOptions.signal);
            return emptyResult();
        },
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    api.currentAccount = true;
    api.fingerprint = 'charts-v1';
    api.profiles.length = 0;
    api.authListeners.clear();
    api.chartListeners.clear();
    api.status.mockResolvedValue({ enabled: true, ready: true, vesselProfile: true });
    api.load.mockResolvedValue(data());
    api.discover.mockResolvedValue({
        candidates: [],
        excluded: [],
        limitations: ['Mapped references are unverified.'],
        radiusNM: 24,
        tileKeys: ['37:-123'],
        freshUntilMs: now + 86400000,
    });
    api.calculate.mockImplementation(async (input) => route(input));
    api.review.mockImplementation(async () => review());
    api.build.mockResolvedValue(emptyResult());
    api.weather.mockResolvedValue(undefined);
    api.cached.mockReturnValue(undefined);
    api.revalidateCatalogue.mockResolvedValue(undefined);
    api.guidance.mockReturnValue(api.calculate);
    api.verifyExit.mockResolvedValue(true);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('Planner vessel inputs', () => {
    it('converts saved feet to metres and uses saved speed without inference', () => {
        expect(dayPlannerVesselInputs(vessel())).toEqual({
            speedKts: 6,
            draftM: 6 / FEET_PER_METRE,
            maxWindKts: 20,
            maxWaveM: 6 / FEET_PER_METRE,
        });
        expect(dayPlannerVesselInputs({ ...vessel(), maxWaveHeight: 0, maxWindSpeed: 0 })).toEqual({
            speedKts: 6,
            draftM: 6 / FEET_PER_METRE,
        });
    });
    it.each([
        { draft: 0 },
        { draft: Number.POSITIVE_INFINITY },
        { cruisingSpeed: 0 },
        { cruisingSpeed: Number.NaN },
        { maxWaveHeight: -1 },
        { type: 'observer' as const },
    ])('rejects incomplete or invalid vessel inputs %j', (change) => {
        expect(() => dayPlannerVesselInputs({ ...vessel(), ...change })).toThrow();
    });
});

describe('Day planner live adapter', () => {
    it('loads only the exact selected shared entry, bounded known restrictions and fresh rechecks', async () => {
        api.catalogue.mockResolvedValue(catalogueCandidate());
        const result = await runDayPlanner({ ...request(), catalogueSelection }, vessel(), options());
        expect(api.catalogue).toHaveBeenCalledWith(catalogueSelection, 'return', expect.any(AbortSignal));
        expect(api.discover).not.toHaveBeenCalled();
        const destination = WHITSUNDAYS_DAY_DESTINATIONS[0];
        expect(api.load).toHaveBeenCalledWith(destination.lat, destination.lon, 1);
        expect(api.build.mock.calls[0][1][0].destination.catalogueQuality).toBe('catalogue-reference');
        expect(api.revalidateCatalogue).toHaveBeenCalledTimes(2);
        expect(result.coverage?.type).toBe('catalogue-reference');
    });

    it('never falls back when a selected entry is withdrawn or final revalidation fails', async () => {
        api.catalogue.mockRejectedValueOnce(new Error('Selected reference withdrawn'));
        await expect(runDayPlanner({ ...request(), catalogueSelection }, vessel(), options())).rejects.toThrow(
            /withdrawn/,
        );
        expect(api.discover).not.toHaveBeenCalled();
        expect(api.load).not.toHaveBeenCalled();
        api.catalogue.mockResolvedValue(catalogueCandidate());
        api.revalidateCatalogue
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('Reference withdrawn during planning'));
        await expect(runDayPlanner({ ...request(), catalogueSelection }, vessel(), options())).rejects.toThrow(
            /during planning/,
        );
    });

    it('rejects combined local and catalogue choices before network work', async () => {
        await expect(
            runDayPlanner(
                { ...request(), catalogueSelection, destinationIds: ['whitehaven-beach'] },
                vessel(),
                options(),
            ),
        ).rejects.toThrow(/not both/);
        expect(api.status).not.toHaveBeenCalled();
    });

    it('retains known no-anchoring restrictions and rejects malformed restriction data', async () => {
        api.catalogue.mockResolvedValue(catalogueCandidate());
        const chart = data();
        Object.assign(chart.points.features[0].properties, { noAnchoring: true });
        api.load.mockResolvedValue(chart);
        await runDayPlanner({ ...request(), catalogueSelection }, vessel(), options());
        expect(api.build.mock.calls[0][1][0].place.noAnchoring).toBe(true);
        api.load.mockResolvedValue({ ...chart, noAnchor: null });
        await expect(runDayPlanner({ ...request(), catalogueSelection }, vessel(), options())).rejects.toThrow(
            /restriction data/,
        );
    });

    it('fences account switches during exact catalogue detail loading', async () => {
        api.catalogue.mockReturnValue(new Promise(() => {}));
        const pending = runDayPlanner({ ...request(), catalogueSelection }, vessel(), options());
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        api.currentAccount = false;
        api.authListeners.forEach((listener) => listener());
        await rejected;
        expect(api.build).not.toHaveBeenCalled();
    });

    it('passes every required interior checkpoint to the provider then reviews the whole returned route', async () => {
        withCatalogueRoute();
        api.status.mockResolvedValue({ enabled: true, ready: true, vesselProfile: true, channelGuidance: true });
        api.calculate.mockImplementation(async (input: AutoroutingTrialRequest) => ({
            ...route(input),
            coordinates: [
                [input.departure.lon, input.departure.lat],
                ...(input.chartTrackConstraints ?? []).map((point) => [point.lon, point.lat]),
                [input.destination.lon, input.destination.lat],
            ],
        }));
        await runDayPlanner({ ...request(), catalogueSelection }, vessel(), options());
        expect(api.calculate.mock.calls[0][0].chartTrackConstraints).toEqual([{ lat: -20.26, lon: 148.9 }]);
        expect(api.review.mock.calls[0][0].coordinates).toHaveLength(3);
        expect(api.review.mock.calls[0][0].warnings).toContain(
            'Catalogue outbound route limitation: Current clearance remains unverified.',
        );
    });

    it('rejects unsupported constraints and provider shortcuts without a generic-route retry', async () => {
        withCatalogueRoute();
        await expect(runDayPlanner({ ...request(), catalogueSelection }, vessel(), options())).rejects.toThrow(
            /does not support/,
        );
        expect(api.calculate).not.toHaveBeenCalled();
        api.status.mockResolvedValue({ enabled: true, ready: true, vesselProfile: true, channelGuidance: true });
        await expect(runDayPlanner({ ...request(), catalogueSelection }, vessel(), options())).rejects.toThrow(
            /every required/,
        );
        expect(api.calculate).toHaveBeenCalledTimes(1);
        expect(api.review).not.toHaveBeenCalled();
    });

    it('rejects a canal handover that cannot preserve the required catalogue chain', async () => {
        withCatalogueRoute();
        api.status.mockResolvedValue({ enabled: true, ready: true, vesselProfile: true, channelGuidance: true });
        api.profiles.push({
            departureArea: {
                type: 'Polygon',
                coordinates: [
                    [
                        [148.7, -20.3],
                        [148.9, -20.3],
                        [148.9, -20.2],
                        [148.7, -20.2],
                        [148.7, -20.3],
                    ],
                ],
            },
        });
        api.resolveExit.mockReturnValue({ status: 'resolved' });
        await expect(runDayPlanner({ ...request(), catalogueSelection }, vessel(), options())).rejects.toThrow(
            /cannot be combined/,
        );
        expect(api.calculate).not.toHaveBeenCalled();
        expect(api.canal).not.toHaveBeenCalled();
    });

    it('passes only the explicit local destination to the engine with activity preferences intact', async () => {
        const selected = WHITSUNDAYS_DAY_DESTINATIONS.at(-1)!;
        await runDayPlanner({ ...request(), destinationIds: [selected.id] }, vessel(), options());
        const candidates = api.build.mock.calls[0][1] as DayPlanCandidate[];
        expect(candidates.map((candidate) => candidate.destination.id)).toEqual([selected.id]);
        expect(api.build.mock.calls[0][0]).toMatchObject({ destinationIds: [selected.id], activities: ['beach'] });
    });

    it('rejects a destination from a different catalogue before provider or reference work', async () => {
        await expect(
            runDayPlanner({ ...request(), destinationIds: ['unknown-stop'] }, vessel(), options()),
        ).rejects.toThrow(/departure area/);
        expect(api.load).not.toHaveBeenCalled();
        expect(api.build).not.toHaveBeenCalled();
    });

    it('loads the fixed catalogue area and uses only exact matching anchorage references', async () => {
        const chart = data();
        chart.points.features[0].properties.id = 'same-name-wrong-id';
        chart.points.features[1].geometry.coordinates[0] += 0.00001;
        api.load.mockResolvedValue(chart);
        const result = await runDayPlanner(request(), vessel(), options());
        expect(api.load).toHaveBeenCalledWith(-20.2, 148.95, 35);
        const candidates = api.build.mock.calls[0][1] as DayPlanCandidate[];
        expect(candidates).toHaveLength(4);
        expect(candidates[0].place.fetchLandNM).toEqual(Array(36).fill(0.3));
        expect(result.excluded).toHaveLength(2);
        expect(api.authListeners.size).toBe(0);
    });

    it('carries mapped no-anchoring polygon restrictions into the engine without inventing shelter', async () => {
        const chart = data();
        const destination = WHITSUNDAYS_DAY_DESTINATIONS[0];
        const { lon, lat } = destination;
        chart.noAnchor.features.push({
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [lon - 0.001, lat - 0.001],
                        [lon + 0.001, lat - 0.001],
                        [lon + 0.001, lat + 0.001],
                        [lon - 0.001, lat + 0.001],
                        [lon - 0.001, lat - 0.001],
                    ],
                ],
            },
        });
        Reflect.deleteProperty(chart.points.features[0].properties, 'fetchLandNM');
        api.load.mockResolvedValue(chart);
        await runDayPlanner(request(), vessel(), options());
        expect(api.build.mock.calls[0][1][0].place).toMatchObject({ noAnchoring: true, fetchLandNM: undefined });
    });

    it('rejects malformed restriction geometry', async () => {
        const chart = data();
        chart.noAnchor.features.push({ geometry: { type: 'Polygon', coordinates: [[[1, 2]]] } });
        api.load.mockResolvedValue(chart);
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('geometry');
        expect(api.build).not.toHaveBeenCalled();
    });

    it.each(invalidRings)('rejects a restriction with $name rather than treating it as clear', async ({ ring }) => {
        const chart = data();
        chart.noAnchor.features.push({ geometry: { type: 'Polygon', coordinates: [ring] } });
        api.load.mockResolvedValue(chart);
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('geometry');
        expect(api.build).not.toHaveBeenCalled();
    });

    it('rejects invalid MultiPolygon members and holes outside their exterior', async () => {
        const outer = [
            [148, -21],
            [150, -21],
            [150, -19],
            [148, -19],
            [148, -21],
        ];
        for (const geometry of [
            { type: 'MultiPolygon', coordinates: [[outer], [invalidRings[0].ring]] },
            {
                type: 'Polygon',
                coordinates: [
                    outer,
                    [
                        [151, -20],
                        [152, -20],
                        [152, -19],
                        [151, -20],
                    ],
                ],
            },
        ]) {
            const chart = data();
            chart.noAnchor.features.push({ geometry });
            api.load.mockResolvedValue(chart);
            await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('geometry');
        }
    });

    it('keeps valid holes non-restricted and accepts the existing bundled restriction geometries', async () => {
        const chart = data();
        const { lon, lat } = WHITSUNDAYS_DAY_DESTINATIONS[0];
        const square = (d: number) => [
            [lon - d, lat - d],
            [lon + d, lat - d],
            [lon + d, lat + d],
            [lon - d, lat + d],
            [lon - d, lat - d],
        ];
        chart.noAnchor.features.push({ geometry: { type: 'Polygon', coordinates: [square(0.01), square(0.001)] } });
        api.load.mockResolvedValue(chart);
        await runDayPlanner(request(), vessel(), options());
        expect(api.build.mock.calls[0][1][0].place.noAnchoring).toBe(false);
        chart.noAnchor.features = JSON.parse(
            readFileSync('public/anchorages/qld/t-22e148-noanchor.geojson', 'utf8'),
        ).features;
        await expect(runDayPlanner(request(), vessel(), options())).resolves.toBeDefined();
    });

    it.each([
        { enabled: false, ready: false, vesselProfile: false },
        { enabled: true, ready: false, vesselProfile: false },
        { enabled: true, ready: true },
    ])('requires explicit ready and vessel-profile capabilities %j', async (status) => {
        api.status.mockResolvedValue(status);
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('vessel-profile');
        expect(api.load).not.toHaveBeenCalled();
    });

    it('rejects unsupported polar starts and vessel speed or draft mismatches before network work', async () => {
        for (const change of [
            { start: { lat: 81, lon: 153, label: 'Unsupported latitude' } },
            { speedKts: 7 },
            { draftM: 2 },
        ])
            await expect(runDayPlanner({ ...request(), ...change }, vessel(), options())).rejects.toThrow();
        expect(api.status).not.toHaveBeenCalled();
    });

    it('uses bounded global discovery and the departure IANA zone outside reviewed packs', async () => {
        const result = await runDayPlanner(
            { ...request(), start: { lat: 37.5, lon: -122.5, label: 'Synthetic start' }, activities: ['explore'] },
            vessel(),
            options(),
        );
        expect(api.load).not.toHaveBeenCalled();
        expect(api.discover).toHaveBeenCalledTimes(1);
        expect(api.discover.mock.calls[0][1]).toMatchObject({ timeZone: 'America/Los_Angeles' });
        expect(api.build.mock.calls[0][0].timeZone).toBe('America/Los_Angeles');
        expect(result.coverage).toMatchObject({
            type: 'mapped-reference',
            timeZone: 'America/Los_Angeles',
            radiusNM: 24,
            tiles: 1,
        });
        expect(result.coverage?.limitations).toEqual(['Mapped references are unverified.']);
    });

    it('rejects a supplied time-zone mismatch before network work', async () => {
        await expect(
            runDayPlanner({ ...request(), timeZone: 'America/New_York' }, vessel(), options()),
        ).rejects.toThrow('time zone');
        expect(api.status).not.toHaveBeenCalled();
    });

    it('fences account changes while worldwide discovery is pending', async () => {
        api.discover.mockReturnValue(new Promise(() => {}));
        const running = runDayPlanner(
            { ...request(), start: { lat: 37.5, lon: -122.5, label: 'Synthetic start' }, activities: ['explore'] },
            vessel(),
            options(),
        );
        const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        api.currentAccount = false;
        for (const listener of api.authListeners) listener();
        await rejected;
        expect(api.build).not.toHaveBeenCalled();
    });

    it('refuses reference freshness that expires while routing', async () => {
        api.discover.mockResolvedValue({
            candidates: [],
            excluded: [],
            limitations: [],
            radiusNM: 24,
            tileKeys: ['37:-123'],
            freshUntilMs: now + 1000,
        });
        api.build.mockImplementation(async () => {
            vi.setSystemTime(now + 1000);
            return emptyResult();
        });
        await expect(
            runDayPlanner(
                { ...request(), start: { lat: 37.5, lon: -122.5, label: 'Synthetic start' }, activities: ['explore'] },
                vessel(),
                options(),
            ),
        ).rejects.toThrow('references expired');
    });

    it('carries current vessel limits when the request omits them and rejects larger requested limits', async () => {
        await runDayPlanner(request(), { ...vessel(), maxWindSpeed: 10, maxWaveHeight: 3 }, options());
        expect(api.build.mock.calls[0][0]).toMatchObject({ maxWindKts: 10, maxWaveM: 3 / FEET_PER_METRE });
        await expect(runDayPlanner({ ...request(), maxWaveM: 3 }, vessel(), options())).rejects.toThrow(
            'vessel limits',
        );
    });

    it('preserves estimated dimensions and binds the completed review to exact geometry and profile', async () => {
        let assessed: Awaited<ReturnType<DayPlannerDependencies['route']>> | undefined;
        api.build.mockImplementation(async (input, candidates, deps, runOptions) => {
            assessed = await deps.route(input.start, candidates[0].destination, runOptions.signal);
            return emptyResult();
        });
        await runDayPlanner(request(), { ...vessel(), estimatedFields: ['draft', 'beam', 'cruisingSpeed'] }, options());
        const sent = api.calculate.mock.calls[0][0];
        expect(sent.vesselProfile).toMatchObject({ draftStatus: 'estimated', beam: { status: 'estimated' } });
        expect(api.review.mock.calls[0][0]).toBe(assessed?.route);
        expect(api.review.mock.calls[0][4]).toEqual({ draftAssumed: true });
        expect(assessed?.review.basis).toMatchObject({
            proposalId: 'provider-proposal',
            draftAssumed: true,
            draftM: request().draftM,
            registryFingerprint: 'charts-v1',
            vesselProfileKey: JSON.stringify(sent.vesselProfile),
        });
        expect(assessed?.review.basis?.geometryKey).toContain(JSON.stringify(assessed?.route.coordinates));
        expect(assessed?.route.warnings.join(' ')).toContain('Cruising speed is estimated');
        expect(api.guidance).not.toHaveBeenCalled();
    });

    it('uses chart guidance only when explicitly advertised', async () => {
        withRoute();
        api.status.mockResolvedValue({ enabled: true, ready: true, vesselProfile: true, channelGuidance: true });
        await runDayPlanner(request(), vessel(), options());
        expect(api.guidance).toHaveBeenCalledWith({
            channelGuidance: true,
            deadlineAtMs: now + DAY_PLANNER_TIMEOUT_MS,
        });
    });

    it('refuses a provider response with a changed vessel snapshot', async () => {
        withRoute();
        api.calculate.mockImplementation(async (input) => ({ ...route(input), vesselProfile: undefined }));
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('vessel profile');
        expect(api.review).not.toHaveBeenCalled();
    });

    it('requests seven forecast days and rejects oversized weather batches', async () => {
        api.build.mockImplementation(async (_input, _candidates, deps, runOptions) => {
            expect(await deps.forecast([{ lat: -20.1, lon: 149 }], runOptions.signal)).toEqual([undefined]);
            await expect(deps.forecast(Array(25).fill({ lat: -20.1, lon: 149 }), runOptions.signal)).rejects.toThrow(
                'budget',
            );
            return emptyResult();
        });
        await runDayPlanner(request(), vessel(), options());
        expect(api.weather).toHaveBeenCalledTimes(1);
        expect(api.weather.mock.calls[0][1]).toEqual({ forecastDays: 7, maxProviderDistanceNM: 5 });
    });

    it('cancels an anchorage load that cannot accept AbortSignal', async () => {
        api.load.mockReturnValue(new Promise(() => {}));
        const controller = new AbortController();
        const running = runDayPlanner(request(), vessel(), { ...options(), signal: controller.signal });
        const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejected;
        expect(api.build).not.toHaveBeenCalled();
        expect(api.authListeners.size).toBe(0);
    });

    it('fences account changes while an unabortable weather call is pending', async () => {
        api.weather.mockReturnValue(new Promise(() => {}));
        api.build.mockImplementation(async (_input, _candidates, deps, runOptions) => {
            await deps.forecast([{ lat: -20.1, lon: 149 }], runOptions.signal);
            return emptyResult();
        });
        const running = runDayPlanner(request(), vessel(), options());
        const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        api.currentAccount = false;
        api.authListeners.forEach((listener) => listener());
        await rejected;
        expect(api.cached).not.toHaveBeenCalled();
    });

    it('bounds the whole operation even when an existing service never settles', async () => {
        api.load.mockReturnValue(new Promise(() => {}));
        const rejected = expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(DAY_PLANNER_TIMEOUT_MS);
        await rejected;
        expect(api.authListeners.size).toBe(0);
    });

    it('rejects a chart fingerprint change during review and releases subscriptions', async () => {
        withRoute();
        api.review.mockImplementation(async () => {
            api.fingerprint = 'charts-v2';
            api.chartListeners.forEach((listener) => listener());
            return review();
        });
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('chart library changed');
        expect(api.chartListeners.size).toBe(0);
        expect(api.authListeners.size).toBe(0);
    });

    it('ignores a geographically unrelated expired canal profile without resolving it', async () => {
        withRoute();
        api.profiles.push({
            departureArea: {
                type: 'Polygon',
                coordinates: [
                    [
                        [153, -27],
                        [154, -27],
                        [154, -26],
                        [153, -26],
                        [153, -27],
                    ],
                ],
            },
            validUntil: '2020-01-01',
        });
        await runDayPlanner(request(), vessel(), options());
        expect(api.resolveExit).not.toHaveBeenCalled();
        expect(api.calculate).toHaveBeenCalledTimes(1);
    });

    it('refuses an applicable invalid canal exit instead of bypassing it', async () => {
        withRoute();
        api.profiles.push({
            departureArea: {
                type: 'Polygon',
                coordinates: [
                    [
                        [148.7, -20.3],
                        [148.9, -20.3],
                        [148.9, -20.2],
                        [148.7, -20.2],
                        [148.7, -20.3],
                    ],
                ],
            },
        });
        api.resolveExit.mockReturnValue({ status: 'manual-required', reason: 'Reviewed channel exit is out of date.' });
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('out of date');
        expect(api.calculate).not.toHaveBeenCalled();
    });

    it('refuses a departure inside a RETIRED exit with a reason the skipper can act on in Plan My Day', async () => {
        withRoute();
        api.profiles.push({
            departureArea: {
                type: 'Polygon',
                coordinates: [
                    [
                        [148.7, -20.3],
                        [148.9, -20.3],
                        [148.9, -20.2],
                        [148.7, -20.2],
                        [148.7, -20.3],
                    ],
                ],
            },
        });
        api.resolveExit.mockReturnValue({
            status: 'manual-required',
            reason: 'The automatic Newport Waterways canal exit is retired. Choose Canal exit on the chart.',
            code: 'retired',
            profileLabel: 'Newport Waterways',
        });
        const refusal = await runDayPlanner(request(), vessel(), options()).catch((error: unknown) => error);
        // Plan My Day has no "Canal exit on the chart"; it must not send the skipper looking for one.
        expect((refusal as Error).message).toBe(`The automatic Newport Waterways canal exit is retired. ${NEXT_STEP}`);
        expect(api.calculate).not.toHaveBeenCalled();
    });

    it('words an out-of-date exit the same way', () => {
        expect(
            dayPlannerCanalExitRefusal({
                status: 'manual-required',
                reason: 'x',
                code: 'out-of-date',
                profileLabel: 'Newport Waterways',
            }),
        ).toBe(`The reviewed Newport Waterways canal exit is out of date. ${NEXT_STEP}`);
    });

    // Every other manual-required result from an applicable profile also used
    // to end "Choose Canal Exit on the chart." — a control Plan My Day lacks.
    it.each([
        ['an ambiguous area boundary', 'Departure is on an ambiguous channel-area boundary.'],
        ['conflicting exit records', 'Channel-exit records conflict.'],
        ['conflicting marker records', 'Channel-marker records conflict.'],
        ['a malformed in-area record', 'Reviewed channel-exit data is unavailable or out of date.'],
        ['no reviewed exit', 'No reviewed channel exit covers this departure.'],
    ])('never points Plan My Day at the chart control for %s', (_name, first) => {
        for (const control of ['Choose Canal Exit on the chart.', 'Choose Canal exit on the chart.']) {
            const refusal = dayPlannerCanalExitRefusal({ status: 'manual-required', reason: `${first} ${control}` });
            expect(refusal).toBe(`${first} ${NEXT_STEP}`);
            expect(refusal).not.toMatch(/on the chart/i);
        }
    });

    it('passes a reason with no chart instruction through unchanged', () => {
        const reason = 'Choose valid departure and destination positions before selecting a channel exit.';
        expect(dayPlannerCanalExitRefusal({ status: 'manual-required', reason })).toBe(reason);
    });

    it('rewords a real boundary refusal from the resolver (departure exactly on the area edge)', async () => {
        const edge = { lat: -20.3, lon: 148.8 };
        const { resolveAutomaticCanalExit } = await vi.importActual<typeof import('../services/automaticCanalExit')>(
            '../services/automaticCanalExit',
        );
        const area = {
            type: 'Polygon' as const,
            coordinates: [
                [
                    [148.7, -20.3],
                    [148.9, -20.3],
                    [148.9, -20.2],
                    [148.7, -20.2],
                    [148.7, -20.3],
                ],
            ],
        };
        const exit = resolveAutomaticCanalExit(edge, { lat: -20.1, lon: 149 }, [{ departureArea: area } as never]);
        expect(exit.status).toBe('manual-required');
        if (exit.status !== 'manual-required') return;
        expect(exit.reason).toMatch(/Choose Canal Exit on the chart\.$/);
        expect(dayPlannerCanalExitRefusal(exit)).not.toMatch(/on the chart/i);
    });

    it.each(invalidRings)(
        'refuses canal applicability from a $name even outside the departure area',
        async ({ ring }) => {
            withRoute();
            api.profiles.push({ departureArea: { type: 'Polygon', coordinates: [ring] } });
            await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('geometry');
            expect(api.calculate).not.toHaveBeenCalled();
            expect(api.resolveExit).not.toHaveBeenCalled();
        },
    );

    it('uses the verified canal wrapper and rechecks the source after calculation', async () => {
        withRoute();
        api.profiles.push({
            departureArea: {
                type: 'Polygon',
                coordinates: [
                    [
                        [148.7, -20.3],
                        [148.9, -20.3],
                        [148.9, -20.2],
                        [148.7, -20.2],
                        [148.7, -20.3],
                    ],
                ],
            },
        });
        const exit = {
            status: 'resolved',
            profileId: 'reviewed-pilot',
            label: 'Reviewed departure',
            sourceRevision: 'edition-1',
            validUntil: new Date(now + 86400000).toISOString(),
            gateCentres: [{ lat: -20.2, lon: 148.85 }],
            exit: { lat: -20.2, lon: 148.85 },
            outboundBearingDeg: 45,
        };
        api.resolveExit.mockReturnValue(exit);
        api.canal.mockImplementation(async (input) => route(input));
        await runDayPlanner(request(), vessel(), options());
        expect(api.canal).toHaveBeenCalledTimes(1);
        expect(api.canal.mock.calls[0][1]).toEqual(exit.exit);
        expect(api.canal.mock.calls[0][2]).toBe('test-map-token');
        expect(api.canal.mock.calls[0][5]).toBe(exit);
        expect(api.canal.mock.calls[0][6]).toBe(api.calculate);
        expect(api.verifyExit).toHaveBeenCalledTimes(2);
        expect(api.review).toHaveBeenCalledTimes(1);
        api.verifyExit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await expect(runDayPlanner(request(), vessel(), options())).rejects.toThrow('changed or expired');
        expect(api.calculate).not.toHaveBeenCalled();
    });

    it('fences a vessel mutation during provider work', async () => {
        withRoute();
        const currentVessel = vessel();
        api.calculate.mockImplementation(async (input) => {
            currentVessel.draft = 7;
            return route(input);
        });
        await expect(runDayPlanner(request(), currentVessel, options())).rejects.toThrow('vessel profile changed');
        expect(api.review).not.toHaveBeenCalled();
    });

    it('withholds late progress after completion', async () => {
        let lateProgress!: () => void;
        const onProgress = vi.fn();
        api.build.mockImplementation(async (_input, _candidates, _deps, runOptions) => {
            lateProgress = () =>
                runOptions.onProgress({ completed: 1, total: 1, destination: 'Test', phase: 'complete' });
            lateProgress();
            return emptyResult();
        });
        await runDayPlanner(request(), vessel(), { ...options(), onProgress });
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(() => lateProgress()).not.toThrow();
        expect(onProgress).toHaveBeenCalledTimes(1);
    });
});
