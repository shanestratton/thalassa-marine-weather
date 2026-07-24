import { describe, expect, it } from 'vitest';
import { sanitizeRouteCoordinates } from '../utils/routeCoordinates';

describe('sanitizeRouteCoordinates', () => {
    it('rejects corrupt coordinates and the missing-fix sentinel', () => {
        expect(
            sanitizeRouteCoordinates([
                { lat: Number.NaN, lon: 153 },
                { lat: -91, lon: 153 },
                { lat: -27, lon: 181 },
                { lat: 0, lon: 0 },
                { lat: 0, lon: 153 },
                { lat: -27, lon: 0 },
            ]),
        ).toEqual([
            { lat: 0, lon: 153 },
            { lat: -27, lon: 0 },
        ]);
    });

    it('removes consecutive duplicates without changing route order', () => {
        expect(
            sanitizeRouteCoordinates([
                { lat: -27.5, lon: 153 },
                { lat: -27.5, lon: 153 },
                { lat: -27.4, lon: 153.1 },
                { lat: -27.5, lon: 153 },
            ]),
        ).toEqual([
            { lat: -27.5, lon: 153 },
            { lat: -27.4, lon: 153.1 },
            { lat: -27.5, lon: 153 },
        ]);
    });
});
