import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const menuMocks = vi.hoisted(() => ({
    updateSettings: vi.fn(),
    selectLocation: vi.fn(),
    requestCurrentForegroundPosition: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            savedLocations: [],
            savedLocationCoords: {},
            defaultLocation: 'Current Location',
            homePort: undefined,
        },
        updateSettings: menuMocks.updateSettings,
    }),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: {
            locationName: 'Brisbane',
            coordinates: { lat: -27.47, lon: 153.03 },
        },
        selectLocation: menuMocks.selectLocation,
    }),
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { requestCurrentForegroundPosition: menuMocks.requestCurrentForegroundPosition },
}));
vi.mock('../components/Toast', () => ({
    toast: { error: menuMocks.toastError },
}));

import { LocationStarMenu } from '../components/LocationStarMenu';
import { SavedLocationsPicker } from '../components/passage/SavedLocationsPicker';

describe('location popover menu accessibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        menuMocks.requestCurrentForegroundPosition.mockResolvedValue({
            latitude: -27.47,
            longitude: 153.03,
        });
    });

    it('moves focus into the dashboard locations menu and restores its trigger on Escape', () => {
        render(<LocationStarMenu />);
        const trigger = screen.getByRole('button', { name: 'Saved locations' });
        fireEvent.click(trigger);

        const menu = screen.getByRole('menu', { name: 'Saved locations' });
        const current = screen.getByRole('menuitem', { name: 'Current Location' });
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(menu).toContainElement(current);
        expect(current).toHaveFocus();

        fireEvent.keyDown(current, { key: 'Escape' });
        expect(screen.queryByRole('menu', { name: 'Saved locations' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('uses the same keyboard menu contract in the route planner picker', () => {
        render(<SavedLocationsPicker value="Brisbane (-27.47, 153.03)" onPick={vi.fn()} target="origin" />);
        const trigger = screen.getByRole('button', {
            name: 'Save or recall a saved departure location',
        });
        fireEvent.click(trigger);

        const menu = screen.getByRole('menu', { name: 'Saved origin locations' });
        const save = screen.getByRole('menuitem', { name: /Save current Brisbane/ });
        expect(menu).toContainElement(save);
        expect(save).toHaveFocus();

        fireEvent.keyDown(save, { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('hands explicit foreground intent immediately to the cancellable context selection', async () => {
        render(<LocationStarMenu />);
        fireEvent.click(screen.getByRole('button', { name: 'Saved locations' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Current Location' }));

        await waitFor(() => {
            expect(menuMocks.selectLocation).toHaveBeenCalledWith('Current Location', undefined, {
                requestPhonePermission: true,
            });
        });
        expect(menuMocks.requestCurrentForegroundPosition).not.toHaveBeenCalled();
    });

    it('delegates missing-fix handling instead of leaving the previous location selected', async () => {
        menuMocks.requestCurrentForegroundPosition.mockResolvedValueOnce(null);
        render(<LocationStarMenu />);
        fireEvent.click(screen.getByRole('button', { name: 'Saved locations' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Current Location' }));

        expect(menuMocks.selectLocation).toHaveBeenCalledWith('Current Location', undefined, {
            requestPhonePermission: true,
        });
        expect(menuMocks.toastError).not.toHaveBeenCalled();
    });
});
