/**
 * App's resolved display mode under 'Auto with night' (131-03): Auto's light
 * and dark by sunrise and sunset, and the red Night from nautical dusk to
 * dawn at the forecast location. The old Auto never resolves to Night, and the
 * fixed modes are untouched. App feeds this one value to the night scrim and
 * to MapHub's nightMode (the relief's night palette).
 *
 * Newport, Brisbane on 7 Oct 2026: nautical dusk 18:42 (SunCalc). Sunrise and
 * sunset are pinned through the getSunTimes mock to 05:20 and 17:50.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const h = vi.hoisted(() => ({
    displayMode: 'auto-night' as string,
    weatherData: null as unknown,
    fetchWeather: vi.fn(),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: h.weatherData,
        loading: false,
        fetchWeather: h.fetchWeather,
        selectLocation: vi.fn(async () => undefined),
    }),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            displayMode: h.displayMode,
            defaultLocation: 'Newport, QLD',
            defaultLocationCoords: { lat: -27.21, lon: 153.09 },
            savedLocations: [],
        },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: vi.fn(), isOffline: false, currentView: 'map' }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: null; authChecked: boolean }) => unknown) =>
        selector({ user: null, authChecked: true }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign(
        (selector: (state: { settings: object }) => unknown) => selector({ settings: {} }),
        { getState: () => ({ settings: { defaultLocation: 'Newport, QLD' } }) },
    ),
}));
vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../services/GpsService', () => ({ GpsService: { getCurrentPosition: vi.fn(async () => null) } }));
vi.mock('@capacitor/geolocation', () => ({
    Geolocation: {
        checkPermissions: vi.fn(async () => ({ location: 'denied', coarseLocation: 'denied' })),
        requestPermissions: vi.fn(),
        getCurrentPosition: vi.fn(),
    },
}));
vi.mock('../services/weatherService', () => ({ reverseGeocode: vi.fn(async () => null) }));
vi.mock('../components/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../utils', () => ({
    formatLocationInput: (v: string) => v,
    getSunTimes: () => ({
        sunrise: new Date('2026-10-07T05:20:00+10:00'),
        sunset: new Date('2026-10-07T17:50:00+10:00'),
    }),
    formatCoordinate: (v: number) => String(v),
}));

import { useAppController } from '../hooks/useAppController';

const newport = {
    locationName: 'Newport, QLD',
    coordinates: { lat: -27.21, lon: 153.09 },
    timeZone: 'Australia/Brisbane',
    current: { condition: 'Clear' },
};

/** The mode resolves in the render itself: no effect has to run first. */
function modeAt(displayMode: string, localTime: string, weather: unknown = newport) {
    h.displayMode = displayMode;
    h.weatherData = weather;
    vi.setSystemTime(new Date(`2026-10-07T${localTime}:00+10:00`));
    const { result, unmount } = renderHook(() => useAppController());
    const mode = result.current.effectiveMode;
    unmount();
    return mode;
}

describe('the display mode App resolves', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.clearAllMocks();
        localStorage.clear();
        setAuthIdentityScope(null);
        localStorage.setItem(authScopedStorageKey('thalassa_v3_onboarded', getAuthIdentityScope()), 'true');
    });
    afterEach(() => vi.useRealTimers());

    it('Auto with night: light by day, dark after sunset, Night from nautical dusk', () => {
        expect(modeAt('auto-night', '15:00')).toBe('light');
        expect(modeAt('auto-night', '18:20')).toBe('dark');
        expect(modeAt('auto-night', '23:00')).toBe('night');
    });

    it('Auto is untouched: dark at night, never Night', () => {
        expect(modeAt('auto', '23:00')).toBe('dark');
        expect(modeAt('auto', '15:00')).toBe('light');
    });

    it('the fixed modes are untouched', () => {
        for (const mode of ['light', 'dark', 'night']) {
            expect(modeAt(mode, '23:00')).toBe(mode);
        }
    });

    it('with no forecast position yet, Auto with night works like Auto and never guesses Night', () => {
        expect(modeAt('auto-night', '23:00', null)).not.toBe('night');
        expect(modeAt('auto-night', '23:00', { ...newport, coordinates: { lat: 0, lon: 0 } })).not.toBe('night');
    });
});
