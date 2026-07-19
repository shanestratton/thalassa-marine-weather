/**
 * usePickerMode — the location-box map picker must CLAIM LocationStore.
 *
 * The Glass page mounts useLiveLocationName, which re-stamps
 * LocationStore with source:'gps' (and the boat's own place name) every
 * 3s. Its only hard override is source === 'map_pin'. App.tsx then
 * prefers that GPS name over weatherData.locationName for the header
 * title, and Dashboard does the same for its own locationName.
 *
 * So a picker that selects a location without claiming the store gets
 * the weather it asked for and then has every label quietly reverted to
 * where the boat is — which reads as "the map button doesn't bring up
 * the weather for that location". The long-press pin drop (useMapInit)
 * always claimed the store; the location-box picker never did.
 */
import { renderHook } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';

vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            setLngLat() {
                return this;
            }
            addTo() {
                return this;
            }
            remove() {}
        },
    },
}));

vi.mock('../utils/system', () => ({ triggerHaptic: () => {} }));
vi.mock('../utils/createMarkerEl', () => ({ createPinMarker: () => document.createElement('div') }));

const reverseGeocode = vi.fn(async () => 'Mooloolaba, QLD');
vi.mock('../services/weatherService', () => ({ reverseGeocode: (...a: unknown[]) => reverseGeocode(...(a as [])) }));

import { usePickerMode } from '../components/map/usePickerMode';
import { LocationStore } from '../stores/LocationStore';

/** Stub map that captures the click handler usePickerMode registers. */
function stubMap() {
    let handler: ((e: unknown) => void) | null = null;
    const map = {
        on: (evt: string, fn: (e: unknown) => void) => {
            if (evt === 'click') handler = fn;
        },
        off: () => {},
    } as unknown as mapboxgl.Map;
    return { map, tap: (lat: number, lng: number) => handler?.({ lngLat: { lat, lng } }) };
}

function mount(map: mapboxgl.Map, onLocationSelect?: (lat: number, lon: number, name?: string) => void) {
    const mapRef = { current: map };
    const pinRef = { current: null };
    return renderHook(() => usePickerMode(mapRef, pinRef, true, onLocationSelect));
}

/** Let the tap's dynamic import + geocode chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('usePickerMode → LocationStore', () => {
    // usePickerMode reaches the geocoder through a dynamic import inside
    // its click handler. Resolve that module once up front — resolving it
    // lazily mid-test races the mock registry, and the real module graph
    // (services/weather → stormglass → settingsStore) throws on a
    // circular import when it wins.
    beforeAll(async () => {
        await import('../services/weatherService');
    });

    beforeEach(() => {
        // mockReset (not mockClear) — a leftover *Once queue from a prior
        // test would otherwise decide this test's geocode result.
        reverseGeocode.mockReset();
        reverseGeocode.mockResolvedValue('Mooloolaba, QLD');
        LocationStore.setFromGPS(-27.2, 153.1, 'Scarborough, QLD');
    });

    it("claims the store as 'map_pin' so the live GPS name can't overwrite the pick", async () => {
        const { map, tap } = stubMap();
        const { unmount } = mount(map);

        tap(-26.68, 153.12);
        await vi.waitFor(() => expect(LocationStore.getState().source).toBe('map_pin'));

        await settle();
        unmount();
    });

    it('claims the store synchronously on tap, before the geocode resolves', async () => {
        const { map, tap } = stubMap();
        const { unmount } = mount(map);

        tap(-26.68, 153.12);
        // Asserted before any await — the 3s GPS poll must be locked out
        // immediately, not once the network comes back.
        expect(LocationStore.getState().source).toBe('map_pin');
        expect(LocationStore.getState().lat).toBeCloseTo(-26.68);

        await settle();
        unmount();
    });

    it('promotes the geocoded name into the store and reports it to the caller', async () => {
        const { map, tap } = stubMap();
        const onLocationSelect = vi.fn();
        mount(map, onLocationSelect);

        tap(-26.68, 153.12);
        await vi.waitFor(() => expect(onLocationSelect).toHaveBeenCalledWith(-26.68, 153.12, 'Mooloolaba, QLD'));
        expect(LocationStore.getState().name).toBe('Mooloolaba, QLD');
    });

    it('still claims the store when the geocode fails, falling back to coordinates', async () => {
        reverseGeocode.mockRejectedValueOnce(new Error('offline'));
        const { map, tap } = stubMap();
        const onLocationSelect = vi.fn();
        mount(map, onLocationSelect);

        tap(-26.68, 153.12);
        await vi.waitFor(() => expect(onLocationSelect).toHaveBeenCalled());
        expect(LocationStore.getState().source).toBe('map_pin');
        expect(onLocationSelect.mock.calls[0][2]).toMatch(/26\.6800°S, 153\.1200°E/);
    });

    it('does not geocode the same coordinate twice (picker already resolved the name)', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const { map, tap } = stubMap();
        mount(map);

        tap(-26.68, 153.12);
        await vi.waitFor(() => expect(LocationStore.getState().name).toBe('Mooloolaba, QLD'));
        // LocationStore.setFromMapPin has its own Nominatim lookup; passing
        // a name must short-circuit it.
        expect(fetchSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});
