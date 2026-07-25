import { describe, expect, it } from 'vitest';

import { generateIsobarsFromGrid } from '../services/weather/isobars';

function synopticFixture() {
    const rows = 15;
    const cols = 15;
    const values = Array.from({ length: rows }, () => Array<number>(cols).fill(1013));

    // More than three well-separated extrema of each type. The renderer must
    // retain only the strongest three highs and lows so a global chart stays
    // legible, then attach four quiet circulation cues to every selected one.
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
    it('keeps H/L labels sparse and gives each retained centre four circulation arrows', () => {
        const result = generateIsobarsFromGrid(synopticFixture(), 0, true);
        const types = result.centers.features.map((feature) => feature.properties?.type);

        expect(types.filter((type) => type === 'H')).toHaveLength(3);
        expect(types.filter((type) => type === 'L')).toHaveLength(3);
        expect(result.centers.features).toHaveLength(6);
        expect(result.arrows.features).toHaveLength(24);
    });
});
