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
    it('compares actual +12h, not +12 indices, for GFS 2h-frame movement tracks', () => {
        const side = 31;
        const frames = Array.from({ length: 13 }, (_, hour) =>
            Array.from({ length: side }, (_, row) =>
                Array.from(
                    { length: side },
                    (_, col) => 1013 - 25 * Math.exp(-((row - 15) ** 2 + (col - (10 + hour / 3)) ** 2) / 18),
                ),
            ),
        );
        const zeros = frames.map((frame) => frame.map((row) => row.map(() => 0)));
        const grid = {
            allHourlyPressure: frames,
            allHourlyWindSpeed: zeros,
            allHourlyWindDir: zeros,
            lats: Array.from({ length: side }, (_, i) => i),
            lons: Array.from({ length: side }, (_, i) => i),
            rows: side,
            cols: side,
            totalHours: 13,
            refTime: null,
            keyframeFhrs: [0, 6, 12, 18, 24],
            subFrameStepHours: 2,
            source: 'gfs' as const,
        };
        const result = generateIsobarsFromGrid(grid, 0, true);
        const track = result.tracks.features.find((feature) => feature.properties?.type === 'L');
        expect(track?.properties?.speed).toBe(19); // 2 degrees / 12h, not 4 degrees / 12h
        expect((track?.geometry as GeoJSON.LineString).coordinates).toEqual([
            [10, 15],
            [12, 15],
        ]);
        expect(generateIsobarsFromGrid(grid, 7, true).tracks.features).toEqual([]);
    });

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
            expect(feature.properties?.isDetail).toBe(pressure % 4 !== 0);
            expect(pressure % 2).toBe(0);
        }
        expect(result.contours.features.some((feature) => feature.properties?.isDetail)).toBe(true);
    });
});

describe('pressure chart wind barbs', () => {
    it('draws no barb where the wind reading is missing, rather than a calm or a northerly', () => {
        // UX scorecard run 7: a failed cell used to arrive as 0 kt from 000°.
        const grid = synopticFixture();
        const speeds = grid.allHourlyWindSpeed.map((hour) => hour.map((row) => row.map(() => 20)));
        const dirs = grid.allHourlyWindDir.map((hour) => hour.map((row) => row.map(() => 90)));
        speeds[0][0][0] = Number.NaN; // no speed at the first barb site
        dirs[0][0][5] = Number.NaN; // no direction at the second
        const result = generateIsobarsFromGrid(
            { ...grid, allHourlyWindSpeed: speeds, allHourlyWindDir: dirs },
            0,
            true,
        );
        const sites = result.barbs.features.map((feature) => (feature.geometry as GeoJSON.Point).coordinates.join(','));
        expect(sites).not.toContain(`${grid.lons[0]},${grid.lats[0]}`);
        expect(sites).not.toContain(`${grid.lons[5]},${grid.lats[0]}`);
        expect(sites).toContain(`${grid.lons[10]},${grid.lats[0]}`);
        for (const feature of result.barbs.features) {
            expect(feature.properties?.direction).toBe(90);
            expect(feature.properties?.speed).toBe(20);
        }
    });
});
