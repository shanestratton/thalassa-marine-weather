import { describe, expect, it } from 'vitest';

import { buildWindHeatmapSegments } from '../components/map/windHeatmapSegments';

describe('wind heatmap longitude segments', () => {
    it('splits a normalised global −180…180 grid at Greenwich with a shared seam column', () => {
        expect(buildWindHeatmapSegments({ columns: 361, west: -180, east: 180 })).toEqual([
            { sourceSuffix: '', startColumn: 0, endColumn: 180, west: -180, east: 0 },
            { sourceSuffix: '_r', startColumn: 180, endColumn: 360, west: 0, east: 180 },
        ]);
    });

    it('also safely maps an upstream 0…360 global grid onto conventional longitudes', () => {
        expect(buildWindHeatmapSegments({ columns: 361, west: 0, east: 360 })).toEqual([
            { sourceSuffix: '', startColumn: 0, endColumn: 180, west: 0, east: 180 },
            { sourceSuffix: '_r', startColumn: 180, endColumn: 360, west: -180, east: 0 },
        ]);
    });

    it('splits a date-line-crossing regional grid at ±180° without a gap', () => {
        expect(buildWindHeatmapSegments({ columns: 41, west: 170, east: -170 })).toEqual([
            { sourceSuffix: '', startColumn: 0, endColumn: 20, west: 170, east: 180 },
            { sourceSuffix: '_r', startColumn: 20, endColumn: 40, west: -180, east: -170 },
        ]);
    });

    it('keeps an ordinary regional grid as one image', () => {
        expect(buildWindHeatmapSegments({ columns: 21, west: 140, east: 160 })).toEqual([
            { sourceSuffix: '', startColumn: 0, endColumn: 20, west: 140, east: 160 },
        ]);
    });
});
