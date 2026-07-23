import { describe, expect, it, vi } from 'vitest';
import { directionsToGeoJSON, getDirections } from '../services/MapboxDirectionsService';

describe('MapboxDirectionsService input boundary', () => {
    it('rejects invalid geographic coordinates before attempting a network request', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(getDirections({ lat: 91, lon: 151 }, { lat: -20, lon: 149 })).resolves.toBeNull();
        await expect(getDirections({ lat: -20, lon: Number.NaN }, { lat: -20, lon: 149 })).resolves.toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
    });

    it('creates a map-renderer-compatible route feature', () => {
        expect(
            directionsToGeoJSON([
                [151.2, -33.9],
                [151.3, -33.8],
            ]),
        ).toEqual({
            type: 'Feature',
            properties: { source: 'mapbox-directions' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [151.2, -33.9],
                    [151.3, -33.8],
                ],
            },
        });
    });
});
