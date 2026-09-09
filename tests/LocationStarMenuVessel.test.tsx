import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shane 2026-09-08: "the weather should always be the punters location, BUT in
 * the saved locations, there should be one that has the vessel name as a
 * special saved location." The ★ menu gets a row named after the boat that
 * moves the weather to her and keeps it there; Current Location puts it back
 * on the phone.
 */
const h = vi.hoisted(() => ({
    settings: {
        defaultLocation: 'Current Location',
        savedLocations: [] as string[],
        savedLocationCoords: {} as Record<string, { lat: number; lon: number }>,
        homePort: undefined as string | undefined,
        vessel: { name: 'Serene Summer' } as { name?: string } | undefined,
    },
    updateSettings: vi.fn(),
    selectLocation: vi.fn<() => Promise<void>>(async () => undefined),
    weatherData: { locationName: 'Newport', coordinates: { lat: -27.2, lon: 153.1 } },
    boatOrHeldFix: vi.fn<() => Promise<unknown>>(async () => null),
    requestCurrentForegroundPosition: vi.fn(async () => ({ latitude: -27.47, longitude: 153.02, timestamp: 1 })),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: h.settings, updateSettings: h.updateSettings }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: h.weatherData, selectLocation: h.selectLocation }),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { requestCurrentForegroundPosition: h.requestCurrentForegroundPosition },
}));
vi.mock('../services/weatherPosition', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weatherPosition')>()),
    boatOrHeldFix: h.boatOrHeldFix,
}));
vi.mock('../components/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { LocationStarMenu } from '../components/LocationStarMenu';
import { getWeatherFollowTarget, setWeatherFollowTarget } from '../services/weatherPosition';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Saved locations' }));

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('skipper');
    h.settings.vessel = { name: 'Serene Summer' };
    h.settings.savedLocations = [];
    h.settings.savedLocationCoords = {};
    h.selectLocation.mockResolvedValue(undefined);
    h.boatOrHeldFix.mockResolvedValue(null);
});

describe('★ menu — the vessel as a special saved location', () => {
    it('lists the boat by name above Current Location, and the tick sits on the phone by default', () => {
        render(<LocationStarMenu />);
        openMenu();
        const rows = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
        const boat = rows.findIndex((t) => t.includes('Serene Summer'));
        const current = rows.findIndex((t) => t.includes('Current Location'));
        expect(boat).toBeGreaterThan(-1);
        expect(boat).toBeLessThan(current);
        expect(screen.getByTestId('location-star-vessel')).toHaveTextContent('Boat');
        expect(screen.getByTestId('location-star-vessel').querySelector('svg.text-emerald-400.w-4')).not.toBeNull();
        // The check mark sits on Current Location (phone), not on the boat.
        expect(screen.getByTestId('location-star-vessel').querySelectorAll('svg').length).toBe(1);
    });

    it('picking the boat registers its intent immediately without awaiting a fix in the menu', async () => {
        h.boatOrHeldFix.mockResolvedValue({ lat: -27.2, lon: 153.11, timestamp: 1, kind: 'pi', rung: 'pi' });
        render(<LocationStarMenu />);
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-vessel'));
        await waitFor(() => expect(h.selectLocation).toHaveBeenCalledWith('Current Location'));
        expect(getWeatherFollowTarget()).toBe('boat');
        expect(h.requestCurrentForegroundPosition).not.toHaveBeenCalled();
        expect(h.boatOrHeldFix).not.toHaveBeenCalled();
    });

    it('registers vessel follow even without a fix, leaving unavailable UI to the context', async () => {
        render(<LocationStarMenu />);
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-vessel'));
        expect(h.selectLocation).toHaveBeenCalledWith('Current Location');
        expect(getWeatherFollowTarget()).toBe('boat');
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('Current Location puts the weather back on the phone', async () => {
        setWeatherFollowTarget('boat');
        render(<LocationStarMenu />);
        openMenu();
        // The tick is on the boat now.
        expect(screen.getByTestId('location-star-vessel').querySelectorAll('svg').length).toBe(2);
        fireEvent.click(screen.getByRole('menuitem', { name: /Current Location/ }));
        await waitFor(() =>
            expect(h.selectLocation).toHaveBeenCalledWith('Current Location', undefined, {
                requestPhonePermission: true,
            }),
        );
        expect(getWeatherFollowTarget()).toBe('phone');
    });

    it('no vessel name, no row', () => {
        h.settings.vessel = { name: '' };
        render(<LocationStarMenu />);
        openMenu();
        expect(screen.queryByTestId('location-star-vessel')).toBeNull();
    });

    it('a second choice is delivered before the previous asynchronous lookup completes', async () => {
        let finish!: () => void;
        h.selectLocation.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        h.settings.savedLocations = ['Mackay'];
        h.settings.savedLocationCoords = { Mackay: { lat: -21.1, lon: 149.2 } };
        render(<LocationStarMenu />);
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-vessel'));
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Mackay' }));
        expect(h.selectLocation).toHaveBeenNthCalledWith(1, 'Current Location');
        expect(h.selectLocation).toHaveBeenNthCalledWith(2, 'Mackay', { lat: -21.1, lon: 149.2 });
        finish();
        await Promise.resolve();
        expect(h.selectLocation).toHaveBeenCalledTimes(2);
    });
});
