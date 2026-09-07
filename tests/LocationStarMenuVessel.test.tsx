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
    selectLocation: vi.fn(async () => undefined),
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

    it('picking the boat moves the weather to her fix and remembers the choice', async () => {
        h.boatOrHeldFix.mockResolvedValue({ lat: -27.2, lon: 153.11, timestamp: 1, kind: 'pi', rung: 'pi' });
        render(<LocationStarMenu />);
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-vessel'));
        await waitFor(() =>
            expect(h.selectLocation).toHaveBeenCalledWith('Current Location', { lat: -27.2, lon: 153.11 }),
        );
        expect(getWeatherFollowTarget()).toBe('boat');
        expect(h.requestCurrentForegroundPosition).not.toHaveBeenCalled();
    });

    it('with no fix from her yet it says so inline, stays open, and still remembers the choice', async () => {
        render(<LocationStarMenu />);
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-vessel'));
        await waitFor(() => expect(screen.getByTestId('location-star-boat-notice')).toBeInTheDocument());
        expect(screen.getByTestId('location-star-boat-notice')).toHaveTextContent('No position from Serene Summer yet');
        expect(h.selectLocation).not.toHaveBeenCalled();
        expect(getWeatherFollowTarget()).toBe('boat');
        expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('Current Location puts the weather back on the phone', async () => {
        setWeatherFollowTarget('boat');
        render(<LocationStarMenu />);
        openMenu();
        // The tick is on the boat now.
        expect(screen.getByTestId('location-star-vessel').querySelectorAll('svg').length).toBe(2);
        fireEvent.click(screen.getByRole('menuitem', { name: /Current Location/ }));
        await waitFor(() =>
            expect(h.selectLocation).toHaveBeenCalledWith('Current Location', { lat: -27.47, lon: 153.02 }),
        );
        expect(getWeatherFollowTarget()).toBe('phone');
    });

    it('no vessel name, no row', () => {
        h.settings.vessel = { name: '' };
        render(<LocationStarMenu />);
        openMenu();
        expect(screen.queryByTestId('location-star-vessel')).toBeNull();
    });
});
