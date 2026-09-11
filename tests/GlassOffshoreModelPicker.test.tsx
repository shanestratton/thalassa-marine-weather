import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { forecastModel: 'ecmwf_aifs025_single', offshoreModel: 'ecmwf' },
    updateSettings: vi.fn(),
    listPublishedModels: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (select: (state: typeof mocks) => unknown) => select(mocks),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ refreshData: vi.fn(), loading: false, backgroundUpdating: false, error: null }),
}));
vi.mock('../services/weather/wxPublished', () => ({ listPublishedModels: mocks.listPublishedModels }));
vi.mock('../components/dashboard/WeatherPositionChoiceDialog', () => ({ WeatherPositionChoiceDialog: () => null }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { StatusBadges } from '../components/dashboard/StatusBadges';

const props = {
    isLandlocked: false,
    locationName: 'Lady Musgrave Island',
    displaySource: 'stormglass',
    nextUpdate: null,
    coordinates: { lat: -23.9, lon: 152.4 },
};

describe('Glass chooses the source that serves the selected environment', () => {
    beforeEach(() => {
        mocks.settings.forecastModel = 'ecmwf_aifs025_single';
        mocks.settings.offshoreModel = 'ecmwf';
        mocks.updateSettings.mockReset();
        mocks.updateSettings.mockImplementation((patch) => Object.assign(mocks.settings, patch));
        mocks.listPublishedModels.mockResolvedValue(['ecmwf_aifs025_single', 'spitfire']);
    });

    it('offshore shows only the supported offshore sources, not the atmospheric/publisher menu', async () => {
        render(<StatusBadges {...props} locationType="offshore" />);
        await act(async () => {});
        const picker = screen.getByRole('button', { name: 'Choose forecast model' });
        expect(picker).toHaveTextContent(/^ECMWF$/);
        fireEvent.click(picker);
        const sheet = screen.getByRole('dialog', { name: 'Choose a forecast model' });
        expect(within(sheet).getByRole('heading', { name: 'Offshore forecast model' })).toBeVisible();
        for (const model of ['SG BLEND', 'ECMWF', 'GFS', 'ICON']) {
            expect(within(sheet).getByRole('button', { name: `Use the ${model} forecast model` })).toBeVisible();
        }
        for (const model of ['AIFS', 'UKMO', 'JMA', 'Spitfire', 'Auto']) {
            expect(within(sheet).queryByRole('button', { name: `Use the ${model} forecast model` })).toBeNull();
        }
        fireEvent.click(within(sheet).getByRole('button', { name: 'Use the GFS forecast model' }));
        expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ offshoreModel: 'gfs' });
        expect(mocks.settings.forecastModel).toBe('ecmwf_aifs025_single');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(picker).toHaveTextContent(/^GFS$/);
    });

    it('keeps the inshore selection independent when switching environment while the picker is open', async () => {
        const view = render(<StatusBadges {...props} locationType="coastal" />);
        await act(async () => {});
        const picker = screen.getByRole('button', { name: 'Choose forecast model' });
        expect(picker).toHaveTextContent(/^AIFS$/);
        fireEvent.click(picker);
        expect(screen.getByRole('button', { name: 'Use the AIFS forecast model' })).toBeVisible();
        view.rerender(<StatusBadges {...props} locationType="coastal" isOffshore />);
        expect(screen.queryByRole('button', { name: 'Use the AIFS forecast model' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Use the ECMWF forecast model' })).toHaveAttribute(
            'aria-current',
            'true',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Use the ICON forecast model' }));
        expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ offshoreModel: 'icon' });
        view.rerender(<StatusBadges {...props} locationType="coastal" />);
        expect(picker).toHaveTextContent(/^AIFS$/);
    });

    it('inshore still updates only the atmospheric model', async () => {
        mocks.listPublishedModels.mockResolvedValue([]);
        render(<StatusBadges {...props} locationType="inshore" />);
        await act(async () => {});
        fireEvent.click(screen.getByRole('button', { name: 'Choose forecast model' }));
        fireEvent.click(screen.getByRole('button', { name: 'Use the UKMO forecast model' }));
        expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
            forecastModel: 'ukmo_global_deterministic_10km',
        });
        expect(mocks.settings.offshoreModel).toBe('ecmwf');
    });
});
