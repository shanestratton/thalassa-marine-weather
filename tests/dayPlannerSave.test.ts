import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialRoute, AutoroutingVesselProfile } from '../types/autorouting';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { autoroutingProposalGeometryKey } from '../services/autoroutingProposalEvidence';
import { prepareReviewedAutoroutingProposal } from '../services/autoroutingProposalSave';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';
import { buildDayPlan, type DayPlanRequest } from '../services/dayPlanner/engine';
import { saveDayPlan, type DayPlanSaveInput } from '../services/dayPlanner/save';
import { groupTracesByTrip, loadSavedTraces, saveTrace, saveTraceTrip } from '../services/routeTracer';

const mock = vi.hoisted(() => ({ registry: 'reviewed-charts', fingerprint: vi.fn(), push: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    getRegistryFingerprint: () => mock.fingerprint(),
}));
vi.mock('../services/savedRoutesSync', () => ({ pushSavedRoute: (...args: unknown[]) => mock.push(...args) }));

const NOW = Date.parse('2026-09-27T00:00:00Z');
const HOUR = 3_600_000;
const profile: AutoroutingVesselProfile = {
    length: { status: 'measured', valueM: 12 },
    beam: { status: 'measured', valueM: 4 },
    airDraft: { status: 'measured', valueM: 15 },
    draftStatus: 'measured',
};
const routesKey = () => authScopedStorageKey('thalassa_traced_routes_v1', getAuthIdentityScope());

async function fixture(mode: DayPlanRequest['mode'] = 'return'): Promise<DayPlanSaveInput> {
    const destination = WHITSUNDAYS_DAY_DESTINATIONS[0];
    const request: DayPlanRequest = {
        start: { label: 'Morning anchorage', lat: -20.2, lon: 148.99 },
        departureMs: NOW + HOUR,
        maxSailingHours: 8,
        stopHours: 1,
        mode,
        ...(mode === 'overnight' ? { overnightUntilMs: NOW + 20 * HOUR } : {}),
        activities: ['beach', 'lunch'],
        speedKts: 6,
        draftM: 1.5,
    };
    const result = await buildDayPlan(
        request,
        [{ destination, place: { ...destination, kind: 'anchorage', fetchLandNM: Array(36).fill(0) } }],
        {
            now: () => NOW,
            route: async (from, to) => {
                const route: AutoroutingTrialRoute = {
                    id: `${from.lat}:${to.lat}`,
                    provider: 'SevenCs',
                    createdAt: new Date(NOW).toISOString(),
                    coordinates: [
                        [from.lon, from.lat],
                        [to.lon, to.lat],
                    ],
                    warnings: ['Independently check the proposed route.'],
                    providerCheck: { status: 'not-reported', findings: [] },
                    vesselProfile: structuredClone(profile),
                    source: { rtz: 'raw licensed RTZ', geoJson: 'raw licensed GeoJSON' },
                };
                return {
                    route,
                    review: {
                        phase: 'complete',
                        basis: {
                            proposalId: route.id,
                            geometryKey: autoroutingProposalGeometryKey(route.coordinates),
                            draftM: request.draftM,
                            draftAssumed: false,
                            registryFingerprint: mock.registry,
                            vesselProfileKey: JSON.stringify(profile),
                            checkedAt: new Date(NOW).toISOString(),
                        },
                        legs: [
                            {
                                incomplete: false,
                                verdict: {
                                    grade: 'clear',
                                    minDepthM: 8,
                                    minAt: null,
                                    issues: [],
                                    needsTide: false,
                                    nudge: null,
                                    nudgeTo: null,
                                },
                            },
                        ],
                    },
                };
            },
            forecast: async (points) =>
                points.map((point) => ({
                    ...point,
                    fetchedAt: NOW,
                    hours: Array.from({ length: 169 }, (_, index) => ({
                        t: NOW + index * HOUR,
                        wind: 8,
                        gust: 10,
                        direction: 90,
                        weatherCode: 1,
                        waveM: 0.2,
                        waveDirection: 90,
                        wavePeriod: 4,
                    })),
                })),
        },
        { signal: new AbortController().signal },
    );
    expect(result.options).toHaveLength(1);
    return {
        option: structuredClone(result.options[0]),
        request,
        calculatedAt: result.calculatedAt,
        acknowledgedPlannedOnly: true,
        currentVesselProfile: structuredClone(profile),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    setAuthIdentityScope('day-plan-owner');
    mock.registry = 'reviewed-charts';
    mock.fingerprint.mockReset().mockImplementation(() => mock.registry);
    mock.push.mockReset().mockResolvedValue('ok');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

describe('atomic planned itinerary save', () => {
    it('refuses a result for a different explicitly selected destination before writing either leg', async () => {
        const input = await fixture();
        input.request.destinationIds = ['different-stop'];
        expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/selected destination changed/);
        expect(loadSavedTraces()).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('prepares exact review evidence without side effects', async () => {
        const input = await fixture();
        const leg = input.option.legs[0];
        const write = vi.spyOn(Storage.prototype, 'setItem');
        const prepared = prepareReviewedAutoroutingProposal(
            {
                name: 'A proposal',
                route: leg.route,
                review: leg.review,
                currentDraftM: 1.5,
                currentDraftAssumed: false,
                acknowledgedPlannedOnly: true,
            },
            getAuthIdentityScope(),
        );
        expect(prepared.points).toEqual(leg.route.coordinates.map(([lon, lat]) => ({ lat, lon })));
        expect(prepared.proposalEvidence.basis).not.toBe(leg.review.basis);
        expect(write).not.toHaveBeenCalled();
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('commits both legs once with stable trip identity, timing, sources and limitations', async () => {
        const old = saveTrace('Already saved', [
            { lat: -20.1, lon: 149 },
            { lat: -20.2, lon: 149 },
        ]);
        await old.cloud;
        mock.push.mockClear();
        const input = await fixture();
        const key = routesKey();
        const write = vi.spyOn(Storage.prototype, 'setItem');
        const changed = vi.fn(() => expect(loadSavedTraces()).toHaveLength(3));
        window.addEventListener('thalassa:saved-routes-changed', changed);
        try {
            const result = saveDayPlan(input, getAuthIdentityScope());
            expect(write.mock.calls.filter(([k]) => k === key)).toHaveLength(1);
            expect(changed).toHaveBeenCalledOnce();
            expect(result.traces.map((trace) => trace.legOrdinal)).toEqual([1, 2]);
            expect(result.traces.every((trace) => trace.tripId === result.traces[0].id)).toBe(true);
            expect(result.traces[0].id).not.toBe(result.traces[1].id);
            expect(result.traces.map((trace) => trace.name)).toEqual([
                'Morning anchorage → Whitehaven Beach',
                'Whitehaven Beach → Morning anchorage',
            ]);
            expect(result.traces.map((trace) => trace.destName)).toEqual(['Whitehaven Beach', 'Morning anchorage']);
            const stored = loadSavedTraces();
            expect(stored.find((trace) => trace.id === old.trace.id)).toEqual(old.trace);
            const trip = groupTracesByTrip(stored).find((group) => group.key === result.traces[0].id)!;
            expect(trip.legs).toHaveLength(2);
            for (const [index, trace] of trip.legs.entries()) {
                expect(trace.points).toEqual(
                    input.option.legs[index].route.coordinates.map(([lon, lat]) => ({ lat, lon })),
                );
                expect(trace.proposalEvidence!.warnings.join(' ')).toContain(`Itinerary leg ${index + 1}`);
                expect(trace.proposalEvidence!.warnings.join(' ')).toContain('AEST');
                expect(trace.proposalEvidence!.warnings.join(' ')).toContain('bring-your-own picnic');
                expect(trace.proposalEvidence!.warnings.join(' ')).toContain(
                    input.option.candidate.destination.sourceUrl,
                );
                expect(trace.verification).toBeUndefined();
                expect(trace.passageVoyageId).toBeUndefined();
                expect(trace.plannedRouteId).toBeUndefined();
            }
            expect(localStorage.getItem(key)).not.toContain('raw licensed');
            result.traces[0].points[0].lon = 0;
            input.option.legs[0].route.warnings[0] = 'caller changed';
            await expect(result.cloud).resolves.toEqual(['ok', 'ok']);
            expect(mock.push.mock.calls[0][0].points[0].lon).toBe(148.99);
            expect(mock.push.mock.calls[0][0].proposalEvidence.warnings).not.toContain('caller changed');
        } finally {
            window.removeEventListener('thalassa:saved-routes-changed', changed);
        }
    });

    it('saves an overnight option as one standalone planned route', async () => {
        const input = await fixture('overnight');
        const result = saveDayPlan(input, getAuthIdentityScope());
        expect(result.traces).toHaveLength(1);
        expect(result.traces[0].tripId).toBeUndefined();
        expect(result.traces[0].proposalEvidence!.warnings.join(' ')).toContain('overnight stop');
        await expect(result.cloud).resolves.toEqual(['ok']);
    });

    it('labels departure, stop and return in their explicit local zones and UTC offsets', async () => {
        const input = await fixture();
        input.request.timeZone = 'America/New_York';
        input.option.candidate.destination.timeZone = 'Europe/Paris';
        const result = saveDayPlan(input, getAuthIdentityScope());
        const outward = result.traces[0].proposalEvidence!.warnings.find((note) =>
            note.startsWith('Itinerary leg 1:'),
        )!;
        const returning = result.traces[1].proposalEvidence!.warnings.find((note) =>
            note.startsWith('Itinerary leg 2:'),
        )!;
        expect(outward).toMatch(/depart .*America\/New_York.*UTC-04:00.*arrive .*Europe\/Paris.*UTC\+02:00/);
        expect(returning).toMatch(/depart .*Europe\/Paris.*UTC\+02:00.*arrive .*America\/New_York.*UTC-04:00/);
        const stay = result.traces[0].proposalEvidence!.warnings.find((note) => note.startsWith('Stay at '))!;
        expect(stay.match(/Europe\/Paris/g)).toHaveLength(2);
        expect(stay).not.toContain('AEST');
        await result.cloud;
    });

    it.each(['destination', 'request'] as const)(
        'checks known closures in the %s zone before saving',
        async (source) => {
            const input = await fixture();
            input.request.timeZone = source === 'request' ? 'America/New_York' : 'Europe/London';
            input.option.candidate.destination.timeZone = source === 'destination' ? 'America/New_York' : undefined;
            input.option.candidate.destination.knownClosures = [
                {
                    fromDate: '2026-09-26',
                    throughDate: '2026-09-26',
                    reason: 'Destination-local closure',
                    sourceUrl: 'https://example.org/closure',
                },
            ];
            expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/Destination-local closure/);
            expect(loadSavedTraces()).toEqual([]);
            expect(mock.push).not.toHaveBeenCalled();
        },
    );

    it.each(['request', 'destination'] as const)('fails closed for an invalid %s time zone', async (source) => {
        const input = await fixture();
        if (source === 'request') input.request.timeZone = 'Mars/Olympus';
        else input.option.candidate.destination.timeZone = 'Mars/Olympus';
        expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/time zone/i);
        expect(loadSavedTraces()).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('saves unreviewed mapped-source limitations without inventing an activity verification date', async () => {
        const input = await fixture('overnight');
        input.option.candidate.destination.catalogueQuality = 'mapped-reference';
        input.option.candidate.destination.verifiedAt = undefined;
        input.option.light = 'unknown';
        input.option.conditions.light = 'unknown';
        input.option.conditions.reasons = [
            'Unreviewed mapped reference; permission, shelter and holding are unverified.',
        ];
        const saved = saveDayPlan(input, getAuthIdentityScope());
        const source = saved.traces[0].proposalEvidence!.warnings.find((note) =>
            note.startsWith('Destination source:'),
        )!;
        expect(source).toContain('unreviewed mapped reference');
        expect(source).not.toContain('facts reviewed');
        expect(source).not.toContain('undefined');
        await saved.cloud;
    });

    it('does not save falsely favourable mapped-reference assessments', async () => {
        const input = await fixture();
        input.option.candidate.destination.catalogueQuality = 'mapped-reference';
        expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/unassessed limitations/);
        expect(loadSavedTraces()).toEqual([]);
    });

    it('writes neither leg when a completed but incomplete review covers unsupported antimeridian geometry', async () => {
        const input = await fixture();
        const leg = input.option.legs[1];
        leg.route.coordinates = [
            [179.99, 0],
            [-179.99, 0],
        ];
        leg.review.basis!.geometryKey = autoroutingProposalGeometryKey(leg.route.coordinates);
        leg.review.legs[0]!.incomplete = true;
        leg.review.legs[0]!.verdict.grade = 'caution';
        leg.review.legs[0]!.verdict.minDepthM = null;
        leg.review.legs[0]!.verdict.issues = [{ severity: 'caution', message: 'This segment cannot be checked.' }];
        const write = vi.spyOn(Storage.prototype, 'setItem');
        expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/antimeridian/);
        expect(write).not.toHaveBeenCalled();
        expect(loadSavedTraces()).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it.each(['stale', 'danger', 'geometry', 'charts', 'evidence overflow'] as const)(
        'writes nothing when the second leg fails %s preflight',
        async (failure) => {
            const input = await fixture();
            const leg = input.option.legs[1];
            if (failure === 'stale') leg.review.basis!.checkedAt = new Date(NOW - 16 * 60_000).toISOString();
            if (failure === 'danger') leg.review.legs[0]!.verdict.grade = 'danger';
            if (failure === 'geometry') leg.review.basis!.geometryKey = 'changed';
            if (failure === 'charts') leg.review.basis!.registryFingerprint = 'old chart';
            if (failure === 'evidence overflow')
                leg.route.warnings = Array.from({ length: 501 }, (_, i) => `Warning ${i}`);
            const write = vi.spyOn(Storage.prototype, 'setItem');
            expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow();
            expect(write).not.toHaveBeenCalled();
            expect(loadSavedTraces()).toEqual([]);
            expect(mock.push).not.toHaveBeenCalled();
        },
    );

    it.each([
        'stale report',
        'stale weather',
        'stale transit weather',
        'departure passed',
        'profile',
        'draft',
        'red weather',
        'schedule',
        'invalid totals',
        'unacknowledged',
    ] as const)('rejects %s without persisting any itinerary', async (failure) => {
        const input = await fixture();
        if (failure === 'stale report') input.calculatedAt = NOW - 16 * 60_000;
        if (failure === 'stale weather') input.option.conditions.fetchedAt = NOW - 16 * 60_000;
        if (failure === 'stale transit weather') {
            // The stop is fresh; a cached transit cell was already 4 minutes old
            // at calculation, so it reaches 16 minutes before this save.
            vi.setSystemTime(NOW + 12 * 60_000);
            input.option.transit.fetchedAt = NOW - 4 * 60_000;
        }
        if (failure === 'departure passed') vi.setSystemTime(input.request.departureMs + 1);
        if (failure === 'profile') input.currentVesselProfile!.beam = { status: 'measured', valueM: 8 };
        if (failure === 'draft') input.request.draftM = 2;
        if (failure === 'red weather') input.option.transit.light = 'red';
        if (failure === 'schedule') input.option.stayToMs += HOUR;
        if (failure === 'invalid totals') input.option.sailingHours = NaN;
        if (failure === 'unacknowledged') input.acknowledgedPlannedOnly = false;
        expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow();
        expect(loadSavedTraces()).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('retains fresh unknown forecast limitations in a planned-only save', async () => {
        const input = await fixture('overnight');
        input.option.conditions.light = 'unknown';
        input.option.conditions.fetchedAt = undefined;
        input.option.conditions.reasons = ['Fresh local forecast unavailable.'];
        input.option.light = 'unknown';
        const result = saveDayPlan(input, getAuthIdentityScope());
        expect(result.traces[0].proposalEvidence!.warnings.join(' ')).toContain('Fresh local forecast unavailable');
        await result.cloud;
    });

    it.each([
        'draft',
        'speed',
        'wind',
        'wave',
        'missing draft',
        'missing speed',
        'invalid wind',
        'invalid wave',
    ] as const)(
        'refuses changed or invalid current vessel %s values independently of profile status',
        async (change) => {
            const input = await fixture();
            input.currentVesselInputs = { draftM: 1.5, speedKts: 6, maxWindKts: 25, maxWaveM: 2 };
            if (change === 'draft') input.currentVesselInputs.draftM = 2;
            if (change === 'speed') input.currentVesselInputs.speedKts = 7;
            if (change === 'wind') input.currentVesselInputs.maxWindKts = 15;
            if (change === 'wave') input.currentVesselInputs.maxWaveM = 1;
            if (change === 'missing draft')
                delete (input.currentVesselInputs as Partial<typeof input.currentVesselInputs>).draftM;
            if (change === 'missing speed')
                delete (input.currentVesselInputs as Partial<typeof input.currentVesselInputs>).speedKts;
            if (change === 'invalid wind') input.currentVesselInputs.maxWindKts = NaN;
            if (change === 'invalid wave') input.currentVesselInputs.maxWaveM = 0;
            expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/Vessel draft, speed or weather limits/);
            expect(loadSavedTraces()).toEqual([]);
            expect(mock.push).not.toHaveBeenCalled();
        },
    );

    it('accepts current vessel inputs when request limits remain at least as conservative', async () => {
        const input = await fixture();
        input.currentVesselInputs = { draftM: 1.5, speedKts: 6, maxWindKts: 25, maxWaveM: 2 };
        const saved = saveDayPlan(input, getAuthIdentityScope());
        await expect(saved.cloud).resolves.toEqual(['ok', 'ok']);
    });

    it('does not push either leg or notify if storage rejects the one atomic write', async () => {
        const input = await fixture();
        const key = routesKey();
        const original = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, keyArg, value) {
            if (keyArg === key) throw new DOMException('Full', 'QuotaExceededError');
            return original.call(this, keyArg, value);
        });
        const changed = vi.fn();
        window.addEventListener('thalassa:saved-routes-changed', changed);
        try {
            expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/Device storage/);
            await Promise.resolve();
            expect(mock.push).not.toHaveBeenCalled();
            expect(changed).not.toHaveBeenCalled();
            expect(loadSavedTraces()).toEqual([]);
        } finally {
            window.removeEventListener('thalassa:saved-routes-changed', changed);
        }
    });

    it('fences account changes before and during preflight, with no partial first-leg save', async () => {
        const input = await fixture();
        const scope = getAuthIdentityScope();
        setAuthIdentityScope('other-owner');
        expect(() => saveDayPlan(input, scope)).toThrow(/account changed/);
        setAuthIdentityScope('day-plan-owner');
        const current = getAuthIdentityScope();
        mock.fingerprint
            .mockImplementationOnce(() => mock.registry)
            .mockImplementationOnce(() => {
                setAuthIdentityScope('third-owner');
                return mock.registry;
            });
        expect(() => saveDayPlan(input, current)).toThrow(/account changed/);
        expect(loadSavedTraces(current)).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('does not start cloud pushes after an account switch following local commit', async () => {
        const input = await fixture();
        const result = saveDayPlan(input, getAuthIdentityScope());
        setAuthIdentityScope('other-owner');
        await expect(result.cloud).resolves.toEqual(['stale', 'stale']);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('refuses cap overflow without silently evicting existing routes', async () => {
        const input = await fixture();
        const key = routesKey();
        const old = Array.from({ length: 49 }, (_, index) => ({
            id: `old-${index}`,
            name: `Old ${index}`,
            createdAt: new Date(NOW - HOUR).toISOString(),
            points: [
                { lat: -20, lon: 149 },
                { lat: -20.1, lon: 149 },
            ],
        }));
        const before = JSON.stringify(old);
        localStorage.setItem(key, before);
        expect(() => saveDayPlan(input, getAuthIdentityScope())).toThrow(/full/);
        expect(localStorage.getItem(key)).toBe(before);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('validates both low-level evidence rows before a write and preserves unreadable existing storage', async () => {
        const input = await fixture();
        const rows = input.option.legs.map((leg) =>
            prepareReviewedAutoroutingProposal(
                {
                    name: leg.route.id,
                    route: leg.route,
                    review: leg.review,
                    currentDraftM: 1.5,
                    currentDraftAssumed: false,
                    acknowledgedPlannedOnly: true,
                },
                getAuthIdentityScope(),
            ),
        );
        rows[1].points[0].lat = NaN;
        expect(() => saveTraceTrip(rows, getAuthIdentityScope())).toThrow(/evidence/);
        expect(loadSavedTraces()).toEqual([]);
        const key = routesKey();
        localStorage.setItem(key, '{not json');
        expect(() => saveTraceTrip([rows[0]], getAuthIdentityScope())).toThrow(/could not be read/);
        expect(localStorage.getItem(key)).toBe('{not json');
        expect(mock.push).not.toHaveBeenCalled();
    });
});
