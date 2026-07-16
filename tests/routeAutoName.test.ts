/**
 * routeAutoName — locality-vs-coords naming + the ~1 km cache (geocoder
 * mocked; no network).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let geocodeResult: string | null = null;
let geocodeCalls = 0;
vi.mock('../services/weather', () => ({
    reverseGeocode: async () => {
        geocodeCalls++;
        return geocodeResult;
    },
}));

import { autoRouteName, coordsLabel, placeLabelFor } from '../services/routeAutoName';

describe('routeAutoName', () => {
    beforeEach(() => {
        geocodeCalls = 0;
    });

    it('coordsLabel is compact with hemispheres', () => {
        expect(coordsLabel({ lat: -27.142, lon: 153.093 })).toBe('27.14S 153.09E');
        expect(coordsLabel({ lat: 41.5, lon: -71.31 })).toBe('41.50N 71.31W');
    });

    it('uses the locality (first comma segment) when the geocoder answers', async () => {
        geocodeResult = 'Newport, QLD, AU';
        expect(await placeLabelFor({ lat: -27.2, lon: 153.1 })).toBe('Newport');
    });

    it('falls back to coords when the geocoder has nothing', async () => {
        geocodeResult = null;
        expect(await placeLabelFor({ lat: -26.5, lon: 153.9 })).toBe('26.50S 153.90E');
    });

    it('builds "A - B" and caches per ~1 km grid cell', async () => {
        geocodeResult = 'Scarborough, QLD, AU';
        const name = await autoRouteName({ lat: -27.19, lon: 153.11 }, { lat: -27.192, lon: 153.111 });
        expect(name).toBe('Scarborough - Scarborough');
        const callsAfterFirst = geocodeCalls;
        // Same grid cells again → pure cache, no new geocoder calls.
        await autoRouteName({ lat: -27.19, lon: 153.11 }, { lat: -27.192, lon: 153.111 });
        expect(geocodeCalls).toBe(callsAfterFirst);
    });
});
