import { describe, expect, it } from 'vitest';

import { generateIsobarsFromGrid } from '../services/weather/isobars';

function synopticFixture() {
    const rows = 15;
    const cols = 15;
    const values = Array.from({ length: rows }, () => Array<number>(cols).fill(1013));

    // Several well-separated extrema of each type. NOTE: these are
    // single-cell spikes of 15-25 hPa against flat 1013 — a shape no
    // atmosphere produces. It exercises the CUE plumbing (arrows per centre,
    // major-contour flagging) only. Detection against a realistic synoptic
    // field is proved in PressureCentresRealField.test.ts, which is what the
    // old 2 hPa-over-1-degree threshold silently failed.
    for (const [row, col, pressure] of [
        [2, 2, 1030],
        [2, 6, 1032],
        [2, 10, 1034],
        [6, 2, 1036],
        [6, 6, 1038],
        [6, 10, 1040],
        [10, 2, 996],
        [10, 6, 994],
        [10, 10, 992],
        [12, 4, 990],
        [12, 8, 988],
        [12, 12, 986],
    ] as const) {
        values[row][col] = pressure;
    }

    const hourly = Array.from({ length: 13 }, () => values.map((row) => [...row]));
    const zeros = Array.from({ length: 13 }, () => Array.from({ length: rows }, () => Array(cols).fill(0)));
    return {
        allHourlyPressure: hourly,
        allHourlyWindSpeed: zeros,
        allHourlyWindDir: zeros,
        lats: Array.from({ length: rows }, (_, index) => -70 + index * 10),
        lons: Array.from({ length: cols }, (_, index) => -140 + index * 20),
        rows,
        cols,
        totalHours: 13,
        refTime: null,
        keyframeFhrs: [0, 3, 6, 9, 12],
        subFrameStepHours: 1,
        source: 'gfs' as const,
    };
}

describe('pressure chart cues', () => {
    it('gives every retained centre four circulation arrows', () => {
        // The per-type cap was 3 GLOBALLY until 2026-08-21, which meant a
        // skipper panning to the Coral Sea routinely saw no centre at all —
        // the three strongest systems on Earth were somewhere else. The cap
        // is generous now and Mapbox's symbol collision declutters what is
        // actually on screen. What must hold: the cap still bounds the set,
        // both types are found, and every centre keeps its four arrows.
        const result = generateIsobarsFromGrid(synopticFixture(), 0, true);
        const types = result.centers.features.map((feature) => feature.properties?.type);

        expect(types.filter((type) => type === 'H').length).toBeGreaterThan(0);
        expect(types.filter((type) => type === 'L').length).toBeGreaterThan(0);
        expect(types.filter((type) => type === 'H').length).toBeLessThanOrEqual(14);
        expect(types.filter((type) => type === 'L').length).toBeLessThanOrEqual(14);
        expect(result.arrows.features).toHaveLength(result.centers.features.length * 4);
    });

    it('marks each 8 hPa contour as a visual major without dropping 4 hPa detail', () => {
        const result = generateIsobarsFromGrid(synopticFixture(), 0, true);

        expect(result.contours.features.length).toBeGreaterThan(0);
        for (const feature of result.contours.features) {
            const pressure = feature.properties?.pressure;
            expect(feature.properties?.isMajor).toBe(pressure % 8 === 0);
        }
    });
});
