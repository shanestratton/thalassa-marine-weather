/**
 * handleFavoriteSelect — selecting a saved favourite must CLAIM LocationStore.
 *
 * Same defect class as the map picker (fixed db802ae0, see
 * pickerModeLocationStore.test.ts): The Glass mounts useLiveLocationName,
 * which re-stamps LocationStore with source:'gps' (and the boat's own
 * place name) every 3s, App.tsx/Dashboard prefer that live name for their
 * titles, and the model-comparison card reads coords straight off the
 * store. A favourite pick that never claims the store gets the weather it
 * asked for and then has every label — and the comparison card's data —
 * quietly reverted to the boat's position within seconds.
 *
 * Twist vs the picker: favourites don't always carry coords. Ocean-point
 * favourites encode them in the name and claim synchronously on tap;
 * named favourites can only claim once the weather report resolves and
 * weatherData.coordinates exists.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    weatherData: null as Record<string, unknown> | null,
    selectLocation: vi.fn(async (_loc: string, _coords?: { lat: number; lon: number }) => {}),
    reverseGeocode: vi.fn(async () => 'Scarborough, QLD'),
    gpsCallback: null as ((pos: { latitude: number; longitude: number }) => void) | null,
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: h.weatherData,
        loading: false,
        fetchWeather: vi.fn(),
        selectLocation: h.selectLocation,
    }),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { displayMode: 'light', defaultLocation: '', savedLocations: [] },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: vi.fn(), isOffline: false, currentView: 'dashboard' }),
}));
vi.mock('../services/weatherService', () => ({
    reverseGeocode: (...a: unknown[]) => h.reverseGeocode(...(a as [])),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: async () => null,
        watchPosition: (cb: (pos: { latitude: number; longitude: number }) => void) => {
            h.gpsCallback = cb;
            return () => {
                h.gpsCallback = null;
            };
        },
    },
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (sel: (s: { user: null; authChecked: boolean }) => unknown) =>
        sel({ user: null, authChecked: false }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((sel: (s: { settings: object }) => unknown) => sel({ settings: {} }), {
        getState: () => ({ settings: { defaultLocation: '' } }),
    }),
}));
vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('@capacitor/geolocation', () => ({ Geolocation: {} }));
vi.mock('../components/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../utils', () => ({
    formatLocationInput: (s: string) => s,
    getSunTimes: () => null,
    formatCoordinate: (v: number) => String(v),
}));

import { useAppController } from '../hooks/useAppController';
import { useLiveLocationName } from '../hooks/useLiveLocationName';
import { LocationStore } from '../stores/LocationStore';

/** A minimal report shape — only what the controller's effects touch. */
const report = (locationName: string, lat: number, lon: number) => ({
    locationName,
    coordinates: { lat, lon },
    current: { condition: 'Sunny', description: '' },
});

const settle = () =>
    act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });

beforeEach(() => {
    h.weatherData = null;
    h.selectLocation.mockClear();
    h.reverseGeocode.mockReset();
    h.reverseGeocode.mockResolvedValue('Scarborough, QLD');
    // The boat owns the store, exactly as the 3s poll leaves it.
    LocationStore.setFromGPS(-27.2, 153.1, 'Scarborough, QLD');
});

describe('handleFavoriteSelect → LocationStore', () => {
    it("ocean-point favourites claim the store as 'favorite' synchronously on tap", () => {
        const { result } = renderHook(() => useAppController());

        act(() => result.current.handleFavoriteSelect('Ocean Point 26.68S 153.12E'));

        const s = LocationStore.getState();
        expect(s.source).toBe('favorite');
        expect(s.lat).toBeCloseTo(-26.68);
        expect(s.lon).toBeCloseTo(153.12);
        expect(s.name).toBe('Ocean Point 26.68S 153.12E');
        expect(h.selectLocation).toHaveBeenCalledWith('Ocean Point 26.68S 153.12E', { lat: -26.68, lon: 153.12 });
    });

    it('named favourites claim once the weather report for that name resolves', () => {
        const { result, rerender } = renderHook(() => useAppController());

        act(() => result.current.handleFavoriteSelect('Mooloolaba, QLD'));
        // No coords yet — nothing to claim with; the boat still owns the store.
        expect(LocationStore.getState().source).toBe('gps');

        // Cold-start optimistic stub: right name but (0,0) coords — must NOT claim.
        h.weatherData = report('Mooloolaba, QLD', 0, 0);
        rerender();
        expect(LocationStore.getState().source).toBe('gps');

        // Real report lands — the deferred claim completes with its coords.
        h.weatherData = report('Mooloolaba, QLD', -26.68, 153.12);
        rerender();
        const s = LocationStore.getState();
        expect(s.source).toBe('favorite');
        expect(s.lat).toBeCloseTo(-26.68);
        expect(s.lon).toBeCloseTo(153.12);
        expect(s.name).toBe('Mooloolaba, QLD');
    });

    it('a report for a different location does not complete the claim', () => {
        const { result, rerender } = renderHook(() => useAppController());

        act(() => result.current.handleFavoriteSelect('Mooloolaba, QLD'));
        // e.g. a background refresh of the boat's own weather lands first.
        h.weatherData = report('Scarborough, QLD', -27.2, 153.1);
        rerender();

        expect(LocationStore.getState().source).toBe('gps');
    });

    it('an abandoned pick cannot ambush a same-named report much later', () => {
        const { result, rerender } = renderHook(() => useAppController());

        act(() => result.current.handleFavoriteSelect('Mooloolaba, QLD'));
        const realNow = Date.now;
        const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
        try {
            h.weatherData = report('Mooloolaba, QLD', -26.68, 153.12);
            rerender();
            // Claim window expired — a same-named report must not freeze GPS tracking.
            expect(LocationStore.getState().source).toBe('gps');
        } finally {
            dateSpy.mockRestore();
        }
    });
});

describe('useLiveLocationName gate → favourite claims', () => {
    it("the 3s GPS poll no longer overwrites a 'favorite' claim", async () => {
        LocationStore.setFromFavorite(-26.68, 153.12, 'Mooloolaba, QLD');
        const { unmount } = renderHook(() => useLiveLocationName());

        // First fix fires an immediate reverse-geocode attempt — the gate
        // must reject it before it can re-stamp source:'gps'.
        act(() => h.gpsCallback?.({ latitude: -27.2, longitude: 153.1 }));
        await settle();

        expect(LocationStore.getState().source).toBe('favorite');
        expect(LocationStore.getState().name).toBe('Mooloolaba, QLD');
        unmount();
    });

    it("'search' stays soft — the boot placeholder is replaced by the first GPS fix", async () => {
        // WeatherContext stamps source:'search' from the instant cache on
        // boot; GPS is SUPPOSED to take over from it. This is the positive
        // control proving the gate change didn't over-block.
        LocationStore.setState({ lat: -27.47, lon: 153.02, name: 'Boot Placeholder', source: 'search' });
        const { unmount } = renderHook(() => useLiveLocationName());

        act(() => h.gpsCallback?.({ latitude: -27.2, longitude: 153.1 }));
        await waitFor(() => expect(LocationStore.getState().source).toBe('gps'));

        expect(LocationStore.getState().name).toBe('Scarborough, QLD');
        unmount();
    });
});
