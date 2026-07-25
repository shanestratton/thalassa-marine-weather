import { describe, expect, it } from 'vitest';

import { normalizeGlobalPressureFrames } from '../supabase/functions/fetch-pressure-grid/global-longitudes';

function numberedFrame(width: number): number[][][] {
    return [[Array.from({ length: width }, (_, index) => index)]];
}

describe('global GFS pressure longitude normalization', () => {
    it('moves a 360-column 0…359° row onto a closed −180…180° axis without shifting the weather field', () => {
        const { frames, lons } = normalizeGlobalPressureFrames(numberedFrame(360));
        const row = frames[0][0];

        expect(lons).toHaveLength(361);
        expect(lons[0]).toBe(-180);
        expect(lons[180]).toBe(0);
        expect(lons.at(-1)).toBe(180);
        expect(row[0]).toBe(180); // raw 180°E → −180°
        expect(row.at(-1)).toBe(row[0]); // close the raster cleanly at +180°
        expect(row[lons.indexOf(0)]).toBe(0); // raw Greenwich stays Greenwich
        expect(row[lons.indexOf(153)]).toBe(153); // Australia remains at 153°E
    });

    it('preserves the duplicated dateline seam for a 361-column inclusive grid', () => {
        const { frames, lons } = normalizeGlobalPressureFrames(numberedFrame(361));
        const row = frames[0][0];

        expect(lons).toHaveLength(361);
        expect(lons[0]).toBe(-180);
        expect(lons.at(-1)).toBe(180);
        expect(row[0]).toBe(180);
        expect(row.at(-1)).toBe(180);
        expect(row[lons.indexOf(0)]).toBe(0);
        expect(row[lons.indexOf(153)]).toBe(153);
    });

    it('refuses malformed rows instead of silently drawing them at the wrong place', () => {
        expect(() => normalizeGlobalPressureFrames([[[1, 2, 3, 4]], [[1, 2, 3]]])).toThrow(
            'Pressure frames must all share one rectangular grid',
        );
    });
});
