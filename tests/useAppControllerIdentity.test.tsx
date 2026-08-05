import { act, renderHook, waitFor } from '@testing-library/react';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

type BoatResult = { data: { id: string } | null; error: { message: string } | null };

const h = vi.hoisted(() => ({
    user: { id: 'controller-a' } as { id: string } | null,
    authChecked: true,
    getBoat: vi.fn<(ownerId: string) => Promise<BoatResult>>(),
    fetchWeather: vi.fn(),
    selectLocation: vi.fn(async () => undefined),
    updateSettings: vi.fn(),
    setPage: vi.fn(),
    getCurrentPosition: vi.fn(),
    getCurrentPositionIfGranted: vi.fn(),
    requestCurrentForegroundPosition: vi.fn(),
    checkLocationPermissions: vi.fn(),
    requestLocationPermissions: vi.fn(),
    getNativeCurrentPosition: vi.fn(),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: null,
        loading: false,
        fetchWeather: h.fetchWeather,
        selectLocation: h.selectLocation,
    }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            displayMode: 'light',
            defaultLocation: '',
            defaultLocationCoords: undefined,
            savedLocations: [],
        },
        updateSettings: h.updateSettings,
    }),
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({
        setPage: h.setPage,
        isOffline: false,
        currentView: 'dashboard',
    }),
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } | null; authChecked: boolean }) => unknown) =>
        selector({ user: h.user, authChecked: h.authChecked }),
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign(
        (selector: (state: { settings: object }) => unknown) => selector({ settings: {} }),
        {
            getState: () => ({ settings: { defaultLocation: '' } }),
        },
    ),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => {
            let ownerId = '';
            const builder = {
                select: () => builder,
                eq: (_column: string, value: string) => {
                    ownerId = value;
                    return builder;
                },
                limit: () => builder,
                maybeSingle: () => h.getBoat(ownerId),
            };
            return builder;
        },
    },
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: h.getCurrentPosition,
        getCurrentPositionIfGranted: h.getCurrentPositionIfGranted,
        requestCurrentForegroundPosition: h.requestCurrentForegroundPosition,
    },
}));

vi.mock('@capacitor/geolocation', () => ({
    Geolocation: {
        checkPermissions: h.checkLocationPermissions,
        requestPermissions: h.requestLocationPermissions,
        getCurrentPosition: h.getNativeCurrentPosition,
    },
}));

vi.mock('../services/weatherService', () => ({
    reverseGeocode: vi.fn(),
}));

vi.mock('../components/Toast', () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
    },
}));

vi.mock('../utils', () => ({
    formatLocationInput: (value: string) => value,
    getSunTimes: () => null,
    formatCoordinate: (value: number) => String(value),
}));

import { useAppController } from '../hooks/useAppController';

describe('useAppController account boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        h.user = { id: 'controller-a' };
        h.authChecked = true;
        h.getBoat.mockResolvedValue({ data: null, error: null });
        h.getCurrentPosition.mockResolvedValue(null);
        h.getCurrentPositionIfGranted.mockResolvedValue(null);
        h.requestCurrentForegroundPosition.mockResolvedValue(null);
        h.checkLocationPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'denied' });
        h.requestLocationPermissions.mockResolvedValue({ location: 'granted', coarseLocation: 'granted' });
        h.getNativeCurrentPosition.mockResolvedValue({
            coords: { latitude: -27.4, longitude: 153.1 },
            timestamp: Date.now(),
        });
        vi.mocked(Preferences.set).mockReset().mockResolvedValue(undefined);
        setAuthIdentityScope(null);
        setAuthIdentityScope('controller-a');
    });

    it('ignores a device-global legacy completion flag for a different account', async () => {
        localStorage.setItem('thalassa_v3_onboarded', 'true');

        const { result } = renderHook(() => useAppController());

        await waitFor(() => expect(result.current.showOnboarding).toBe(true));
        expect(h.getBoat).toHaveBeenCalledWith('controller-a');
    });

    it('synchronously hides A setup while B ownership is still loading', async () => {
        const { result } = renderHook(() => useAppController());
        await waitFor(() => expect(result.current.showOnboarding).toBe(true));

        let resolveB!: (value: BoatResult) => void;
        h.getBoat.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveB = resolve;
                }),
        );
        act(() => {
            h.user = { id: 'controller-b' };
            setAuthIdentityScope('controller-b');
        });

        expect(result.current.showOnboarding).toBe(false);

        await act(async () => {
            resolveB({ data: null, error: null });
        });
        await waitFor(() => expect(result.current.showOnboarding).toBe(true));
    });

    it('drops A boat-check completion after B becomes active', async () => {
        let resolveA!: (value: BoatResult) => void;
        h.getBoat.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveA = resolve;
                }),
        );
        const { result } = renderHook(() => useAppController());
        await waitFor(() => expect(h.getBoat).toHaveBeenCalledWith('controller-a'));
        const accountAKey = authScopedStorageKey('thalassa_v3_onboarded', getAuthIdentityScope());

        act(() => {
            h.user = { id: 'controller-b' };
            setAuthIdentityScope('controller-b');
        });
        await waitFor(() => expect(result.current.showOnboarding).toBe(true));

        await act(async () => {
            resolveA({ data: { id: 'boat-a' }, error: null });
        });

        expect(result.current.showOnboarding).toBe(true);
        expect(localStorage.getItem(accountAKey)).toBeNull();
    });

    it('never requests Location while restoring a returning account', async () => {
        h.getBoat.mockResolvedValueOnce({ data: { id: 'boat-a' }, error: null });

        renderHook(() => useAppController());

        await waitFor(() => expect(h.getBoat).toHaveBeenCalledWith('controller-a'));
        await waitFor(() =>
            expect(localStorage.getItem(authScopedStorageKey('thalassa_v3_onboarded', getAuthIdentityScope()))).toBe(
                'true',
            ),
        );
        expect(h.requestLocationPermissions).not.toHaveBeenCalled();
        expect(h.requestCurrentForegroundPosition).not.toHaveBeenCalled();
        expect(h.getCurrentPosition).not.toHaveBeenCalled();
    });

    it('keeps an onboarded boot quiet when Location is not already granted', async () => {
        localStorage.setItem(authScopedStorageKey('thalassa_v3_onboarded'), 'true');

        renderHook(() => useAppController());

        await waitFor(() => expect(h.getCurrentPositionIfGranted).toHaveBeenCalledOnce());
        expect(h.checkLocationPermissions).not.toHaveBeenCalled();
        expect(h.requestLocationPermissions).not.toHaveBeenCalled();
        expect(h.getNativeCurrentPosition).not.toHaveBeenCalled();
        expect(h.requestCurrentForegroundPosition).not.toHaveBeenCalled();
        expect(h.getCurrentPosition).not.toHaveBeenCalled();
    });

    it('uses the lightweight one-shot provider when Location was already granted', async () => {
        localStorage.setItem(authScopedStorageKey('thalassa_v3_onboarded'), 'true');
        h.getCurrentPositionIfGranted.mockResolvedValueOnce({
            latitude: -27.4,
            longitude: 153.1,
            accuracy: 8,
            altitude: null,
            heading: null,
            speed: 0,
            timestamp: Date.now(),
        });

        renderHook(() => useAppController());

        await waitFor(() =>
            expect(h.selectLocation).toHaveBeenCalledWith('Current Location', { lat: -27.4, lon: 153.1 }),
        );
        expect(h.getCurrentPositionIfGranted).toHaveBeenCalledWith({
            staleLimitMs: 60_000,
            timeoutSec: 8,
        });
        expect(h.checkLocationPermissions).not.toHaveBeenCalled();
        expect(h.getNativeCurrentPosition).not.toHaveBeenCalled();
        expect(h.requestLocationPermissions).not.toHaveBeenCalled();
        expect(h.requestCurrentForegroundPosition).not.toHaveBeenCalled();
        expect(h.getCurrentPosition).not.toHaveBeenCalled();
    });

    it('drops A lightweight GPS boot completion after B becomes active', async () => {
        localStorage.setItem(authScopedStorageKey('thalassa_v3_onboarded'), 'true');
        let resolveGps!: (value: {
            latitude: number;
            longitude: number;
            accuracy: number;
            altitude: null;
            heading: null;
            speed: number;
            timestamp: number;
        }) => void;
        h.getCurrentPositionIfGranted.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveGps = resolve;
            }),
        );
        renderHook(() => useAppController());
        await waitFor(() => expect(h.getCurrentPositionIfGranted).toHaveBeenCalledOnce());

        act(() => {
            h.user = { id: 'controller-b' };
            setAuthIdentityScope('controller-b');
        });
        await act(async () => {
            resolveGps({
                latitude: -27.4,
                longitude: 153.1,
                accuracy: 8,
                altitude: null,
                heading: null,
                speed: 0,
                timestamp: Date.now(),
            });
        });

        expect(h.selectLocation).not.toHaveBeenCalled();
    });

    it('stores map-pick diagnostics in the exact account namespace without the private location', async () => {
        const scope = getAuthIdentityScope();
        const { result } = renderHook(() => useAppController());

        await act(async () => {
            await result.current.handleMapTargetSelect(-27.4705, 153.026, 'Account A Secret Marina');
        });
        await waitFor(() => expect(Preferences.set).toHaveBeenCalled());

        for (const [write] of vi.mocked(Preferences.set).mock.calls) {
            expect(write.key).toBe(authScopedStorageKey('PICK_RESULT', scope));
            expect(write.value).not.toContain('Account A Secret Marina');
            expect(write.value).not.toContain('-27.4705');
            expect(write.value).not.toContain('153.026');
            expect(write.value).toContain('[PICK] request');
        }
    });
});
