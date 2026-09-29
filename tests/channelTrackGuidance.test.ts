import { describe, expect, it, vi } from 'vitest';
import {
    createNewportChannelTrackCandidate,
    selectChannelTrackGuidance,
    validateChannelTrackGuidanceResponse,
    NEWPORT_CHANNEL_TRACK_ID,
    type ChannelTrackCandidate,
    type ReviewedChannelTrackPolicy,
} from '../services/channelTrackGuidance';
import { NEWPORT_CANAL_EXIT_PROFILE } from '../services/newportCanalExitProfile';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import { encCell } from './helpers/encCells';

// The shipped Newport profile is RETIRED (owner, 2026-09-29). This suite keeps
// the reviewed geometry under test as renewal evidence, so it sees the record
// unretired; tests/newportRetirement.test.ts pins the shipped, retired state.
vi.mock('../services/newportCanalExitProfile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/newportCanalExitProfile')>();
    const { retirement: _retired, ...reviewed } = actual.NEWPORT_CANAL_EXIT_PROFILE;
    return { ...actual, NEWPORT_CANAL_EXIT_PROFILE: reviewed };
});

const NOW = Date.parse('2026-09-13T01:00:00Z');
const CELL = 'OC-61-10RCS5';
const policy = (): ReviewedChannelTrackPolicy => ({
    id: NEWPORT_CHANNEL_TRACK_ID,
    rule: 'reviewed-small-craft-centreline',
    sourceRevision: 'test-only-reviewed-rectrc407-span',
    reviewedAt: '2026-09-13T00:00:00Z',
    validUntil: NEWPORT_CANAL_EXIT_PROFILE.validUntil,
    span: [
        [153.095128, -27.1675],
        [153.093142, -27.201389],
    ],
});
const metadata = (): EncCell => ({
    id: CELL,
    edition: 1,
    issued: '2022-03-07',
    sourceHO: 'OC',
    usage: 'navigation',
    importedAt: '2026-09-12T00:00:00Z',
    geojsonPath: `enc/${CELL}.json`,
    bbox: [153.083335, -27.221665, 153.111665, -27.166665],
    hazardCount: 100,
});
const chart = (): EncConversionResult =>
    ({
        ...structuredClone(encCell(CELL)),
        ...metadata(),
        cellId: CELL,
    }) as EncConversionResult;
const candidate = () =>
    createNewportChannelTrackCandidate({ metadata: metadata(), chart: chart(), policy: policy(), now: NOW })!;

describe('reviewed Newport track eligibility — no inferred centreline permission', () => {
    it('matches the exact registered finite RECTRC and its paired NAVLNE, not the landward extension', () => {
        const result = candidate();
        expect(result).not.toBeNull();
        expect(result.coordinates).toEqual(policy().span);
        expect(result.provenance).toMatchObject({
            cellId: CELL,
            edition: 1,
            issued: '2022-03-07',
            featureId: 407,
            pairedNavigationLineId: 406,
            category: 1,
            orientationDeg: 183,
            traffic: 4,
        });
        expect(Object.isFrozen(result.coordinates[0])).toBe(true);
        expect(Object.isFrozen(result.provenance)).toBe(true);
    });

    it('requires a separate reviewed track policy; the canal-gate policy is not enough', () => {
        expect(createNewportChannelTrackCandidate({ metadata: metadata(), chart: chart(), now: NOW })).toBeNull();
        expect(
            createNewportChannelTrackCandidate({
                metadata: metadata(),
                chart: chart(),
                policy: {
                    ...policy(),
                    rule: 'shipping-channel' as never,
                },
                now: NOW,
            }),
        ).toBeNull();
    });

    it.each(['expired', 'future', 'extends lease', 'old gate approval'])('rejects an invalid review: %s', (kind) => {
        const p = policy();
        if (kind === 'expired') p.validUntil = '2026-09-13T00:01:00Z';
        if (kind === 'future') p.reviewedAt = '2026-09-14T00:00:00Z';
        if (kind === 'extends lease') p.validUntil = '2026-10-01T00:00:00Z';
        if (kind === 'old gate approval') p.reviewedAt = '2026-09-10T00:00:00Z';
        expect(
            createNewportChannelTrackCandidate({ metadata: metadata(), chart: chart(), policy: p, now: NOW }),
        ).toBeNull();
    });

    it('rejects expiry of the underlying canal review even with a new supplied track policy', () => {
        expect(
            createNewportChannelTrackCandidate({
                metadata: metadata(),
                chart: chart(),
                policy: policy(),
                now: Date.parse(NEWPORT_CANAL_EXIT_PROFILE.validUntil),
            }),
        ).toBeNull();
    });

    it.each(['reference', 'pending', 'demo'])('rejects non-navigation registration %s', (usage) => {
        expect(
            createNewportChannelTrackCandidate({
                metadata: { ...metadata(), usage: usage as EncCell['usage'] },
                chart: chart(),
                policy: policy(),
                now: NOW,
            }),
        ).toBeNull();
    });

    it.each(['metadata missing', 'blob missing', 'metadata edition', 'blob date', 'empty hazards', 'wrong source'])(
        'declines %s',
        (kind) => {
            const m = metadata(),
                c = chart();
            if (kind === 'metadata edition') m.edition = 2;
            if (kind === 'blob date') c.issued = '2026-09-13';
            if (kind === 'empty hazards') m.hazardCount = 0;
            if (kind === 'wrong source') c.sourceHO = 'AU';
            expect(
                createNewportChannelTrackCandidate({
                    metadata: kind === 'metadata missing' ? null : m,
                    chart: kind === 'blob missing' ? null : c,
                    policy: policy(),
                    now: NOW,
                }),
            ).toBeNull();
        },
    );

    it.each([
        'category',
        'orientation',
        'traffic',
        'geometry',
        'paired missing',
        'paired clearing',
        'duplicate conflict',
    ])('rejects changed or ambiguous chart evidence: %s', (kind) => {
        const c = chart();
        const layers = c.layers as unknown as Record<
            string,
            { features: Array<{ properties: Record<string, unknown>; geometry: { coordinates: number[][] } }> }
        >;
        const r = layers.RECTRC.features.find((f) => f.properties.rcid === 407)!;
        const n = layers.NAVLNE.features.find((f) => f.properties.rcid === 406)!;
        if (kind === 'category') r.properties.CATTRK = 2;
        if (kind === 'orientation') r.properties.ORIENT = 3;
        if (kind === 'traffic') r.properties.TRAFIC = 1;
        if (kind === 'geometry') r.geometry.coordinates[0][0] += 0.00001;
        if (kind === 'paired missing') layers.NAVLNE.features = [];
        if (kind === 'paired clearing') n.properties.CATNAV = 1;
        if (kind === 'duplicate conflict')
            layers.RECTRC.features.push({ ...structuredClone(r), properties: { ...r.properties, TRAFIC: 1 } });
        expect(
            createNewportChannelTrackCandidate({ metadata: metadata(), chart: c, policy: policy(), now: NOW }),
        ).toBeNull();
    });

    it('refuses to extend the policy beyond the finite RECTRC onto the NAVLNE', () => {
        const p = policy();
        p.span = [p.span[0], [153.09273, -27.208418]];
        expect(
            createNewportChannelTrackCandidate({ metadata: metadata(), chart: chart(), policy: p, now: NOW }),
        ).toBeNull();
    });

    it('requires fresh review if a restriction/status qualifier appears without an edition change', () => {
        const c = chart();
        c.layers.RECTRC!.features.find((f) => f.properties?.rcid === 407)!.properties!.STATUS = 4;
        expect(
            createNewportChannelTrackCandidate({ metadata: metadata(), chart: c, policy: policy(), now: NOW }),
        ).toBeNull();
    });
});

// Synthetic metre-space geometries below exercise only the pure geometry
// kernel. They are never eligible source candidates or live profile data.
const point = (x: number, y: number): [number, number] => [
    153 + x / (111_320 * Math.cos((-27 * Math.PI) / 180)),
    -27 + y / 110_540,
];
const geometryCandidate = (
    points: number[][] = [
        [-500, 0],
        [500, 0],
    ],
): ChannelTrackCandidate => ({
    ...candidate(),
    coordinates: points.map(([x, y]) => point(x, y)),
});
const proposal = (points: number[][], handoverIndex?: number) => ({
    coordinates: points.map(([x, y]) => point(x, y)),
    ...(handoverIndex === undefined ? {} : { canalDeparture: { handoverIndex } }),
});
const standard = () =>
    selectChannelTrackGuidance(
        proposal([
            [-800, 53],
            [800, 53],
        ]),
        geometryCandidate(),
    )!;
const coords = (points: number[][]) => points.map(([x, y]) => point(x, y));

describe('finite provider-only guidance selection', () => {
    it('projects ordered entry and exit, never beyond charted ends or mutating the proposal', () => {
        const original = proposal([
                [-800, 53],
                [800, 53],
            ]),
            before = structuredClone(original);
        const result = selectChannelTrackGuidance(original, geometryCandidate())!;
        expect(result.points).toEqual(
            coords([
                [-500, 0],
                [500, 0],
            ]),
        );
        expect(result.coveredSpan).toMatchObject({ firstLeg: 0, lastLeg: 0, direction: 1 });
        expect(result.coveredSpan.lengthM).toBeCloseTo(1000, 3);
        expect(original).toEqual(before);
    });

    it('orders constraints in the vessel’s actual reverse travel direction', () => {
        const result = selectChannelTrackGuidance(
            proposal([
                [800, 53],
                [-800, 53],
            ]),
            geometryCandidate(),
        )!;
        expect(result.points).toEqual(
            coords([
                [500, 0],
                [-500, 0],
            ]),
        );
        expect(result.coveredSpan.direction).toBe(-1);
    });

    it('retains every source bend, including a gap between offset legs around a corner', () => {
        const result = selectChannelTrackGuidance(
            proposal([
                [-500, 53],
                [-53, 53],
                [-53, 500],
            ]),
            geometryCandidate([
                [-500, 0],
                [0, 0],
                [0, 500],
            ]),
        )!;
        expect(result.points).toEqual(
            coords([
                [-500, 0],
                [0, 0],
                [0, 500],
            ]),
        );
        expect(result.coveredSpan.lengthM).toBeCloseTo(1000, 3);
    });

    it('does not force the rest of the charted lead when the proposal turns away early', () => {
        const result = selectChannelTrackGuidance(
            proposal([
                [-800, 53],
                [0, 53],
                [0, 800],
            ]),
            geometryCandidate(),
        )!;
        expect(result.points).toEqual(
            coords([
                [-500, 0],
                [0, 0],
            ]),
        );
    });

    it('ignores the local canal prefix and retains original combined indices', () => {
        const original = proposal(
            [
                [-1000, 500],
                [-800, 53],
                [800, 53],
            ],
            1,
        );
        const before = structuredClone(original);
        expect(selectChannelTrackGuidance(original, geometryCandidate())?.coveredSpan.firstLeg).toBe(1);
        expect(original).toEqual(before);
        expect(
            selectChannelTrackGuidance(
                proposal(
                    [
                        [-800, 53],
                        [800, 53],
                        [800, 800],
                    ],
                    1,
                ),
                geometryCandidate(),
            ),
        ).toBeNull();
    });

    it('omits MustGo points coincident with provider endpoints, retaining validation anchors', () => {
        const result = selectChannelTrackGuidance(
            proposal([
                [-500, 0],
                [0, 53],
                [800, 53],
            ]),
            geometryCandidate(),
        )!;
        expect(result.coveredCoordinates[0]).toEqual(point(-500, 0));
        expect(result.points).not.toContainEqual(point(-500, 0));
    });

    it('does not request a tiny lateral entry manoeuvre when the endpoint is already within20m conformity', () => {
        const result = selectChannelTrackGuidance(
            proposal([
                [-500, 10],
                [0, 53],
                [800, 53],
            ]),
            geometryCandidate(),
        )!;
        expect(result.coveredCoordinates[0]).toEqual(point(-500, 0));
        expect(result.points).toEqual(coords([[500, 0]]));
        expect(
            validateChannelTrackGuidanceResponse(
                result,
                coords([
                    [-500, 10],
                    [500, 0],
                    [800, 53],
                ]),
            ),
        ).toBe(true);
    });

    it.each([
        [
            [-800, -53],
            [800, 53],
        ], // shallow crossing
        [
            [-800, -53],
            [0, 0],
            [800, 53],
        ], // crossing with a waypoint on the lead
        [
            [0, -500],
            [0, 500],
        ], // perpendicular
        [
            [800, 53],
            [1600, 53],
        ], // beyond finite end
        [
            [-800, 151],
            [800, 151],
        ], // unrelated distant parallel
        [
            [-800, 0],
            [800, 0],
        ], // already aligned: no second provider call
        [
            [-800, 53],
            [800, 53],
            [-800, 53],
        ], // repeated/reversed visit
    ])('declines crossing/unrelated/already-aligned/multiple run %j', (...args) => {
        expect(selectChannelTrackGuidance(proposal(args), geometryCandidate())).toBeNull();
    });

    it('declines nearby parallel branches of the same polyline rather than guessing', () => {
        expect(
            selectChannelTrackGuidance(
                proposal([
                    [-300, 53],
                    [300, 53],
                ]),
                geometryCandidate([
                    [-500, 0],
                    [500, 0],
                    [500, 100],
                    [-500, 100],
                ]),
            ),
        ).toBeNull();
    });

    it('declines if keeping all bends would exceed the constraint bound', () => {
        const track = Array.from({ length: 10 }, (_, i) => [i * 200, i % 2 ? 50 : 0]);
        const route = track.map(([x, y]) => [x, y + 53]);
        expect(selectChannelTrackGuidance(proposal(route), geometryCandidate(track))).toBeNull();
    });

    it('declines invalid coordinates, local handovers and unbounded geometry', () => {
        expect(
            selectChannelTrackGuidance(
                proposal(
                    [
                        [-800, 53],
                        [800, 53],
                    ],
                    -1,
                ),
                geometryCandidate(),
            ),
        ).toBeNull();
        expect(
            selectChannelTrackGuidance(
                {
                    coordinates: [
                        [180, 0],
                        [-180, 0],
                    ],
                },
                geometryCandidate(),
            ),
        ).toBeNull();
        expect(
            selectChannelTrackGuidance(
                proposal([
                    [-800, 53],
                    [800, 53],
                ]),
                null,
            ),
        ).toBeNull();
    });
});

describe('returned provider geometry must actually honour ordered constraints', () => {
    it('accepts ordered visits followed continuously inside the finite reviewed corridor', () => {
        expect(
            validateChannelTrackGuidanceResponse(
                standard(),
                coords([
                    [-800, 53],
                    [-500, 0],
                    [500, 0],
                    [800, 53],
                ]),
            ),
        ).toBe(true);
        expect(
            validateChannelTrackGuidanceResponse(
                standard(),
                coords([
                    [-800, 53],
                    [-500, 10],
                    [0, 10],
                    [500, 10],
                    [800, 53],
                ]),
            ),
        ).toBe(true);
    });

    it.each([
        [
            [-800, 53],
            [800, 53],
        ], // misses both constrained points
        [
            [-800, 53],
            [500, 0],
            [-500, 0],
            [800, 53],
        ], // reversed order
        [
            [-800, 53],
            [-500, 0],
            [0, 100],
            [500, 0],
            [800, 53],
        ], // excursions between anchors
        [
            [-800, 53],
            [-500, 0],
            [100, 0],
            [-100, 0],
            [500, 0],
            [800, 53],
        ], // in-corridor reversal
        [
            [-800, 53],
            [-500, 0],
            [0, 0],
            [0, 10],
            [0, 0],
            [500, 0],
            [800, 53],
        ], // sideways loop
        [
            [-800, 53],
            [-500, 0],
            [500, 0],
            [-500, 0],
            [500, 0],
            [800, 53],
        ], // repeated visits
    ])('rejects misses, order changes, excursions and loops: %j', (...args) => {
        expect(validateChannelTrackGuidanceResponse(standard(), coords(args))).toBe(false);
    });

    it('preserves a bend rather than validating just a chord between end constraints', () => {
        const guidance = selectChannelTrackGuidance(
            proposal([
                [-500, 53],
                [-53, 53],
                [-53, 500],
            ]),
            geometryCandidate([
                [-500, 0],
                [0, 0],
                [0, 500],
            ]),
        )!;
        expect(
            validateChannelTrackGuidanceResponse(
                guidance,
                coords([
                    [-600, 53],
                    [-500, 0],
                    [0, 0],
                    [0, 500],
                    [50, 600],
                ]),
            ),
        ).toBe(true);
        expect(
            validateChannelTrackGuidanceResponse(
                guidance,
                coords([
                    [-600, 53],
                    [-500, 0],
                    [0, 500],
                    [50, 600],
                ]),
            ),
        ).toBe(false);
    });

    it('requires constraints to be an ordered subset of the covered track, without silently accepting mutations', () => {
        const g = standard();
        g.points = [point(0, 200)];
        expect(
            validateChannelTrackGuidanceResponse(
                g,
                coords([
                    [-500, 0],
                    [500, 0],
                ]),
            ),
        ).toBe(false);
    });

    it('rejects non-finite and excessive provider geometry', () => {
        expect(
            validateChannelTrackGuidanceResponse(standard(), [
                [153, NaN],
                [153, -27],
            ]),
        ).toBe(false);
        expect(
            validateChannelTrackGuidanceResponse(
                standard(),
                Array.from({ length: 10_001 }, () => point(0, 0)),
            ),
        ).toBe(false);
    });
});
