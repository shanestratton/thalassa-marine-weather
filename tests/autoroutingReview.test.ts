import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TraceIssue, TraceLegVerdict } from '../services/routeTracer';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
const mocks = vi.hoisted(() => ({ build: vi.fn(), validate: vi.fn() }));
vi.mock('../services/routeTracer', async (original) => ({
    ...(await original<typeof import('../services/routeTracer')>()),
    buildTracerContext: mocks.build,
    validateTraceLeg: mocks.validate,
}));
import {
    isTrialTrackAdvisory,
    reviewAutoroutingProposal,
    trialChartTrackAdvisories,
    trialReviewFeatures,
    trialDisplayWaypointGrade,
    TRIAL_REVIEW_BATCH_SIZE,
    type TrialRouteReview,
} from '../services/autoroutingReview';
import { buildTrialDisplayWaypoints } from '../services/autoroutingDisplayWaypoints';
const verdict = (extra: Partial<TraceLegVerdict> = {}): TraceLegVerdict => ({
    grade: 'clear',
    issues: [],
    minDepthM: 8,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
    ...extra,
});

describe('sparse trial map markers', () => {
    const coordinates: [number, number][] = Array.from({ length: 1000 }, (_, index) => [153, -27 + (4 * index) / 999]);
    const clearReview = (): TrialRouteReview => ({
        phase: 'complete',
        legs: coordinates.slice(1).map(() => ({ incomplete: false, verdict: verdict() })),
    });
    it('numbers six markers on a 240 NM straight passage without thinning any checked geometry', () => {
        const review = clearReview();
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        const before = JSON.stringify({ coordinates, review });
        const features = trialReviewFeatures(coordinates, review, waypoints).features;
        expect(features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties?.number)).toEqual([
            1, 2, 3, 4, 5, 6,
        ]);
        expect(
            features
                .filter((f) => f.geometry.type === 'LineString')
                .map((f) => (f.geometry as GeoJSON.LineString).coordinates),
        ).toEqual(coordinates.slice(1).map((point, index) => [coordinates[index], point]));
        expect(JSON.stringify({ coordinates, review })).toBe(before);
    });
    it('paints the arriving marker red for a danger hidden between sparse markers', () => {
        const review = clearReview();
        review.legs[30]!.verdict = verdict({
            grade: 'danger',
            issues: [{ severity: 'danger', message: 'Charted obstruction', at: { lat: -26.88, lon: 153 } }],
        });
        const points = trialReviewFeatures(
            coordinates,
            review,
            buildTrialDisplayWaypoints(coordinates),
        ).features.filter((f) => f.geometry.type === 'Point');
        expect(points[1].properties?.color).toBe('#f87171');
        expect(points[2].properties?.color).toBe('#10b981');
    });
    it('never makes incomplete, missing, stale or failed checks green', () => {
        const review = clearReview();
        expect(trialDisplayWaypointGrade(review, { first: 0, last: 10 })).toBe('clear');
        review.legs[5] = null;
        expect(trialDisplayWaypointGrade(review, { first: 0, last: 10 })).toBe('unchecked');
        review.legs[5] = { incomplete: true, verdict: verdict() };
        expect(trialDisplayWaypointGrade(review, { first: 0, last: 10 })).toBe('caution');
        review.legs[5] = { incomplete: false, verdict: verdict({ needsTide: true }) };
        expect(trialDisplayWaypointGrade(review, { first: 0, last: 10 })).toBe('caution');
        for (const phase of ['stale', 'error'] as const)
            expect(trialDisplayWaypointGrade({ ...clearReview(), phase }, { first: 0, last: 10 })).toBe('unchecked');
    });
});

describe('trial chart-track advisory presentation', () => {
    const trackIssue = (id: string, offsetM: number): TraceIssue => ({
        severity: 'caution',
        message: `${offsetM} m from charted track — review alignment`,
        at: { lat: -27, lon: 153 + offsetM / 100_000 },
        chartTrack: { id, label: 'Entrance track', kind: 'recommended-track', offsetM },
    });
    const reviewOf = (issues: Array<TraceIssue[] | null>): TrialRouteReview => ({
        phase: 'complete',
        legs: issues.map((list) =>
            list ? { incomplete: false, verdict: verdict({ grade: 'caution', issues: list }) } : null,
        ),
    });

    it('groups by chart identity with exact leg ranges, including duplicate grading subsegments', () => {
        const furthest = trackIssue('entrance', 120);
        const review = reviewOf([
            [trackIssue('entrance', 50), furthest],
            [trackIssue('entrance', 80)],
            null,
            [trackIssue('entrance', 60)],
        ]);
        const before = JSON.stringify(review);
        const [group] = trialChartTrackAdvisories(review);
        expect(group).toMatchObject({
            id: 'recommended-track:entrance',
            label: 'Entrance track',
            maxOffsetM: 120,
            legRanges: [
                { first: 0, last: 1 },
                { first: 3, last: 3 },
            ],
            worst: { index: 0, spot: furthest.at },
        });
        expect(group.legs.map(({ index }) => index)).toEqual([0, 1, 3]);
        expect(JSON.stringify(review)).toBe(before);
        expect(review.legs[0]?.verdict.issues).toHaveLength(2);
    });

    it('keeps distinct tracks with the same text/name separate', () => {
        const first = trackIssue('north', 90);
        const second = trackIssue('south', 90);
        const third = {
            ...first,
            chartTrack: { ...first.chartTrack!, kind: 'leading-line' as const },
        };
        const groups = trialChartTrackAdvisories(reviewOf([[first, second, third]]));
        expect(groups.map(({ id }) => id)).toEqual([
            'recommended-track:north',
            'recommended-track:south',
            'leading-line:north',
        ]);
    });

    it('never groups hazards, legacy message matches or incomplete track metadata', () => {
        const issue = trackIssue('entrance', 90);
        const ordinary: TraceIssue[] = [
            { severity: 'danger', message: '1.0 m charted depth', at: issue.at },
            { severity: 'caution', message: 'obstruction near route', mark: issue.at },
            { severity: 'caution', message: issue.message, at: issue.at },
            { ...issue, severity: 'danger' },
            { ...issue, at: undefined },
            { ...issue, chartTrack: { ...issue.chartTrack!, id: '' } },
            { ...issue, chartTrack: { ...issue.chartTrack!, offsetM: NaN } },
        ];
        expect(ordinary.every((entry) => !isTrialTrackAdvisory(entry))).toBe(true);
        expect(trialChartTrackAdvisories(reviewOf([ordinary]))).toEqual([]);
        expect(trialChartTrackAdvisories(null)).toEqual([]);
    });

    it('does not change individual hazards, depth, tide, incompleteness or segment colours', () => {
        const mark = { lat: -27, lon: 153.001 };
        const review = reviewOf([[trackIssue('entrance', 50)], [trackIssue('entrance', 100)]]);
        review.legs[1] = {
            incomplete: true,
            verdict: verdict({
                grade: 'danger',
                minDepthM: 1.2,
                minAt: mark,
                needsTide: true,
                issues: [
                    ...review.legs[1]!.verdict.issues,
                    { severity: 'danger', message: 'wrong side of cardinal', mark },
                    { severity: 'danger', message: 'insufficient charted depth', at: mark },
                ],
            }),
        };
        const coordinates: [number, number][] = [
            [153, -27],
            [153.001, -27],
            [153.002, -27],
        ];
        const before = JSON.stringify(review);
        const features = trialReviewFeatures(coordinates, review);
        expect(trialChartTrackAdvisories(review)).toHaveLength(1);
        expect(JSON.stringify(review)).toBe(before);
        expect(trialReviewFeatures(coordinates, review)).toEqual(features);
        expect(
            features.features
                .filter((feature) => feature.geometry.type === 'LineString')
                .map((f) => f.properties?.color),
        ).toEqual(['#fbbf24', '#f87171']);
    });
});
const route = (coordinates: [number, number][]): AutoroutingTrialRoute => ({
    id: 'test',
    coordinates,
    provider: 'SevenCs',
    createdAt: '2026-09-12T00:00:00Z',
    warnings: [],
});
beforeEach(() => {
    vi.clearAllMocks();
    mocks.build.mockResolvedValue({ status: 'ready', ctx: { gateChecksUnavailable: false } });
    mocks.validate.mockImplementation(() => verdict());
});
describe('auto proposals use the manual leg grading loop', () => {
    it.each(['measured', 'estimated', 'missing', 'legacy'] as const)(
        'forwards %s draft provenance into the shared grading context',
        async (status) => {
            const input = route([
                [153, -27],
                [153.001, -27],
            ]);
            if (status !== 'legacy') {
                input.vesselProfile = snapshotAutoroutingVesselProfile({ draft: 8 });
                input.vesselProfile.draftStatus = status;
            }
            await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
            expect(mocks.build).toHaveBeenCalledWith(expect.any(Array), 2.4, {
                draftAssumed: status !== 'measured',
                chartedDepthOnly: true,
            });
        },
    );

    it.each([true, false])('honours an explicit draftAssumed=%s snapshot', async (draftAssumed) => {
        const input = route([
            [153, -27],
            [153.001, -27],
        ]);
        input.vesselProfile = snapshotAutoroutingVesselProfile({
            draft: 8,
            estimatedFields: draftAssumed ? [] : ['draft'],
        });
        await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn(), { draftAssumed });
        expect(mocks.build).toHaveBeenCalledWith(expect.any(Array), 2.4, { draftAssumed, chartedDepthOnly: true });
    });

    it('snapshots geometry and draft provenance before an asynchronous chart context can mutate the caller', async () => {
        const input = route([
            [153, -27],
            [153.001, -27],
            [153.002, -27],
        ]);
        input.vesselProfile = snapshotAutoroutingVesselProfile({ draft: 8, estimatedFields: ['draft'] });
        mocks.build.mockImplementationOnce(async () => {
            input.coordinates[1][0] = 1;
            input.vesselProfile!.draftStatus = 'measured';
            return { status: 'ready', ctx: { gateChecksUnavailable: false } };
        });
        const result = await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
        expect(result.phase).toBe('complete');
        expect(mocks.build.mock.calls[0][2]).toMatchObject({ draftAssumed: true });
        expect(mocks.validate.mock.calls.map(([a, b]) => ({ a, b }))).toEqual([
            { a: { lon: 153, lat: -27 }, b: { lon: 153.001, lat: -27 } },
            { a: { lon: 153.001, lat: -27 }, b: { lon: 153.002, lat: -27 } },
        ]);
    });

    it('keeps a locally generated canal leg caution even if chart checks are otherwise clear', async () => {
        const input = {
            ...route([
                [153, -27],
                [153.001, -27],
                [153.002, -27],
            ]),
            canalDeparture: { handoverIndex: 1 },
        };
        const result = await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
        expect(result.legs[0]).toMatchObject({ incomplete: true, verdict: { grade: 'caution' } });
        expect(result.legs[0]?.verdict.issues.some((i) => i.message.includes('Local canal proposal'))).toBe(true);
        expect(result.legs[1]?.verdict.grade).toBe('clear');
    });
    it('grades every exact bend, carries draft and strict depth policy, and marks only the final leg as last', async () => {
        const input = route([
            [153, -27],
            [153.001, -27.001],
            [153.002, -27],
        ]);
        const before = JSON.stringify(input);
        const result = await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn(), {
            draftAssumed: false,
        });
        expect(result.phase).toBe('complete');
        expect(mocks.build).toHaveBeenCalledWith(expect.any(Array), 2.4, {
            draftAssumed: false,
            chartedDepthOnly: true,
        });
        expect(mocks.validate.mock.calls.map(([a, b, , opts]) => ({ a, b, last: opts.lastLeg }))).toEqual([
            { a: { lon: 153, lat: -27 }, b: { lon: 153.001, lat: -27.001 }, last: false },
            { a: { lon: 153.001, lat: -27.001 }, b: { lon: 153.002, lat: -27 }, last: true },
        ]);
        expect(JSON.stringify(input)).toBe(before);
        const drawn = trialReviewFeatures(input.coordinates, result).features;
        expect(drawn.filter((f) => f.geometry.type === 'Point').map((f) => f.properties?.number)).toEqual([1, 2, 3]);
        expect(drawn.filter((f) => f.geometry.type === 'LineString').map((f) => f.geometry)).toEqual([
            { type: 'LineString', coordinates: input.coordinates.slice(0, 2) },
            { type: 'LineString', coordinates: input.coordinates.slice(1, 3) },
        ]);
    });
    it.each(['nochart', 'marksonly', 'toolarge'])('does not paint %s results green', async (status) => {
        mocks.build.mockResolvedValue({ status, ctx: { gateChecksUnavailable: false } });
        mocks.validate.mockReturnValue(verdict({ grade: 'caution', minDepthM: null }));
        const input = route([
            [153, -27],
            [153.001, -27],
        ]);
        const result = await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
        expect(result.legs[0]?.incomplete).toBe(true);
        expect(
            trialReviewFeatures(input.coordinates, result).features.every((f) => f.properties?.color !== '#10b981'),
        ).toBe(true);
    });
    it('preserves danger and its marker position even when checks are incomplete', async () => {
        mocks.build.mockResolvedValue({ status: 'ready', ctx: { gateChecksUnavailable: true } });
        const mark = { lat: -27, lon: 153.001 };
        mocks.validate.mockReturnValue(
            verdict({ grade: 'danger', issues: [{ severity: 'danger', message: 'wrong side of cardinal', mark }] }),
        );
        const result = await reviewAutoroutingProposal(
            route([
                [153, -27],
                [153.002, -27],
            ]),
            2.4,
            new AbortController().signal,
            vi.fn(),
        );
        expect(result.legs[0]).toMatchObject({ incomplete: true, verdict: { grade: 'danger', issues: [{ mark }] } });
    });
    it('downgrades an optimistic verdict if marker checks failed or no depth was measured', async () => {
        mocks.build.mockResolvedValue({ status: 'ready', ctx: { gateChecksUnavailable: true } });
        const input = route([
            [153, -27],
            [153.001, -27],
        ]);
        let result = await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
        expect(result.legs[0]?.verdict.grade).toBe('caution');
        mocks.build.mockResolvedValue({ status: 'ready', ctx: {} });
        mocks.validate.mockReturnValue(verdict({ minDepthM: null }));
        result = await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
        expect(result.legs[0]?.verdict.grade).toBe('caution');
    });
    it('bounds dense routes into batches and stops without checking later batches', async () => {
        const input = route(Array.from({ length: 180 }, (_, i) => [153 + i * 0.00001, -27]));
        const controller = new AbortController();
        const result = await reviewAutoroutingProposal(input, 2.4, controller.signal, () => controller.abort());
        expect(result.phase).toBe('stopped');
        expect(mocks.validate).toHaveBeenCalledTimes(TRIAL_REVIEW_BATCH_SIZE);
        expect(result.legs.slice(TRIAL_REVIEW_BATCH_SIZE).every((l) => l === null)).toBe(true);
    });
    it('uses the existing long-leg subdivision without moving displayed waypoints', async () => {
        const input = route([
            [153, -27],
            [153, -26],
        ]);
        await reviewAutoroutingProposal(input, 2.4, new AbortController().signal, vi.fn());
        expect(mocks.validate.mock.calls.length).toBeGreaterThan(1);
        expect(input.coordinates).toHaveLength(2);
    });
    it('declines polar, dateline and duplicate segments instead of building huge grids', async () => {
        for (const coordinates of [
            [
                [179, 0],
                [-179, 0],
            ],
            [
                [0, 85],
                [1, 85],
            ],
            [
                [153, -27],
                [153, -27],
            ],
        ] as [number, number][][]) {
            const result = await reviewAutoroutingProposal(
                route(coordinates),
                2.4,
                new AbortController().signal,
                vi.fn(),
            );
            expect(result.legs[0]?.incomplete).toBe(true);
        }
        expect(mocks.build).not.toHaveBeenCalled();
    });
    it('does not publish a late result after cancellation', async () => {
        const controller = new AbortController();
        mocks.build.mockImplementation(async () => {
            controller.abort();
            return { status: 'ready', ctx: {} };
        });
        const progress = vi.fn();
        const result = await reviewAutoroutingProposal(
            route([
                [153, -27],
                [153.001, -27],
            ]),
            2.4,
            controller.signal,
            progress,
        );
        expect(result.phase).toBe('stopped');
        expect(progress).not.toHaveBeenCalled();
        expect(mocks.validate).not.toHaveBeenCalled();
    });
});
