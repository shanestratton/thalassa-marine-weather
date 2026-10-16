import { describe, it, expect } from 'vitest';
import type { Feature, Geometry } from 'geojson';
import { holdingGroundAt, seabedNature } from '../../services/enc/seabed';
const point = (x: number, y: number, NATSUR: unknown, extra = {}): Feature<Geometry> => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [x, y] },
    properties: { _caution: 'SBDARE', NATSUR, ...extra },
});
const area = (coordinates: number[][][], NATSUR: unknown): Feature<Geometry> => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates },
    properties: { _caution: 'SBDARE', NATSUR },
});
describe('IHO seabed semantics and advice', () => {
    it('keeps lava, coral, shells and boulders in their actual S-57 slots', () => {
        expect(seabedNature('11,14,17,18')).toMatchObject({
            label: 'Lava / Coral / Shells / Boulders',
            abbreviation: 'R Co Sh R',
            poor: true,
        });
        expect(seabedNature([4, 1])).toMatchObject({ label: 'Sand / Mud', abbreviation: 'S M', poor: false });
        expect(seabedNature('4/9')).toMatchObject({ label: 'Sand over Rock', abbreviation: 'S/R', poor: true });
    });
    it('does not silently turn missing or unknown codes into known holding', () => {
        expect(seabedNature('4,255')).toMatchObject({ label: 'Sand / Unknown', unknown: true });
        expect(seabedNature(null).unknown).toBe(true);
        expect(seabedNature({})).toMatchObject({ label: '', unknown: true });
        expect(seabedNature(Array(17).fill(4)).unknown).toBe(true);
        expect(seabedNature(['4'.repeat(1000)]).unknown).toBe(true);
    });
    it('labels nearby point samples and refuses to give them an invented area', () => {
        expect(holdingGroundAt(0, 0, [point(0.0001, 0, 9)])).toMatchObject({ kind: 'poor', pointSample: true });
        expect(holdingGroundAt(0, 0, [point(0.001, 0, 9)]).kind).toBe('unknown');
    });
    it('uses polygon coverage and subtracts holes', () => {
        const square = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
        ];
        const hole = [
            [-0.1, -0.1],
            [0.1, -0.1],
            [0.1, 0.1],
            [-0.1, 0.1],
            [-0.1, -0.1],
        ];
        expect(holdingGroundAt(0, 0, [area([square, hole], 4)]).kind).toBe('unknown');
        expect(holdingGroundAt(0.5, 0.5, [area([square, hole], 4)])).toMatchObject({
            kind: 'charted',
            pointSample: false,
        });
    });
    it('keeps a dateline patch at the dateline', () => {
        const patch = area(
            [
                [
                    [179, -1],
                    [-179, -1],
                    [-179, 1],
                    [179, 1],
                    [179, -1],
                ],
            ],
            9,
        );
        expect(holdingGroundAt(0, 180, [patch]).kind).toBe('poor');
        expect(holdingGroundAt(0, 0, [patch]).kind).toBe('unknown');
    });
    it('treats mixed/unknown material conservatively and never excludes a place', () => {
        const result = holdingGroundAt(0, 0, [point(0, 0, '4,9')]);
        expect(result.text).toMatch(/holding may be poor; check/);
        expect(result).not.toHaveProperty('exclude');
        expect(holdingGroundAt(0, 0, [point(0, 0, 4)]).text).toContain('check the actual holding');
        expect(holdingGroundAt(0, 0, [point(0, 0, null)]).text).toContain('incomplete');
    });
    it('refuses reference charts, malformed positions and unbounded input', () => {
        expect(holdingGroundAt(0, 0, [point(0, 0, 9, { _reference: true })]).kind).toBe('unknown');
        expect(holdingGroundAt(NaN, 0, []).kind).toBe('unknown');
        expect(
            holdingGroundAt(0, 0, [{ ...point(0, 0, 4), geometry: null } as unknown as Feature<Geometry>]).kind,
        ).toBe('unknown');
        expect(holdingGroundAt(0, 0, Array(8193).fill(point(0, 0, 4))).kind).toBe('unknown');
    });
});
