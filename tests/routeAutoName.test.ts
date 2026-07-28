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

import { autoRouteName, coordsLabel, looksAutoNamed, placeLabelFor } from '../services/routeAutoName';

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

/**
 * Auto-naming stops as soon as the name box stops matching the last value we
 * generated. Opening a saved route never re-seeded that marker, so a restored
 * name looked hand-typed and the title froze — drag the destination from
 * Moreton Bay to Lady Musgrave and it still read Moreton Bay.
 */
describe('looksAutoNamed', () => {
    it('recognises the "A - B" shape autoRouteName produces', () => {
        expect(looksAutoNamed('Newport - Scarborough')).toBe(true);
        expect(looksAutoNamed('Moreton Bay - Lady Musgrave')).toBe(true);
        // Either half may have fallen back to compact coords.
        expect(looksAutoNamed(`Newport - ${coordsLabel({ lat: -27.14, lon: 153.09 })}`)).toBe(true);
        expect(looksAutoNamed(`${coordsLabel({ lat: -27.14, lon: 153.09 })} - Newport`)).toBe(true);
    });

    it('leaves a name with no separator alone', () => {
        // The skipper's own words must never be overwritten by a pin drag.
        expect(looksAutoNamed('Winter delivery run')).toBe(false);
        expect(looksAutoNamed('Shakedown')).toBe(false);
        expect(looksAutoNamed('')).toBe(false);
        expect(looksAutoNamed('   ')).toBe(false);
    });

    it('does not treat a hyphenated word as a separator', () => {
        // " - " with spaces, not any hyphen — otherwise "Half-Tide Rock" would
        // re-arm and get clobbered on the next pin move.
        expect(looksAutoNamed('Half-Tide Rock')).toBe(false);
        expect(looksAutoNamed('Two-day hop')).toBe(false);
    });

    it('needs a real place on both sides', () => {
        // The chained-leg prefill is "Newport - " with nothing after it yet —
        // a placeholder, not a finished auto name.
        expect(looksAutoNamed('Newport - ')).toBe(false);
        expect(looksAutoNamed(' - Newport')).toBe(false);
        expect(looksAutoNamed(' - ')).toBe(false);
    });
});
