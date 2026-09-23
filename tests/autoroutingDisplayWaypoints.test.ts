import { describe, expect, it } from 'vitest';
import {
    buildTrialDisplayWaypoints,
    buildTrialWaypointPlan,
    displayWaypointForPathIndex,
    displayWaypointLegRange,
    type TrialDisplayWaypoint,
} from '../services/autoroutingDisplayWaypoints';

const EARTH_RADIUS_M = 6_371_000;
const NM = 1852;
const degrees = (metres: number) => (metres * 180) / (Math.PI * EARTH_RADIUS_M);
type Point = [number, number];

/** Each original segment has the requested rendered rhumb-line distance. */
function parallelPath(lengthNm = 240, count = 1000, latitude = 0, startLon = 0): Point[] {
    const segmentAngle = (lengthNm * NM) / (count - 1) / EARTH_RADIUS_M;
    const lonStep = ((segmentAngle / Math.cos((latitude * Math.PI) / 180)) * 180) / Math.PI;
    return Array.from({ length: count }, (_, i) => [((startLon + lonStep * i + 540) % 360) - 180, latitude]);
}

function expectMonotonic(waypoints: TrialDisplayWaypoint[]) {
    for (let i = 1; i < waypoints.length; i++) {
        expect(waypoints[i].pathIndex).toBeGreaterThan(waypoints[i - 1].pathIndex);
        expect(waypoints[i].distanceM).toBeGreaterThanOrEqual(waypoints[i - 1].distanceM);
        expect(waypoints[i].distanceM - waypoints[i - 1].distanceM).toBeLessThanOrEqual(50 * NM + 1e-5);
    }
}

describe('sparse autorouting DISPLAY waypoints', () => {
    it('retains edited anchors separately from handovers without falsely labelling them as gates', () => {
        const coordinates = parallelPath(10, 100, -27, 153);
        const waypoints = buildTrialWaypointPlan(coordinates, [80], [20, 40, 60]).waypoints;
        expect(waypoints.map(({ pathIndex }) => pathIndex)).toEqual([0, 20, 40, 60, 80, 99]);
        expect(waypoints.map(({ kind }) => kind)).toEqual([
            'departure',
            'turn',
            'turn',
            'turn',
            'handover',
            'destination',
        ]);
        expect(buildTrialDisplayWaypoints(coordinates, [], [0.5])).toEqual([]);
    });

    it('shows six waypoints for 1,000 vertices along a straight 240 NM passage', () => {
        const coordinates = parallelPath();
        const before = JSON.stringify(coordinates);
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints).toHaveLength(6);
        expect(waypoints.map(({ kind }) => kind)).toEqual([
            'departure',
            'spacing',
            'spacing',
            'spacing',
            'spacing',
            'destination',
        ]);
        [0, 50, 100, 150, 200, 240].forEach((nm, i) => expect(waypoints[i].distanceM / NM).toBeCloseTo(nm, 8));
        expect(waypoints[1].pathIndex).toBeCloseTo((999 * 50) / 240, 8);
        expect(waypoints[5].pathIndex).toBe(999);
        expectMonotonic(waypoints);
        expect(JSON.stringify(coordinates)).toBe(before);
        expect(waypoints[0].coordinates).not.toBe(coordinates[0]);
    });

    it('does not manufacture Earth-curvature corners along a Queensland constant-course 240 NM passage', () => {
        const waypoints = buildTrialDisplayWaypoints(parallelPath(240, 1000, -27, 153));
        expect(waypoints).toHaveLength(6);
        expect(waypoints.every(({ kind }) => kind !== 'turn')).toBe(true);
        [0, 50, 100, 150, 200, 240].forEach((nm, i) => expect(waypoints[i].distanceM / NM).toBeCloseTo(nm, 7));
        expect(waypoints[2].coordinates[1]).toBeCloseTo(-27, 6);
        expectMonotonic(waypoints);
    });

    it('keeps all marks on the drawn line even for a TWO-POINT Queensland 240 NM segment', () => {
        const waypoints = buildTrialDisplayWaypoints(parallelPath(240, 2, -27, 153));
        expect(waypoints).toHaveLength(6);
        [0, 50, 100, 150, 200, 240].forEach((nm, i) => {
            expect(waypoints[i].distanceM / NM).toBeCloseTo(nm, 8);
            expect(waypoints[i].coordinates[1]).toBe(-27);
            expect(waypoints[i].pathIndex).toBeCloseTo(nm / 240, 8);
        });
        expectMonotonic(waypoints);
    });

    it('interpolates a long oblique segment on its rendered Mercator line, at physical 50 NM intervals', () => {
        const coordinates: Point[] = [
            [153, -27],
            [159, -20],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        const y = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
        const bearingCos =
            (7 * Math.PI) /
            180 /
            Math.hypot((7 * Math.PI) / 180, (((7 * Math.PI) / 180 / (y(-20) - y(-27))) * 6 * Math.PI) / 180);
        for (let i = 1; i < waypoints.length - 1; i++) {
            const point = waypoints[i];
            const xFraction = (point.coordinates[0] - 153) / 6;
            const yFraction = (y(point.coordinates[1]) - y(-27)) / (y(-20) - y(-27));
            expect(xFraction).toBeCloseTo(yFraction, 10);
            const alongM = (((point.coordinates[1] + 27) * Math.PI) / 180 / bearingCos) * EARTH_RADIUS_M;
            expect(alongM).toBeCloseTo(i * 50 * NM, 5);
        }
        expectMonotonic(waypoints);
    });

    it('retains actual corners and restarts 50 NM spacing from each corner', () => {
        const coordinates: Point[] = [
            [0, 0],
            [degrees(100 * NM), 0],
            [degrees(100 * NM), degrees(75 * NM)],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints.map(({ kind }) => kind)).toEqual(['departure', 'spacing', 'turn', 'spacing', 'destination']);
        [0, 50, 100, 150, 175].forEach((nm, i) => expect(waypoints[i].distanceM / NM).toBeCloseTo(nm, 8));
        expect(waypoints[2].coordinates).toEqual(coordinates[1]);
        expect(waypoints[2].pathIndex).toBe(1);
        expect(waypoints[3].pathIndex).toBeCloseTo(1 + 50 / 75, 8);
        expectMonotonic(waypoints);
    });

    it('keeps small but meaningful corners rather than imposing an arbitrary marker limit', () => {
        const coordinates: Point[] = [
            [0, 0],
            [0.005, 0.001],
            [0.01, 0],
        ];
        expect(buildTrialDisplayWaypoints(coordinates).map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 2]);
    });

    it('ignores sub-five-metre sampling noise without changing the supplied geometry', () => {
        const coordinates: Point[] = [
            [0, 0],
            [0.005, degrees(2)],
            [0.01, 0],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints).toHaveLength(2);
        expect(coordinates[1]).toEqual([0.005, degrees(2)]);
    });

    it('preserves collinear backtracking even when all points lie inside the endpoint chord', () => {
        const coordinates: Point[] = [
            [0, 0],
            [0.02, 0],
            [0.01, 0],
            [0.03, 0],
        ];
        expect(buildTrialDisplayWaypoints(coordinates).map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 2, 3]);
    });

    it('preserves a hairpin smaller than the five-metre simplification tolerance', () => {
        const coordinates: Point[] = [
            [0, 0],
            [degrees(2), 0],
            [degrees(1), 0],
            [degrees(3), 0],
        ];
        expect(buildTrialDisplayWaypoints(coordinates).map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 2, 3]);
    });

    it('does not lose a reversal separated by duplicate vertices', () => {
        const coordinates: Point[] = [
            [0, 0],
            [0.02, 0],
            [0.02, 0],
            [0.01, 0],
            [0.03, 0],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints.map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 3, 4]);
        expect(displayWaypointLegRange(waypoints, 2)).toEqual({ first: 1, last: 2 });
    });

    it('always retains protected canal handovers, including one on a straight line', () => {
        const coordinates = parallelPath();
        const indices = Object.freeze([700, 100, 700]);
        const waypoints = buildTrialDisplayWaypoints(coordinates, indices);
        expect(waypoints.filter(({ kind }) => kind === 'handover').map(({ pathIndex }) => pathIndex)).toEqual([
            100, 700,
        ]);
        expectMonotonic(waypoints);
        expect(indices).toEqual([700, 100, 700]);
    });

    it('does not duplicate endpoint or spacing markers when a protected handover is coincident', () => {
        const coordinates: Point[] = [
            [0, 0],
            [degrees(50 * NM), 0],
            [degrees(100 * NM), 0],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates, [0, 1, 2]);
        expect(waypoints.map(({ kind }) => kind)).toEqual(['departure', 'handover', 'destination']);
        expect(waypoints.map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 2]);
    });

    it('uses an exact raw vertex when a 50 NM marker lands on it', () => {
        const coordinates: Point[] = [
            [0, 0],
            [degrees(50 * NM), 0],
            [degrees(120 * NM), 0],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints[1]).toMatchObject({ coordinates: coordinates[1], pathIndex: 1, kind: 'spacing' });
        expect(waypoints).toHaveLength(4);
    });

    it('measures spacing along the original bent path, never the simplified shortcut', () => {
        const coordinates: Point[] = [
            [0, 0],
            [degrees(40 * NM), degrees(2)],
            [degrees(80 * NM), 0],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints).toHaveLength(3);
        expect(waypoints[1].distanceM).toBeCloseTo(50 * NM, 8);
        expect(waypoints[1].pathIndex).toBeGreaterThan(1);
        expect(waypoints[1].coordinates[1]).toBeGreaterThan(0);
        expectMonotonic(waypoints);
    });

    it('handles the antimeridian along the short original segments instead of interpolating through Greenwich', () => {
        const waypoints = buildTrialDisplayWaypoints([
            [179, 0],
            [-179, 0],
        ]);
        expect(waypoints).toHaveLength(4);
        expect(waypoints.every(({ coordinates }) => Math.abs(coordinates[0]) >= 179)).toBe(true);
        expect(waypoints[3].distanceM / NM).toBeLessThan(121);
        expectMonotonic(waypoints);
    });

    it('keeps constant-course high-latitude/date-line paths sparse', () => {
        const waypoints = buildTrialDisplayWaypoints(parallelPath(240, 1000, 80, 175));
        expect(waypoints).toHaveLength(6);
        expectMonotonic(waypoints);
    });

    it('keeps a true high-latitude great-circle path sparse as well', () => {
        const latitude = (82 * Math.PI) / 180;
        const longitude = (170 * Math.PI) / 180;
        const coordinates: Point[] = Array.from({ length: 1000 }, (_, i) => {
            const arc = (i * 240 * NM) / 999 / EARTH_RADIUS_M;
            const lat = Math.asin(Math.sin(latitude) * Math.cos(arc));
            const lon =
                longitude +
                Math.atan2(Math.sin(arc) * Math.cos(latitude), Math.cos(arc) - Math.sin(latitude) * Math.sin(lat));
            return [(((lon * 180) / Math.PI + 540) % 360) - 180, (lat * 180) / Math.PI];
        });
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints).toHaveLength(6);
        expectMonotonic(waypoints);
    });

    it('supports exact polar vertices without Mercator infinities', () => {
        const waypoints = buildTrialDisplayWaypoints([
            [0, 89],
            [0, 90],
            [180, 89],
        ]);
        expect(waypoints.length).toBeGreaterThanOrEqual(4);
        expect(waypoints.every(({ coordinates }) => coordinates.every(Number.isFinite))).toBe(true);
        expectMonotonic(waypoints);
    });

    it('retains closed-loop travel instead of reducing it to a zero-length endpoint shortcut', () => {
        const coordinates: Point[] = [
            [0, 0],
            [0.01, 0],
            [0.01, 0.01],
            [0, 0.01],
            [0, 0],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints.map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 2, 3, 4]);
    });

    it('supports duplicate points and preserves every original zero-length leg in the display ranges', () => {
        const coordinates: Point[] = [
            [153, -27],
            [153, -27],
            [153, -27],
            [153, -27],
        ];
        const waypoints = buildTrialDisplayWaypoints(coordinates, [2]);
        expect(waypoints.map(({ pathIndex }) => pathIndex)).toEqual([0, 2, 3]);
        expect(waypoints.map(({ distanceM }) => distanceM)).toEqual([0, 0, 0]);
        expect(displayWaypointLegRange(waypoints, 1)).toEqual({ first: 0, last: 1 });
        expect(displayWaypointLegRange(waypoints, 2)).toEqual({ first: 2, last: 2 });
    });

    it('never mutates even deeply frozen inputs or returns coordinate aliases', () => {
        const coordinates = Object.freeze([Object.freeze([153, -27] as const), Object.freeze([153.1, -27] as const)]);
        const waypoints = buildTrialDisplayWaypoints(coordinates, Object.freeze([0]));
        waypoints[0].coordinates[0] = 0;
        expect(coordinates[0][0]).toBe(153);
    });

    it.each(
        [
            [],
            [[0, 0]],
            [
                [NaN, 0],
                [1, 0],
            ],
            [
                [0, 0],
                [1, Infinity],
            ],
            [
                [0, 0],
                [181, 0],
            ],
            [
                [0, 0],
                [0, -91],
            ],
            [
                [0, 0],
                [180, 0],
            ],
        ].map((coordinates) => ({ coordinates })),
    )('fails closed on unsupported or invalid input $coordinates', ({ coordinates }) => {
        expect(buildTrialDisplayWaypoints(coordinates as Point[])).toEqual([]);
    });

    it.each([[NaN], [Infinity], [-1], [2], [0.5]].map((indices) => ({ indices })))(
        'does not ignore an invalid protected handover index %j',
        ({ indices }) => {
            expect(
                buildTrialDisplayWaypoints(
                    [
                        [0, 0],
                        [1, 0],
                    ],
                    indices,
                ),
            ).toEqual([]);
        },
    );

    it('bounds input and generated output at 10,000 instead of silently truncating a route', () => {
        expect(buildTrialDisplayWaypoints(Array.from({ length: 10_001 }, () => [0, 0]))).toEqual([]);
        const globeZigzag: Point[] = Array.from({ length: 10_000 }, (_, i) => [i % 2 ? 179 : 0, 0]);
        expect(buildTrialDisplayWaypoints(globeZigzag)).toEqual([]);
    });

    it('handles 10,000 detailed vertices without recursion or dropping protected corners', () => {
        const coordinates: Point[] = Array.from({ length: 10_000 }, (_, i) => [
            153 + i * 0.00001,
            -27 + (i % 2) * 0.0001,
        ]);
        const waypoints = buildTrialDisplayWaypoints(coordinates);
        expect(waypoints).toHaveLength(10_000);
        expect(waypoints[9999].pathIndex).toBe(9999);
    });
});

describe('inspection-safe waypoint plan fallback', () => {
    it('uses the sparse plan normally without changing its waypoint mapping', () => {
        const coordinates = parallelPath();
        expect(buildTrialWaypointPlan(coordinates)).toEqual({
            sparse: true,
            waypoints: buildTrialDisplayWaypoints(coordinates),
        });
    });

    it('falls back to all original vertices when 50 NM marks would exceed the output bound', () => {
        const coordinates: Point[] = Array.from({ length: 100 }, (_, i) => [i % 2 ? 179 : 0, 0]);
        const before = JSON.stringify(coordinates);
        const plan = buildTrialWaypointPlan(coordinates, [10]);
        expect(plan.sparse).toBe(false);
        expect(plan.waypoints).toHaveLength(100);
        expect(plan.waypoints[10].kind).toBe('handover');
        plan.waypoints.forEach((point, index) => {
            expect(point.coordinates).toEqual(coordinates[index]);
            expect(point.coordinates).not.toBe(coordinates[index]);
            expect(point.pathIndex).toBe(index);
            expect(point.distanceM).toBeCloseTo(((index * 179 * Math.PI) / 180) * EARTH_RADIUS_M, 4);
            if (index > 0)
                expect(displayWaypointLegRange(plan.waypoints, index)).toEqual({ first: index - 1, last: index - 1 });
        });
        expect(JSON.stringify(coordinates)).toBe(before);
    });

    it('keeps antipodal source endpoints inspectable without inventing intermediate geometry', () => {
        const coordinates: Point[] = [
            [0, 0],
            [180, 0],
            [180, 1],
        ];
        const plan = buildTrialWaypointPlan(coordinates);
        expect(plan.sparse).toBe(false);
        expect(plan.waypoints.map(({ coordinates }) => coordinates)).toEqual(coordinates);
        expect(plan.waypoints[1].distanceM).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 5);
        expect(plan.waypoints[2].distanceM).toBeGreaterThan(plan.waypoints[1].distanceM);
        expect(displayWaypointLegRange(plan.waypoints, 1)).toEqual({ first: 0, last: 0 });
        expect(displayWaypointLegRange(plan.waypoints, 2)).toEqual({ first: 1, last: 1 });
    });

    it('keeps every raw leg inspectable if the protected-index request is invalid', () => {
        const coordinates: Point[] = [
            [0, 0],
            [0.01, 0],
            [0.02, 0],
        ];
        const plan = buildTrialWaypointPlan(coordinates, [5]);
        expect(plan.sparse).toBe(false);
        expect(plan.waypoints.map(({ pathIndex }) => pathIndex)).toEqual([0, 1, 2]);
    });

    it('does not pretend malformed or over-bound source geometry is inspectable', () => {
        for (const coordinates of [
            [],
            [[0, 0]],
            [
                [NaN, 0],
                [1, 0],
            ],
            Array(2),
            Array.from({ length: 10_001 }, () => [0, 0]),
        ]) {
            expect(buildTrialWaypointPlan(coordinates as Point[])).toEqual({ waypoints: [], sparse: false });
        }
    });
});

describe('display waypoint → original review leg mapping', () => {
    it('maps original indices to the first arriving display waypoint with zero-based numbering', () => {
        const waypoints = buildTrialDisplayWaypoints([
            [0, 0],
            [degrees(120 * NM), 0],
        ]);
        expect(displayWaypointForPathIndex(waypoints, 0)).toBe(0);
        expect(displayWaypointForPathIndex(waypoints, 0.01)).toBe(1);
        expect(displayWaypointForPathIndex(waypoints, waypoints[1].pathIndex)).toBe(1);
        expect(displayWaypointForPathIndex(waypoints, waypoints[1].pathIndex + 0.001)).toBe(2);
        expect(displayWaypointForPathIndex(waypoints, 1)).toBe(3);
        expect(displayWaypointForPathIndex(waypoints, 2)).toBe(3);
        expect(displayWaypointForPathIndex(waypoints, -1)).toBe(0);
    });

    it('keeps a source leg in both display ranges when a 50 NM marker splits it', () => {
        const waypoints = buildTrialDisplayWaypoints([
            [0, 0],
            [degrees(120 * NM), 0],
        ]);
        expect(waypoints).toHaveLength(4);
        expect(displayWaypointLegRange(waypoints, 0)).toBeNull();
        expect(displayWaypointLegRange(waypoints, 1)).toEqual({ first: 0, last: 0 });
        expect(displayWaypointLegRange(waypoints, 2)).toEqual({ first: 0, last: 0 });
        expect(displayWaypointLegRange(waypoints, 3)).toEqual({ first: 0, last: 0 });
    });

    it('includes every one of the 999 original legs: no depth or hazard check is hidden by sparse marks', () => {
        const waypoints = buildTrialDisplayWaypoints(parallelPath());
        const covered = new Set<number>();
        for (let i = 1; i < waypoints.length; i++) {
            const range = displayWaypointLegRange(waypoints, i)!;
            for (let leg = range.first; leg <= range.last; leg++) covered.add(leg);
            if (i > 1) {
                const before = displayWaypointLegRange(waypoints, i - 1)!;
                expect(range.first).toBeLessThanOrEqual(before.last + 1);
            }
        }
        expect([...covered]).toEqual(Array.from({ length: 999 }, (_, i) => i));
    });

    it('does not invent overlap when a display boundary is an exact original vertex', () => {
        const waypoints = buildTrialDisplayWaypoints([
            [0, 0],
            [0.01, 0],
            [0.01, 0.01],
        ]);
        expect(displayWaypointLegRange(waypoints, 1)).toEqual({ first: 0, last: 0 });
        expect(displayWaypointLegRange(waypoints, 2)).toEqual({ first: 1, last: 1 });
    });

    it('fails closed for absent waypoints or invalid range requests', () => {
        expect(displayWaypointForPathIndex([], 1)).toBe(-1);
        const waypoints = buildTrialDisplayWaypoints([
            [0, 0],
            [0.01, 0],
        ]);
        expect(displayWaypointForPathIndex(waypoints, NaN)).toBe(-1);
        for (const index of [-1, 0, 0.5, 2, NaN, Infinity])
            expect(displayWaypointLegRange(waypoints, index)).toBeNull();
    });
});
