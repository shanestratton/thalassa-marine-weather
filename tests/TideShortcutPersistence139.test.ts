import { describe, expect, it } from 'vitest';
import { inshoreRouteToGeoJSON, type InshoreRouteResult } from '../services/InshoreRouter';
const r: InshoreRouteResult = {
    polyline: [
        [153, -27],
        [153.01, -27],
    ],
    distanceNM: 1,
    cellsUsed: [],
    elapsedMs: 1,
};
describe('temporary tide authority never persists', () => {
    it('keeps ordinary route serialization unchanged', () => {
        expect(
            inshoreRouteToGeoJSON(r, { lat: -27, lon: 153 }, { lat: -27, lon: 153.01 }).geometry.coordinates,
        ).toEqual(r.polyline);
    });
    it('refuses a live or copied temporary preview at the serialization boundary', () => {
        const preview = {
            ...r,
            tideShortcut: {
                kind: 'preview' as const,
                departureMs: 1,
                arrivalMs: 2,
                expiresAtMs: 3,
                speedKts: 6,
                uncertaintyMs: 900000,
                sourceSummary: 'fictional',
            },
        };
        for (const value of [preview, JSON.parse(JSON.stringify(preview))])
            expect(() => inshoreRouteToGeoJSON(value, { lat: -27, lon: 153 }, { lat: -27, lon: 153.01 })).toThrow(
                /temporary tide-window preview/,
            );
    });
});
