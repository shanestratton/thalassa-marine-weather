import { renderHook, waitFor } from '@testing-library/react';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

/**
 * "The planning screen crashes back to the Glass page intermittently."
 *
 * It was not a crash. useAppController's boot effect paints the dashboard when
 * there is no weather yet — a first-open concern — but its deps include
 * `authedUser`, and authStore stores Supabase's `session.user` object verbatim.
 * Supabase mints a FRESH object on every auth event, TOKEN_REFRESHED included,
 * and refreshes on a timer and on app resume. So the effect re-fired mid-session
 * with nothing about the signed-in user having changed, and if weather happened
 * to be null right then it called setPage('dashboard') — yanking the skipper off
 * the chart, mid-route-plan, with no crash and nothing in any log.
 *
 * uiStore never persists currentView (it is seeded from bootView at module
 * scope), so 'dashboard' is also where a reload lands — which is why this looked
 * like a crash rather than a navigation.
 */

type BoatResult = { data: { id: string } | null; error: { message: string } | null };

const h = vi.hoisted(() => ({
    user: { id: 'skipper' } as { id: string } | null,
    authChecked: true,
    /** The page the skipper is looking at — the chart, not the dashboard. */
    currentView: 'map',
    weatherData: null as unknown,
    loading: false,
    getBoat: vi.fn<(ownerId: string) => Promise<BoatResult>>(),
    fetchWeather: vi.fn(),
    selectLocation: vi.fn(async () => undefined),
    updateSettings: vi.fn(),
    setPage: vi.fn(),
    getCurrentPosition: vi.fn(),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: h.weatherData,
        loading: h.loading,
        fetchWeather: h.fetchWeather,
        selectLocation: h.selectLocation,
    }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            displayMode: 'light',
            // A saved home port — the condition that arms the steer.
            defaultLocation: 'Newport, QLD',
            defaultLocationCoords: { lat: -27.21, lon: 153.09 },
            savedLocations: [],
        },
        updateSettings: h.updateSettings,
    }),
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: h.setPage, isOffline: false, currentView: h.currentView }),
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } | null; authChecked: boolean }) => unknown) =>
        selector({ user: h.user, authChecked: h.authChecked }),
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign(
        (selector: (state: { settings: object }) => unknown) => selector({ settings: {} }),
        {
            getState: () => ({ settings: { defaultLocation: 'Newport, QLD' } }),
        },
    ),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => {
            let ownerId = '';
            const builder = {
                select: () => builder,
                eq: (_c: string, v: string) => {
                    ownerId = v;
                    return builder;
                },
                limit: () => builder,
                maybeSingle: () => h.getBoat(ownerId),
            };
            return builder;
        },
    },
}));

vi.mock('../services/GpsService', () => ({ GpsService: { getCurrentPosition: h.getCurrentPosition } }));
vi.mock('@capacitor/geolocation', () => ({
    Geolocation: { requestPermissions: vi.fn(), getCurrentPosition: vi.fn() },
}));
vi.mock('../services/weatherService', () => ({ reverseGeocode: vi.fn() }));
vi.mock('../components/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../utils', () => ({
    formatLocationInput: (v: string) => v,
    getSunTimes: () => null,
    formatCoordinate: (v: number) => String(v),
}));

import { useAppController } from '../hooks/useAppController';

const steeredToDashboard = () => h.setPage.mock.calls.filter(([p]) => p === 'dashboard').length;

describe('useAppController — the boot steer must not yank a working skipper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        h.user = { id: 'skipper' };
        h.authChecked = true;
        h.currentView = 'map';
        h.weatherData = null;
        h.loading = false;
        h.getBoat.mockResolvedValue({ data: null, error: null });
        h.getCurrentPosition.mockResolvedValue(null);
        vi.mocked(Preferences.set).mockReset().mockResolvedValue(undefined);
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper');
        // Onboarding already done — takes the fast path, as on a real device.
        localStorage.setItem(authScopedStorageKey('thalassa_v3_onboarded', getAuthIdentityScope()), 'true');
    });

    it('does NOT navigate to the dashboard while the skipper is on the chart', async () => {
        const { rerender } = renderHook(() => useAppController());
        await waitFor(() => expect(h.fetchWeather).toHaveBeenCalled());

        // A token refresh: same human, brand-new user object, so the effect
        // re-fires. This is the exact churn Supabase produces on a timer.
        h.user = { id: 'skipper' };
        rerender();
        await waitFor(() => expect(h.fetchWeather.mock.calls.length).toBeGreaterThan(0));

        expect(steeredToDashboard()).toBe(0);
    });

    it('still fetches the weather — the useful half of the effect is untouched', async () => {
        renderHook(() => useAppController());
        await waitFor(() => expect(h.fetchWeather).toHaveBeenCalled());
        expect(h.fetchWeather).toHaveBeenCalledWith('Newport, QLD', false, { lat: -27.21, lon: 153.09 });
    });

    it('DOES still paint the dashboard on a cold open, when that is where you are', async () => {
        h.currentView = 'dashboard';
        renderHook(() => useAppController());
        await waitFor(() => expect(h.fetchWeather).toHaveBeenCalled());
        expect(steeredToDashboard()).toBeGreaterThan(0);
    });
});
