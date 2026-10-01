import { describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TrialRouteReview } from '../services/autoroutingReview';
import type { ConditionsForecast, ConditionsHour } from '../services/anchorages/placeConditions';
import type { CatalogueRouteConstraint } from '../services/dayPlanner/cataloguePlanningTypes';
import {
    assessDayPlanRoute,
    assessDayPlanTransit,
    buildDayPlan,
    buildFlexibleDayPlan,
    dayPlanDistanceNM,
    dayPlanRouteDistanceNM,
    sampleDayPlanTransit,
    validateDayPlanRequest,
    type DayPlanCandidate,
    type DayPlanLeg,
    type DayPlanPoint,
    type DayPlanRequest,
    type DayPlannerDependencies,
} from '../services/dayPlanner/engine';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-27T00:00:00Z');
const start = { lat: -20.2, lon: 148.8, label: 'Start' };
const signal = () => new AbortController().signal;
const request = (extra: Partial<DayPlanRequest> = {}): DayPlanRequest => ({
    start,
    departureMs: NOW + HOUR,
    maxSailingHours: 4,
    stopHours: 1,
    mode: 'return',
    activities: ['beach'],
    speedKts: 6,
    draftM: 1.5,
    ...extra,
});
const candidate = (id = 'a', latitude = -20.15): DayPlanCandidate => ({
    destination: {
        id,
        name: `Beach ${id}`,
        lat: latitude,
        lon: 148.8,
        activities: ['beach'],
        summary: 'A documented beach stop.',
        sourceUrl: 'https://parks.qld.gov.au/example',
        sourceLabel: 'Park source',
        verifiedAt: '2026-09-27',
        accessNotes: ['Check shore access.'],
        uncertaintyNotes: ['Confirm local restrictions.'],
        anchorageId: id,
        anchorageName: `Anchorage ${id}`,
        referencePosition: 'existing-anchorage',
    },
    place: { id, lat: latitude, lon: 148.8, kind: 'anchorage', fetchLandNM: Array(36).fill(0) },
});
const route = (from: DayPlanPoint, to: DayPlanPoint, middle: [number, number][] = []): AutoroutingTrialRoute => ({
    id: `${from.lat}:${to.lat}`,
    coordinates: [[from.lon, from.lat], ...middle, [to.lon, to.lat]],
    warnings: [],
    createdAt: new Date(NOW).toISOString(),
    provider: 'Thalassa',
    engine: {
        stateMask: [...middle, [to.lon, to.lat]].map(() => 'green' as const),
        cellsUsed: ['OC-99-SYN001'],
        distanceNM: 1,
        elapsedMs: 10,
        backstop: 'verified',
    },
});
const review = (proposal: AutoroutingTrialRoute): TrialRouteReview => ({
    phase: 'complete',
    legs: proposal.coordinates.slice(1).map(() => ({
        incomplete: false,
        verdict: {
            grade: 'clear',
            issues: [],
            minDepthM: 8,
            minAt: null,
            needsTide: false,
            nudge: null,
            nudgeTo: null,
        },
    })),
});
const weather = (point: DayPlanPoint, change: Partial<ConditionsHour> = {}): ConditionsForecast => ({
    ...point,
    fetchedAt: NOW,
    hours: Array.from({ length: 169 }, (_, index) => ({
        t: NOW + index * HOUR,
        wind: 8,
        gust: 10,
        direction: 90,
        waveM: 0.2,
        waveDirection: 90,
        wavePeriod: 4,
        weatherCode: 1,
        ...change,
    })),
});
const dependencies = (extra: Partial<DayPlannerDependencies> = {}): DayPlannerDependencies => ({
    route: vi.fn(async (from, to) => {
        const proposal = route(from, to);
        return { route: proposal, review: review(proposal) };
    }),
    forecast: vi.fn(async (points: DayPlanPoint[]) => points.map((point) => weather(point))),
    now: () => NOW,
    ...extra,
});
const build = (req = request(), list = [candidate()], deps = dependencies()) =>
    buildDayPlan(req, list, deps, { signal: signal() });
const withCatalogue = (id = 'a', bendLon = 148.81): DayPlanCandidate => {
    const result = candidate(id);
    const chain = (direction: 'outbound' | 'return'): CatalogueRouteConstraint => ({
        variant: { id: `00000000-0000-4000-8000-00000000000${direction === 'outbound' ? '1' : '2'}`, version: 1 },
        direction,
        checkpoints: (direction === 'outbound'
            ? [start, { lat: -20.175, lon: bendLon }, result.destination]
            : [result.destination, { lat: -20.175, lon: bendLon + 0.01 }, start]
        ).map((point, index) => ({
            lat: point.lat,
            lon: point.lon,
            sequence: index + 1,
            required: true,
            name: `Point ${index}`,
            evidenceNote: 'Synthetic fixture',
        })),
    });
    result.catalogue = {
        mode: 'return',
        selection: { id: '00000000-0000-4000-8000-000000000003', version: 1 },
        details: [],
        outbound: chain('outbound'),
        return: chain('return'),
    };
    const binding = result.catalogue;
    binding.details = [binding.outbound!, binding.return!].map((constraint) => ({
        ...constraint.variant,
        kind: 'route_variant',
        name: 'Synthetic route variant',
        summary: 'Synthetic fixture only.',
        position: { lat: constraint.checkpoints[0].lat, lon: constraint.checkpoints[0].lon },
        review: {
            reviewedAt: new Date(NOW).toISOString(),
            reviewDueAt: new Date(NOW + 24 * HOUR).toISOString(),
            reviewerLabel: 'Fixture',
            scope: 'Synthetic test',
        },
        evidence: [
            {
                sourceUrl: 'https://example.org/test',
                sourceLabel: 'Fixture',
                retrievedAt: new Date(NOW).toISOString(),
                licence: 'Fixture',
                licenceUrl: 'https://example.org/licence',
                attribution: 'Fixture',
                scope: 'Synthetic test',
            },
        ],
        limitations: ['Current clearance remains unverified.'],
        activities: [],
        trip: binding.selection,
        direction: constraint.direction,
        checkpoints: structuredClone(constraint.checkpoints),
    }));
    result.destination.catalogueQuality = 'catalogue-reference';
    result.destination.referencePosition = 'catalogue-reference';
    return result;
};
const catalogueDependencies = (): DayPlannerDependencies =>
    dependencies({
        route: vi.fn(
            async (
                from: DayPlanPoint,
                to: DayPlanPoint,
                _signal: AbortSignal,
                constraint?: CatalogueRouteConstraint,
            ) => {
                const proposal = route(
                    from,
                    to,
                    constraint?.checkpoints.slice(1, -1).map((point) => [point.lon, point.lat]),
                );
                return { route: proposal, review: review(proposal) };
            },
        ),
    });

describe('day planner deterministic itinerary construction', () => {
    it('keeps independent directional catalogue constraints and unknown stop suitability', async () => {
        const destination = withCatalogue();
        const deps = catalogueDependencies();
        const result = await build(
            request({ catalogueSelection: destination.catalogue!.selection, activities: ['quiet'] }),
            [destination],
            deps,
        );
        expect(result.options).toHaveLength(1);
        expect(deps.route).toHaveBeenNthCalledWith(
            1,
            start,
            destination.destination,
            expect.any(AbortSignal),
            destination.catalogue!.outbound,
        );
        expect(deps.route).toHaveBeenNthCalledWith(
            2,
            destination.destination,
            start,
            expect.any(AbortSignal),
            destination.catalogue!.return,
        );
        expect(result.options[0].conditions.light).toBe('unknown');
        expect(result.options[0].light).toBe('unknown');
    });

    it('excludes catalogue trips with no explicit return and provider shortcuts', async () => {
        const destination = withCatalogue();
        delete destination.catalogue!.return;
        const deps = catalogueDependencies();
        const missing = await build(request(), [destination], deps);
        expect(missing.excluded[0].reason).toMatch(/no separately reviewed return/);
        expect(deps.route).not.toHaveBeenCalled();
        const shortcut = await build(request(), [withCatalogue()], dependencies());
        expect(shortcut.options).toHaveLength(0);
        expect(shortcut.excluded[0].reason).toMatch(/every required catalogue checkpoint/);
    });

    it.each(['outbound', 'return'] as const)(
        'rejects recognized tide dependency in the selected %s variant even if the provider omits its warning',
        async (direction) => {
            const destination = withCatalogue();
            const detail = destination.catalogue!.details.find(
                (entry) => entry.kind === 'route_variant' && entry.direction === direction,
            )!;
            detail.limitations = ['This passage requires a tide window.'];
            const result = await build(request(), [destination], catalogueDependencies());
            expect(result.options).toHaveLength(0);
            expect(result.excluded[0].reason).toMatch(/tide or tidal clearance/);
        },
    );

    it('keeps destination shore-access tide notes separate from directional route limitations', async () => {
        const destination = withCatalogue();
        destination.destination.accessNotes.push('Shore landing requires a tide window.');
        const result = await build(request(), [destination], catalogueDependencies());
        expect(result.options).toHaveLength(1);
    });

    it('rejects a selected catalogue identity changing before engine use', async () => {
        const destination = withCatalogue();
        await expect(
            build(
                request({ catalogueSelection: { ...destination.catalogue!.selection, version: 2 } }),
                [destination],
                catalogueDependencies(),
            ),
        ).rejects.toThrow(/exact selected/);
    });

    it('includes required detours and origin connectors in the pre-routing sailing budget', async () => {
        const destination = withCatalogue();
        destination.catalogue!.outbound!.checkpoints[0].lon += 5;
        const deps = catalogueDependencies();
        const result = await build(request(), [destination], deps);
        expect(result.options).toHaveLength(0);
        expect(result.excluded[0].reason).toMatch(/Outside the sailing budget/);
        expect(deps.route).not.toHaveBeenCalled();
    });

    it('memoizes flexible routes by the entire variant chain even when endpoints match', async () => {
        const deps = catalogueDependencies();
        const result = await buildFlexibleDayPlan(
            request({ flexibleStart: true }),
            [withCatalogue('a', 148.81), withCatalogue('b', 148.82)],
            deps,
            { signal: signal() },
        );
        expect(result.options).toHaveLength(2);
        expect(deps.route).toHaveBeenCalledTimes(4);
        const middle = result.options.map((option) => option.legs[0].route.coordinates[1][0]).sort();
        expect(middle).toEqual([148.81, 148.82]);
    });

    it('uses exact routed distances, independently requests the return and excludes stop time from sailing', async () => {
        const dest = candidate();
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, to, from.lat === start.lat ? [] : [[148.81, -20.175]]);
                return { route: proposal, review: review(proposal) };
            }),
        });
        const [option] = (await build(request(), [dest], deps)).options;
        expect(deps.route).toHaveBeenNthCalledWith(1, start, dest.destination, expect.any(AbortSignal));
        expect(deps.route).toHaveBeenNthCalledWith(2, dest.destination, start, expect.any(AbortSignal));
        expect(option.legs).toHaveLength(2);
        expect(option.legs[1].route.coordinates).toHaveLength(3);
        expect(option.distanceNM).toBeCloseTo(
            option.legs.reduce((sum, leg) => sum + dayPlanRouteDistanceNM(leg.route.coordinates), 0),
            10,
        );
        expect(option.sailingHours).toBeCloseTo(option.distanceNM / 6, 10);
        expect(option.stayToMs - option.stayFromMs).toBe(HOUR);
        expect(option.finishMs - option.departureMs).toBeCloseTo((option.sailingHours + 1) * HOUR, 2);
        expect(option.legs[1].departureMs).toBe(option.stayToMs);
        expect(option.transit.light).toBe('green');
        expect(option.conditions.light).toBe('green');
        expect(option.light).toBe('amber');
        expect(option.warnings.join(' ')).toMatch(/a proposal is never navigation clearance/);
    });

    it('counts route detours and the independently routed return against the total sailing budget', async () => {
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, to, from.lat === start.lat ? [] : [[148.91, -20.17]]);
                return { route: proposal, review: review(proposal) };
            }),
        });
        const result = await build(request({ maxSailingHours: 1.1 }), [candidate()], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/Actual route sailing time/);
        expect(deps.route).toHaveBeenCalledTimes(2);
        expect(deps.forecast).not.toHaveBeenCalled();
    });

    it('never uses a reversed outbound path when return routing fails', async () => {
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                if (from.lat !== start.lat) throw new Error('Return route unavailable');
                const proposal = route(from, to);
                return { route: proposal, review: review(proposal) };
            }),
        });
        const result = await build(request(), [candidate()], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded).toEqual([{ name: 'Beach a', reason: 'Return route unavailable' }]);
    });

    it('stays overnight at the same documented stop through the requested morning', async () => {
        const deps = dependencies();
        const req = request({ mode: 'overnight', overnightUntilMs: NOW + 25 * HOUR });
        const [option] = (await build(req, [candidate()], deps)).options;
        expect(deps.route).toHaveBeenCalledTimes(1);
        expect(option.legs).toHaveLength(1);
        expect(option.stayFromMs).toBe(option.arrivalMs);
        expect(option.stayToMs).toBe(req.overnightUntilMs);
        expect(option.conditions.fromMs).toBe(option.stayFromMs);
        expect(option.conditions.toMs).toBe(req.overnightUntilMs);
        expect(option.finishMs).toBe(req.overnightUntilMs);
        expect(option.sailingHours).toBeCloseTo(option.legs[0].distanceNM / 6);
    });

    it('rejects overnight arrival too late for the requested stop and misses the return deadline', async () => {
        const overnight = await build(request({ mode: 'overnight', overnightUntilMs: NOW + 2 * HOUR }));
        expect(overnight.options).toEqual([]);
        expect(overnight.excluded[0].reason).toMatch(/less than the requested stop duration/);
        const returning = await build(request({ returnByMs: NOW + 2.5 * HOUR }));
        expect(returning.options).toEqual([]);
        expect(returning.excluded[0].reason).toMatch(/return deadline/);
    });

    it('filters activities and range, routes only four destinations and returns all qualifying assessed options', async () => {
        const list = Array.from({ length: 6 }, (_, index) => candidate(String(index), -20.19 + index * 0.005));
        const wrongActivity = candidate('wrong');
        wrongActivity.destination.activities = ['walk'];
        const tooFar = candidate('far', -19);
        const deps = dependencies();
        const result = await build(request(), [...list, wrongActivity, tooFar], deps);
        expect(deps.route).toHaveBeenCalledTimes(8);
        expect(deps.forecast).toHaveBeenCalledTimes(4);
        expect(result.options.map((option) => option.candidate.destination.id)).toEqual(['0', '1', '2', '3']);
        expect(result.excluded).toHaveLength(4);
        expect(result.excluded.find((entry) => entry.name === 'Beach 4')?.reason).toMatch(/^Not assessed:/);
        expect(result.excluded.find((entry) => entry.name === 'Beach wrong')?.reason).toMatch(/activity/);
        expect(result.excluded.find((entry) => entry.name === 'Beach far')?.reason).toMatch(/sailing budget/);
    });

    it('treats empty activities as no preference without changing safety checks', async () => {
        const walking = candidate('walking');
        walking.destination.activities = ['walk'];
        const restricted = candidate('restricted');
        restricted.place.noAnchoring = true;
        const result = await build(request({ activities: [] }), [walking, restricted]);
        expect(result.options.map((option) => option.candidate.destination.id)).toEqual(['walking']);
        expect(result.excluded[0].reason).toMatch(/no-anchoring/);
    });

    it('checks an explicit destination outside the normal shortlist even when activity tags differ', async () => {
        const list = Array.from({ length: 6 }, (_, index) => candidate(String(index), -20.19 + index * 0.005));
        list[5].destination.activities = ['walk'];
        const deps = dependencies();
        const result = await build(request({ destinationIds: ['5'] }), list, deps);
        expect(result.options.map((option) => option.candidate.destination.id)).toEqual(['5']);
        expect(result.excluded).toEqual([]);
        expect(deps.route).toHaveBeenCalledTimes(2);
        expect(deps.route).toHaveBeenNthCalledWith(1, start, list[5].destination, expect.any(AbortSignal));
    });

    it('never falls back to other stops when a selected destination is missing or ambiguous', async () => {
        for (const list of [[candidate('other')], [candidate('selected'), candidate('selected')]]) {
            const deps = dependencies();
            await expect(build(request({ destinationIds: ['selected'] }), list, deps)).rejects.toThrow(
                /unavailable or ambiguous/,
            );
            expect(deps.route).not.toHaveBeenCalled();
        }
    });

    it('does not let an explicit destination bypass budget, closures or unsafe route checks', async () => {
        const req = request({ destinationIds: ['chosen'] });
        const tooFar = await build(req, [candidate('chosen', -19)]);
        expect(tooFar.options).toEqual([]);
        expect(tooFar.excluded[0].reason).toMatch(/sailing budget/);
        const closed = candidate('chosen');
        closed.destination.knownClosures = [
            {
                fromDate: '2026-09-27',
                throughDate: '2026-09-27',
                reason: 'Closed today',
                sourceUrl: 'https://parks.qld.gov.au/example',
            },
        ];
        const closedResult = await build(req, [closed]);
        expect(closedResult.options).toEqual([]);
        expect(closedResult.excluded[0].reason).toMatch(/Closed today/);
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, to);
                // The router's classifications did not arrive intact.
                proposal.engine!.stateMask = null;
                return { route: proposal, review: review(proposal) };
            }),
        });
        const unsafe = await build(req, [candidate('chosen')], deps);
        expect(unsafe.options).toEqual([]);
        expect(unsafe.excluded[0].reason).toMatch(/safety classifications/);
        expect(deps.forecast).not.toHaveBeenCalled();
    });

    // Review fix-ups, 2026-10-01: a leg over charted land, or red with no
    // charted depth behind it, is never planned — the independent review
    // graded such a leg 'caution', which rated it amber.
    it('excludes a stop whose leg crosses charted land or is red with no charted depth', async () => {
        const req = request({ destinationIds: ['chosen'] });
        for (const [mutate, reason] of [
            [
                (p: ReturnType<typeof route>) => {
                    p.engine!.hardLandAwayM = 400;
                },
                /crosses charted land/,
            ],
            [
                (p: ReturnType<typeof route>) => {
                    const n = p.engine!.stateMask!.length;
                    p.engine!.stateMask = p.engine!.stateMask!.map((_, i) => (i === 0 ? 'danger' : 'green'));
                    p.engine!.cautionMask = Array.from({ length: n }, (_, i) => i === 0);
                    p.engine!.chartedShallowMask = Array.from({ length: n }, () => false);
                },
                /red with no charted depth/,
            ],
        ] as const) {
            const deps = dependencies({
                route: vi.fn(async (from, to) => {
                    const proposal = route(from, to);
                    mutate(proposal);
                    return { route: proposal, review: review(proposal) };
                }),
            });
            const result = await build(req, [candidate('chosen')], deps);
            expect(result.options).toEqual([]);
            expect(result.excluded[0].reason).toMatch(reason);
        }
    });

    it('ranks checked amber coverage before shorter unknown coverage, then by actual sailing time', async () => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point, index) => (index === 0 && point.lat === -20.19 ? undefined : weather(point))),
            ),
        });
        const result = await build(request(), [candidate('near', -20.19), candidate('far', -20.15)], deps);
        expect(result.options.map((option) => [option.candidate.destination.id, option.light])).toEqual([
            ['far', 'amber'],
            ['near', 'unknown'],
        ]);
    });

    it('does not mutate the request, candidates, provider geometry or reviews', async () => {
        const req = request();
        const list = [candidate()];
        const supplied: { route: AutoroutingTrialRoute; review: TrialRouteReview }[] = [];
        const snapshots: string[] = [];
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, to);
                const value = { route: proposal, review: review(proposal) };
                supplied.push(value);
                snapshots.push(JSON.stringify(value));
                return value;
            }),
        });
        const original = JSON.stringify({ req, list });
        await build(req, list, deps);
        expect(JSON.stringify({ req, list })).toBe(original);
        expect(supplied.map((value) => JSON.stringify(value))).toEqual(snapshots);
    });
});

describe('day planner eligibility and missing chart evidence', () => {
    it.each(['unverified-line', 'local-danger', 'tide', 'depth', 'checking', 'stale'] as const)(
        'excludes %s',
        async (kind) => {
            const deps = dependencies({
                route: vi.fn(async (from, to) => {
                    const proposal = route(from, to);
                    const checked = review(proposal);
                    if (kind === 'unverified-line') delete proposal.engine;
                    if (kind === 'local-danger')
                        checked.legs[0]!.verdict.issues.push({ severity: 'danger', message: 'Charted obstruction' });
                    if (kind === 'tide') checked.legs[0]!.verdict.needsTide = true;
                    if (kind === 'depth') checked.legs[0]!.verdict.minDepthM = 1;
                    if (kind === 'checking' || kind === 'stale') checked.phase = kind;
                    return { route: proposal, review: checked };
                }),
            });
            const result = await build(request(), [candidate()], deps);
            expect(result.options).toEqual([]);
            expect(result.excluded).toHaveLength(1);
            expect(deps.forecast).not.toHaveBeenCalled();
        },
    );

    it('preserves incomplete local coverage as an unknown advisory option', async () => {
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, to);
                const checked = review(proposal);
                checked.legs[0] = null;
                return { route: proposal, review: checked };
            }),
        });
        const [option] = (await build(request(), [candidate()], deps)).options;
        expect(option.routeCheck.light).toBe('unknown');
        expect(option.light).toBe('unknown');
        expect(option.warnings.join(' ')).toMatch(/coverage is incomplete/);
    });

    it('rejects endpoint mismatch and malformed geometry instead of manufacturing route geometry', async () => {
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, { ...to, lat: to.lat + 0.001 });
                return { route: proposal, review: review(proposal) };
            }),
        });
        expect((await build(request(), [candidate()], deps)).excluded[0].reason).toMatch(/within 20 metres/);
        expect(() =>
            dayPlanRouteDistanceNM([
                [148.8, -20.2],
                [NaN, -20.1],
            ]),
        ).toThrow(/invalid positions/);
        expect(() => dayPlanRouteDistanceNM([[148.8, -20.2]])).toThrow(/geometry/);
        expect(() =>
            dayPlanRouteDistanceNM([
                [148.8, -20.2],
                [148.8, -20.2],
            ]),
        ).toThrow(/distance/);
    });

    it.each([1, -1])('rejects unsupported antimeridian routes in either direction (%s)', async (direction) => {
        const origin = { lat: 0, lon: 179.99 * direction, label: 'Dateline start' };
        const dest = candidate('dateline', 0);
        dest.destination.lon = -179.99 * direction;
        dest.place.lon = dest.destination.lon;
        const proposal = route(origin, dest.destination);
        const checked = review(proposal);
        checked.legs[0]!.incomplete = true;
        checked.legs[0]!.verdict.grade = 'caution';
        checked.legs[0]!.verdict.minDepthM = null;
        checked.legs[0]!.verdict.issues = [{ severity: 'caution', message: 'This segment cannot be checked.' }];
        expect(() => dayPlanRouteDistanceNM(proposal.coordinates)).toThrow(/antimeridian/);
        expect(() => assessDayPlanRoute(proposal, checked, 1.5)).toThrow(/antimeridian/);
        const deps = dependencies({ route: vi.fn(async () => ({ route: proposal, review: checked })) });
        const result = await build(request({ start: origin }), [dest], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded).toEqual([
            { name: dest.destination.name, reason: expect.stringMatching(/antimeridian/) },
        ]);
        expect(deps.forecast).not.toHaveBeenCalled();
    });

    it('rejects an internal antimeridian segment even when both route endpoints share a hemisphere', () => {
        const proposal = route({ lat: 0, lon: 179.9 }, { lat: 0.01, lon: 179.9 }, [[-179.9, 0.005]]);
        expect(() => dayPlanRouteDistanceNM(proposal.coordinates)).toThrow(/antimeridian/);
        expect(() => assessDayPlanRoute(proposal, review(proposal), 1.5)).toThrow(/antimeridian/);
        expect(
            dayPlanRouteDistanceNM([
                [179.9, 0],
                [179.99, 0],
            ]),
        ).toBeGreaterThan(0);
    });

    it('excludes a mapped no-anchoring stop before routing or fetching weather', async () => {
        const dest = candidate();
        dest.place.noAnchoring = true;
        const deps = dependencies();
        const result = await build(request(), [dest], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/no-anchoring/);
        expect(deps.route).not.toHaveBeenCalled();
        expect(deps.forecast).not.toHaveBeenCalled();
    });

    it('applies closures by Queensland calendar dates, including a stay crossing local midnight', async () => {
        const dest = candidate();
        dest.destination.knownClosures = [
            {
                fromDate: '2026-09-28',
                throughDate: '2026-09-29',
                reason: 'Park closed',
                sourceUrl: 'https://parks.qld.gov.au/example',
            },
        ];
        const req = request({ departureMs: NOW + 13 * HOUR });
        const result = await build(req, [dest]);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/Park closed/);
    });

    it('uses the destination zone for a stay crossing midnight even when the departure zone has another date', async () => {
        const dest = candidate();
        dest.destination.timeZone = 'Pacific/Auckland';
        dest.destination.knownClosures = [
            {
                fromDate: '2026-09-28',
                throughDate: '2026-09-28',
                reason: 'Local closure',
                sourceUrl: 'https://example.org/closure',
            },
        ];
        const result = await build(request({ timeZone: 'Europe/London', departureMs: NOW + 10 * HOUR }), [dest]);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/Local closure/);
    });

    it('falls back to the request zone for destination closures and preserves legacy Brisbane otherwise', async () => {
        const dest = candidate();
        dest.destination.knownClosures = [
            {
                fromDate: '2026-09-26',
                throughDate: '2026-09-26',
                reason: 'Previous local date',
                sourceUrl: 'https://example.org/closure',
            },
        ];
        const local = await build(request({ timeZone: 'America/New_York' }), [dest]);
        expect(local.options).toEqual([]);
        expect(local.excluded[0].reason).toMatch(/Previous local date/);
        expect((await build(request(), [dest])).options).toHaveLength(1);
    });

    it('rejects invalid request or destination zones before routing', async () => {
        const deps = dependencies();
        await expect(build(request({ timeZone: 'Mars/Olympus' }), [candidate()], deps)).rejects.toThrow(/time zone/);
        const dest = candidate();
        dest.destination.timeZone = 'Mars/Olympus';
        const result = await build(request(), [dest], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/time zone/);
        expect(deps.route).not.toHaveBeenCalled();
    });

    it('keeps unreviewed mapped references unknown despite favourable charts and weather, including flexible comparisons', async () => {
        const dest = candidate();
        dest.destination.catalogueQuality = 'mapped-reference';
        dest.destination.verifiedAt = undefined;
        const fixed = await build(request(), [dest]);
        expect(fixed.options[0].conditions.light).toBe('unknown');
        expect(fixed.options[0].light).toBe('unknown');
        expect(fixed.options[0].warnings.join(' ')).toContain('permission, activities, shelter or holding');
        const flexible = await buildFlexibleDayPlan(request({ flexibleStart: true }), [dest], dependencies(), {
            signal: signal(),
        });
        expect(flexible.options[0].conditions.light).toBe('unknown');
        expect(flexible.options[0].light).toBe('unknown');
    });

    it('does not downgrade known adverse mapped-reference weather to unknown', async () => {
        const dest = candidate();
        dest.destination.catalogueQuality = 'mapped-reference';
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) => points.map((point) => weather(point, { gust: 40 }))),
        });
        const result = await build(request(), [dest], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/gust/i);
    });

    it('excludes a catalogue stop whose checkpoints Auto cannot follow, while another stop still plans', async () => {
        // services/dayPlanner/runtime DAY_PLANNER_CHECKPOINTS_UNSUPPORTED (2026-10-01).
        const plain = 'This catalogue trip needs checkpoints Auto cannot follow yet. Plot it in Manual.';
        const deps = dependencies({
            route: vi.fn(async (from: DayPlanPoint, to: DayPlanPoint, _signal: AbortSignal, constraint?: unknown) => {
                if (constraint) throw new Error(plain);
                const proposal = route(from, to);
                return { route: proposal, review: review(proposal) };
            }),
        });
        const trip = withCatalogue('trip');
        const result = await build(request(), [trip, candidate('works', -20.15)], deps);
        expect(result.options.map((option) => option.candidate.destination.id)).toEqual(['works']);
        expect(result.excluded).toContainEqual({ name: trip.destination.name, reason: plain });
    });

    it('continues to another destination after an isolated provider failure', async () => {
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                if (to.lat === -20.19) throw new Error('Provider unavailable at this stop');
                const proposal = route(from, to);
                return { route: proposal, review: review(proposal) };
            }),
        });
        const result = await build(request(), [candidate('failed', -20.19), candidate('works', -20.15)], deps);
        expect(result.options.map((option) => option.candidate.destination.id)).toEqual(['works']);
        expect(result.excluded[0].reason).toMatch(/Provider unavailable/);
    });
});

describe('transit and exact stay forecasts', () => {
    it('uses the present fetch clock for a future departure and assesses the entire overnight stay', async () => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point, index) => {
                    const forecast = weather(point);
                    if (index === 0) forecast.hours.find((hour) => hour.t === NOW + 26 * HOUR)!.gust = 40;
                    return forecast;
                }),
            ),
        });
        const safe = await build(request({ departureMs: NOW + 24 * HOUR }));
        expect(safe.options[0].conditions.light).toBe('green');
        const adverse = await build(
            request({ departureMs: NOW + 24 * HOUR, mode: 'overnight', overnightUntilMs: NOW + 36 * HOUR }),
            [candidate()],
            deps,
        );
        expect(adverse.options).toEqual([]);
        expect(adverse.excluded[0].reason).toMatch(/Strong forecast gusts/);
    });

    it.each(['stale', 'missing-hour', 'missing-wave', 'nan-wind', 'wrong-cell', 'missing-return'] as const)(
        'never gives favourable transit to %s',
        async (kind) => {
            const deps = dependencies({
                forecast: vi.fn(async (points: DayPlanPoint[]) =>
                    points.map((point, index) => {
                        if (index === 0) return weather(point);
                        if (kind === 'missing-return' && index === points.length - 1) return undefined;
                        const forecast = weather(point);
                        if (kind === 'stale') forecast.fetchedAt = NOW - 16 * 60_000;
                        if (kind === 'missing-hour')
                            forecast.hours = forecast.hours.filter((hour) => hour.t !== NOW + 2 * HOUR);
                        if (kind === 'missing-wave')
                            forecast.hours.forEach((hour) => {
                                hour.waveM = undefined;
                            });
                        if (kind === 'nan-wind')
                            forecast.hours.forEach((hour) => {
                                hour.wind = NaN;
                            });
                        if (kind === 'wrong-cell') forecast.lat += 1;
                        return forecast;
                    }),
                ),
            });
            const [option] = (await build(request(), [candidate()], deps)).options;
            expect(option.transit.light).toBe('unknown');
            expect(option.light).toBe('unknown');
        },
    );

    it('rechecks forecast freshness after the network request completes', async () => {
        let clock = NOW;
        const deps = dependencies({
            now: () => clock,
            forecast: vi.fn(async (points: DayPlanPoint[]) => {
                clock += 16 * 60_000;
                return points.map((point) => weather(point));
            }),
        });
        const result = await build(request(), [candidate()], deps);
        expect(result.options[0].transit.light).toBe('unknown');
        expect(result.options[0].conditions.light).toBe('unknown');
        expect(result.calculatedAt).toBe(clock);
    });

    it('preserves known adverse weather despite other missing fields', () => {
        const samples = [{ ...start, fromMs: NOW + HOUR, toMs: NOW + 1.5 * HOUR }];
        const result = assessDayPlanTransit(samples, [weather(start, { gust: 40, waveM: undefined })], request(), NOW);
        expect(result.light).toBe('red');
        expect(result.reasons.join(' ')).toMatch(/gusts reach/);
        expect(result.reasons.join(' ')).toMatch(/incomplete/);
    });

    it('rejects a return transit storm although the stop itself is favourable', async () => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point, index) => weather(point, index === points.length - 1 ? { weatherCode: 95 } : {})),
            ),
        });
        const result = await build(request(), [candidate()], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/Thunderstorms/);
    });

    it('requires both hourly brackets instead of extrapolating around an exact transit interval', () => {
        const forecast = weather(start);
        forecast.hours = forecast.hours.filter((hour) => hour.t !== NOW + HOUR);
        const assessment = assessDayPlanTransit(
            [{ ...start, fromMs: NOW + 1.2 * HOUR, toMs: NOW + 1.4 * HOUR }],
            [forecast],
            request(),
            NOW,
        );
        expect(assessment.light).toBe('unknown');
    });

    it('records the oldest transit cell fetch time instead of the calculation time', () => {
        const sample = { ...start, fromMs: NOW + HOUR, toMs: NOW + 1.5 * HOUR };
        const fresh = weather(start);
        const older = { ...weather(start), fetchedAt: NOW - 4 * 60_000 };
        const result = assessDayPlanTransit([sample, sample], [fresh, older], request(), NOW);
        expect(result.light).toBe('green');
        expect(result.fetchedAt).toBe(older.fetchedAt);
        const expired = assessDayPlanTransit([sample, sample], [fresh, older], request(), NOW + 12 * 60_000);
        expect(expired.light).toBe('unknown');
        expect(expired.fetchedAt).toBe(older.fetchedAt);
    });

    it('does not invent a transit fetch timestamp when forecasts are absent', () => {
        const sample = { ...start, fromMs: NOW + HOUR, toMs: NOW + 1.5 * HOUR };
        const result = assessDayPlanTransit([sample], [undefined], request(), NOW);
        expect(result.light).toBe('unknown');
        expect(result.fetchedAt).toBeUndefined();
    });

    it.each([NOW + 2 * 60_000, Number.NaN])(
        'checks every forecast timestamp against the same clock: %s',
        (fetchedAt) => {
            const sample = { ...start, fromMs: NOW + HOUR, toMs: NOW + 1.5 * HOUR };
            const result = assessDayPlanTransit(
                [sample, sample],
                [weather(start), { ...weather(start), fetchedAt }],
                request(),
                NOW,
            );
            expect(result.light).toBe('unknown');
            expect(result.fetchedAt).toBe(NOW);
        },
    );

    it('samples dense original geometry without simplifying the route and covers every transit minute', () => {
        const dest = candidate();
        const coordinates: [number, number][] = Array.from({ length: 101 }, (_, index) => [
            148.8,
            start.lat + ((dest.destination.lat - start.lat) * index) / 100,
        ]);
        const proposal = { ...route(start, dest.destination), coordinates };
        const distanceNM = dayPlanRouteDistanceNM(coordinates);
        const leg: DayPlanLeg = {
            route: proposal,
            review: review(proposal),
            distanceNM,
            departureMs: NOW + HOUR,
            arrivalMs: NOW + HOUR + (distanceNM / 6) * HOUR,
        };
        const samples = sampleDayPlanTransit(leg, 6);
        expect(samples.length).toBeLessThan(10);
        expect(samples[0].fromMs).toBe(leg.departureMs);
        expect(samples.at(-1)!.toMs).toBeCloseTo(leg.arrivalMs, 2);
        for (let index = 1; index < samples.length; index++) {
            expect(samples[index].fromMs).toBe(samples[index - 1].toMs);
            expect(dayPlanDistanceNM(samples[index - 1], samples[index])).toBeLessThanOrEqual(3.00001);
        }
        expect(proposal.coordinates).toHaveLength(101);
    });

    it('excludes forecast sampling over budget rather than dropping route sections', async () => {
        const result = await build(request({ maxSailingHours: 20, speedKts: 2 }), [candidate('long', -19.9)]);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toMatch(/forecast coverage budget/);
    });
});

describe('request validation and cancellation', () => {
    it.each([
        { departureMs: NOW - 1 },
        { departureMs: NOW + 5 * 24 * HOUR + 1 },
        { speedKts: NaN },
        { speedKts: 0 },
        { draftM: NaN },
        { stopHours: NaN },
        { maxSailingHours: Infinity },
        { maxWindKts: NaN },
        { maxWaveM: -1 },
        { activities: ['unsupported'] },
        { destinationIds: ['a', 'a'] },
        { destinationIds: [''] },
        { destinationIds: ['a', 'b', 'c', 'd', 'e'] },
        { mode: 'overnight', overnightUntilMs: NOW + 38 * HOUR },
        { mode: 'overnight', overnightUntilMs: undefined },
    ] as Partial<DayPlanRequest>[])('rejects invalid inputs %j before work begins', async (extra) => {
        const deps = dependencies();
        await expect(build(request(extra), [candidate()], deps)).rejects.toThrow();
        expect(deps.route).not.toHaveBeenCalled();
    });

    it('accepts departure exactly five days ahead when the forecast fully covers the itinerary', () => {
        expect(() => validateDayPlanRequest(request({ departureMs: NOW + 5 * 24 * HOUR }), NOW)).not.toThrow();
    });

    it('does not start work when already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const deps = dependencies();
        await expect(buildDayPlan(request(), [candidate()], deps, { signal: controller.signal })).rejects.toMatchObject(
            { name: 'AbortError' },
        );
        expect(deps.route).not.toHaveBeenCalled();
    });

    it.each(['outbound', 'return', 'weather'] as const)('propagates cancellation after the %s await', async (phase) => {
        const controller = new AbortController();
        let calls = 0;
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                calls++;
                if ((phase === 'outbound' && calls === 1) || (phase === 'return' && calls === 2)) controller.abort();
                const proposal = route(from, to);
                return { route: proposal, review: review(proposal) };
            }),
            forecast: vi.fn(async (points: DayPlanPoint[]) => {
                if (phase === 'weather') controller.abort();
                return points.map((point) => weather(point));
            }),
        });
        await expect(buildDayPlan(request(), [candidate()], deps, { signal: controller.signal })).rejects.toMatchObject(
            { name: 'AbortError' },
        );
        if (phase === 'outbound') expect(deps.route).toHaveBeenCalledTimes(1);
        if (phase !== 'weather') expect(deps.forecast).not.toHaveBeenCalled();
    });

    it('propagates a provider AbortError even when the signal has not yet changed', async () => {
        const deps = dependencies({
            route: vi.fn(async () => {
                throw new DOMException('cancel', 'AbortError');
            }),
        });
        await expect(build(request(), [candidate()], deps)).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('stay wind and gust ceilings', () => {
    it.each([
        { maxWindKts: 12, maxGustKts: 25, wind: 13, gust: 15, reason: 'Wind during the stay' },
        { maxWindKts: 12, maxGustKts: 15, wind: 8, gust: 18, reason: 'Gusts during the stay' },
        { maxWindKts: undefined, maxGustKts: undefined, wind: 8, gust: 30, reason: 'Gusts during the stay' },
    ])('does not let shelter waive wind/gust limits: %j', async ({ maxWindKts, maxGustKts, wind, gust, reason }) => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point, index) => weather(point, index === 0 ? { wind, gust } : {})),
            ),
        });
        const result = await build(request({ maxWindKts, maxGustKts }), [candidate()], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toContain(reason);
    });

    it('keeps known excessive stay gusts red when some wave data is missing', async () => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point, index) => weather(point, index === 0 ? { gust: 18, waveM: undefined } : {})),
            ),
        });
        const result = await build(request({ maxWindKts: 12, maxGustKts: 15 }), [candidate()], deps);
        expect(result.options).toEqual([]);
        expect(result.excluded[0].reason).toContain('Gusts during the stay');
    });

    it('keeps stay waves shelter-aware instead of applying the open-water transit cap', async () => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point, index) => weather(point, index === 0 ? { waveM: 1 } : {})),
            ),
        });
        const result = await build(request({ maxWaveM: 0.5 }), [candidate()], deps);
        expect(result.options).toHaveLength(1);
        expect(result.options[0].conditions.light).toBe('green');
        expect(result.options[0].transit.light).toBe('green');
    });
});

describe('bounded optional departure comparisons', () => {
    it('keeps the fixed-time API unchanged unless explicitly enabled', async () => {
        const deps = dependencies();
        const result = await buildFlexibleDayPlan(request(), [candidate()], deps, { signal: signal() });
        expect(result.comparedDepartures).toBeUndefined();
        expect(result.options[0].departureMs).toBe(NOW + HOUR);
        expect(deps.route).toHaveBeenCalledTimes(2);
        expect(deps.forecast).toHaveBeenCalledTimes(1);
    });

    it('retains a later qualified departure when the requested departure fails without repeating external calls', async () => {
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point) => {
                    const forecast = weather(point);
                    forecast.hours[1].weatherCode = 95;
                    return forecast;
                }),
            ),
        });
        const req = request({ flexibleStart: true });
        const result = await buildFlexibleDayPlan(req, [candidate()], deps, { signal: signal() });
        expect(result.comparedDepartures).toEqual([NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR]);
        expect(result.options).toHaveLength(1);
        expect(result.options[0].departureMs).toBe(NOW + 2 * HOUR);
        expect(result.excluded).toEqual([]);
        expect(deps.route).toHaveBeenCalledTimes(2);
        expect(deps.forecast).toHaveBeenCalledTimes(1);
        expect(req.departureMs).toBe(NOW + HOUR);
    });

    it('keeps return and overnight deadlines fixed while comparing later starts', async () => {
        const returning = await buildFlexibleDayPlan(
            request({ flexibleStart: true, returnByMs: NOW + 3.5 * HOUR }),
            [candidate()],
            dependencies(),
            { signal: signal() },
        );
        expect(returning.options[0].departureMs).toBe(NOW + HOUR);
        expect(returning.options[0].finishMs).toBeLessThanOrEqual(NOW + 3.5 * HOUR);
        const deps = dependencies({
            forecast: vi.fn(async (points: DayPlanPoint[]) =>
                points.map((point) => {
                    const forecast = weather(point);
                    forecast.hours[1].weatherCode = 95;
                    return forecast;
                }),
            ),
        });
        const overnight = await buildFlexibleDayPlan(
            request({ flexibleStart: true, mode: 'overnight', overnightUntilMs: NOW + 8 * HOUR }),
            [candidate()],
            deps,
            { signal: signal() },
        );
        expect(overnight.options[0].departureMs).toBe(NOW + 2 * HOUR);
        expect(overnight.options[0].stayToMs).toBe(NOW + 8 * HOUR);
        expect(overnight.options[0].finishMs).toBe(NOW + 8 * HOUR);
        expect(deps.route).toHaveBeenCalledTimes(1);
    });

    it('does not shift beyond five days or beyond an absolute finish deadline', async () => {
        const horizon = await buildFlexibleDayPlan(
            request({ flexibleStart: true, departureMs: NOW + 5 * 24 * HOUR }),
            [candidate()],
            dependencies(),
            { signal: signal() },
        );
        expect(horizon.comparedDepartures).toEqual([NOW + 5 * 24 * HOUR]);
        const deadline = await buildFlexibleDayPlan(
            request({ flexibleStart: true, returnByMs: NOW + 2 * HOUR }),
            [candidate()],
            dependencies(),
            { signal: signal() },
        );
        expect(deadline.comparedDepartures).toEqual([NOW + HOUR]);
        expect(deadline.options).toEqual([]);
    });

    it('keeps one option per destination and bounds routing to four independent outward/return pairs', async () => {
        const deps = dependencies();
        const list = Array.from({ length: 6 }, (_, index) => candidate(String(index), -20.19 + index * 0.005));
        const result = await buildFlexibleDayPlan(request({ flexibleStart: true }), list, deps, { signal: signal() });
        expect(result.options).toHaveLength(4);
        expect(new Set(result.options.map((option) => option.candidate.destination.id)).size).toBe(4);
        expect(result.options.every((option) => option.departureMs === NOW + HOUR)).toBe(true);
        expect(deps.route).toHaveBeenCalledTimes(8);
        expect(deps.forecast).toHaveBeenCalledTimes(4);
    });

    it('snapshots cached route evidence without freezing or changing the provider objects', async () => {
        const originals: AutoroutingTrialRoute[] = [];
        const deps = dependencies({
            route: vi.fn(async (from, to) => {
                const proposal = route(from, to);
                originals.push(proposal);
                return { route: proposal, review: review(proposal) };
            }),
        });
        const result = await buildFlexibleDayPlan(request({ flexibleStart: true }), [candidate()], deps, {
            signal: signal(),
        });
        expect(Object.isFrozen(result.options[0].legs[0].route)).toBe(true);
        expect(Object.isFrozen(result.options[0].legs[0].route.coordinates[0])).toBe(true);
        expect(Object.isFrozen(result.options[0].legs[0].review.legs[0])).toBe(true);
        expect(Object.isFrozen(originals[0])).toBe(false);
        expect(result.options[0].legs[0].route).not.toBe(originals[0]);
    });

    it('does not reuse cached evidence across separate planner invocations', async () => {
        const deps = dependencies();
        await buildFlexibleDayPlan(request({ flexibleStart: true }), [candidate()], deps, { signal: signal() });
        await buildFlexibleDayPlan(request({ flexibleStart: true }), [candidate()], deps, { signal: signal() });
        expect(deps.route).toHaveBeenCalledTimes(4);
        expect(deps.forecast).toHaveBeenCalledTimes(2);
    });

    it('does not retain a favourable earlier comparison after its cached forecast expires', async () => {
        let clock = NOW;
        const deps = dependencies({ now: () => clock });
        const result = await buildFlexibleDayPlan(request({ flexibleStart: true }), [candidate()], deps, {
            signal: signal(),
            onProgress: (progress) => {
                if (progress.phase === 'complete') clock = NOW + 16 * 60_000;
            },
        });
        expect(result.options[0].conditions.light).toBe('unknown');
        expect(result.options[0].transit.light).toBe('unknown');
        expect(result.options[0].light).toBe('unknown');
        expect(deps.forecast).toHaveBeenCalledTimes(1);
    });

    it('propagates cancellation between comparisons before using a cached route', async () => {
        const controller = new AbortController();
        const deps = dependencies();
        await expect(
            buildFlexibleDayPlan(request({ flexibleStart: true }), [candidate()], deps, {
                signal: controller.signal,
                onProgress: (progress) => {
                    if (progress.phase === 'complete') controller.abort();
                },
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(deps.route).toHaveBeenCalledTimes(2);
        expect(deps.forecast).toHaveBeenCalledTimes(1);
    });
});
