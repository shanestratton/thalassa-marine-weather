import { it, expect } from 'vitest';
import { sshGeostrophicArrows } from '../services/weather/sshArrows';
import type { SshObservation } from '../services/weather/api/sshObservations';
function observation(): SshObservation {
    const grid = {
        width: 4,
        height: 3,
        west: -135,
        south: -60,
        dx: 90,
        dy: 60,
        values: new Float32Array(12).fill(1),
        validMask: new Uint8Array(12).fill(1),
        wrapLongitude: true,
    };
    return {
        generation: 'one-original-map',
        sourceTimeMs: 1792108800000,
        validUntilMs: 1792408800000,
        adt: grid,
        sla: grid,
        eastward: grid,
        northward: { ...grid, values: new Float32Array(12) },
    };
}
it('has at most96 bounded vectors in native east/north m/s, dated as observations', () => {
    const result = sshGeostrophicArrows(observation(), [-150, -50, 150, 50]);
    expect(result.features).toHaveLength(96);
    for (const feature of result.features) {
        expect(feature.properties).toMatchObject({ kind: 'geostrophic', northward: 0, sourceTimeMs: 1792108800000 });
        // Bilinear weights preserve the native vector within floating-point precision.
        expect(feature.properties!.eastward).toBeCloseTo(1, 12);
        expect(feature.properties!.speedMps).toBeCloseTo(1, 12);
        const [tail, tip] = feature.geometry.coordinates[0];
        expect(tip[0]).toBeGreaterThan(tail[0]);
        expect(tip[1]).toBe(tail[1]);
    }
});
it('never bridges an unknown/ice mask', () => {
    const source = observation();
    source.eastward.validMask.fill(0);
    expect(sshGeostrophicArrows(source, [-150, -50, 150, 50]).features).toEqual([]);
});
it('keeps dateline and repeated-world views bounded without cross-world arrow lines', () => {
    for (const bounds of [
        [170, -30, 190, 30],
        [890, -30, 910, 30],
    ] as const) {
        const result = sshGeostrophicArrows(observation(), bounds);
        expect(result.features.length).toBeGreaterThan(0);
        expect(result.features.length).toBeLessThanOrEqual(96);
        for (const f of result.features)
            for (const line of f.geometry.coordinates) {
                expect(Math.abs(line[1][0] - line[0][0])).toBeLessThan(10);
                for (const point of line) expect(Math.abs(point[0])).toBeLessThanOrEqual(180);
            }
    }
});
it('rejects unbounded/nonfinite/empty viewports and does not claim polar vectors', () => {
    for (const bounds of [
        [-180, -90, 181, 90],
        [0, 0, NaN, 10],
        [0, 20, 10, 10],
        [0, 86, 10, 89],
    ] as const)
        expect(sshGeostrophicArrows(observation(), bounds).features).toEqual([]);
});
