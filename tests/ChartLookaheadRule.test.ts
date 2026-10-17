import { describe, expect, it } from 'vitest';
import { aheadCone, scanAhead, type AheadHazard } from '../services/underway/lookaheadRule';
const at = 1_800_000_000_000;
const fix = { lat: 0, lon: 0, at, sogKn: 6, cogDeg: 0 };
const area = (depth: number): AheadHazard => ({
    layer: 'DEPARE',
    minDepthM: depth,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [-0.002, 0.005],
                [0.002, 0.005],
                [0.002, 0.01],
                [-0.002, 0.01],
                [-0.002, 0.005],
            ],
        ],
    },
});
describe('underway chart lookahead', () => {
    it('defaults to ten minutes, floors reach at 0.3 NM, and bounds choices', () => {
        expect(aheadCone(fix)?.distanceNm).toBe(1);
        expect(aheadCone({ ...fix, sogKn: 1 })?.distanceNm).toBe(0.3);
        expect(aheadCone(fix, 2)?.windowMin).toBe(5);
        expect(aheadCone(fix, 99)?.windowMin).toBe(15);
        expect(aheadCone({ ...fix, sogKn: 0 })).toBeNull();
        expect(aheadCone({ ...fix, cogDeg: NaN })).toBeNull();
    });
    it('uses draft plus shared UKC input exactly, including a raised margin', () => {
        const cone = aheadCone(fix)!;
        expect(scanAhead(cone, [area(2.5)], 2, 0.5)).toBeNull();
        expect(scanAhead(cone, [area(2.49)], 2, 0.5)?.kind).toBe('depth');
        expect(scanAhead(cone, [area(2.6)], 2, 0.7)?.kind).toBe('depth');
    });
    it('credits only supplied datum-matched tide at ETA; missing never guesses', () => {
        const cone = aheadCone(fix)!;
        const times: number[] = [];
        expect(
            scanAhead(cone, [area(2)], 2, 0.5, (t) => {
                times.push(t);
                return 0.5;
            }),
        ).toBeNull();
        expect(times.every((t) => t >= at && t <= at + 10 * 60_000)).toBe(true);
        expect(scanAhead(cone, [area(2)], 2, 0.5, () => null)?.kind).toBe('depth');
        expect(scanAhead(cone, [area(2.6)], 2, 0.5, () => -0.3)?.kind).toBe('depth');
    });
    it('keeps the least water while crossing a depth area on a falling tide', () => {
        const cone = aheadCone(fix)!;
        expect(scanAhead(cone, [area(2)], 2, 0.5, (t) => (t < at + 4 * 60_000 ? 1 : 0))?.kind).toBe('depth');
    });
    it('detects a thin polygon crossing between samples, and ignores an adjacent mark', () => {
        const cone = aheadCone(fix)!;
        const thin: AheadHazard = {
            layer: 'LNDARE',
            minDepthM: null,
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [-0.01, 0.007],
                        [0.01, 0.007],
                        [0.01, 0.007001],
                        [-0.01, 0.007001],
                        [-0.01, 0.007],
                    ],
                ],
            },
        };
        expect(scanAhead(cone, [thin], 2, 0.5)?.kind).toBe('danger');
        const rock: AheadHazard = {
            layer: 'UWTROC',
            minDepthM: null,
            geometry: { type: 'Point', coordinates: [0.001, 0.005] },
        };
        expect(scanAhead(cone, [rock], 2, 0.5)).toBeNull();
        expect(scanAhead(cone, [{ ...rock, geometry: { type: 'Point', coordinates: [0, 0.005] } }], 2, 0.5)?.kind).toBe(
            'danger',
        );
    });
    it('honours polygon holes and does not credit tide over solid dangers', () => {
        const cone = aheadCone(fix)!;
        const land: AheadHazard = {
            layer: 'LNDARE',
            minDepthM: null,
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [-0.1, -0.1],
                        [0.1, -0.1],
                        [0.1, 0.1],
                        [-0.1, 0.1],
                        [-0.1, -0.1],
                    ],
                    [
                        [-0.01, -0.01],
                        [-0.01, 0.04],
                        [0.01, 0.04],
                        [0.01, -0.01],
                        [-0.01, -0.01],
                    ],
                ],
            },
        };
        expect(scanAhead(cone, [land], 2, 0.5)).toBeNull();
        expect(
            scanAhead(
                cone,
                [{ layer: 'WRECKS', minDepthM: 50, geometry: { type: 'Point', coordinates: [0, 0.005] } }],
                2,
                0.5,
                () => 10,
            )?.kind,
        ).toBe('danger');
    });
    it('wraps the antimeridian and retains danger on the centreline of a narrow corridor', () => {
        const cone = aheadCone({ ...fix, lon: 179.999, cogDeg: 90 }, 10, true)!;
        const rock: AheadHazard = {
            layer: 'UWTROC',
            minDepthM: null,
            geometry: { type: 'Point', coordinates: [-179.995, 0] },
        };
        expect(scanAhead(cone, [rock], 2, 0.5)?.kind).toBe('danger');
    });
});
