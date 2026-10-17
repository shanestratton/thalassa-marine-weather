import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import { isWeatherLayerAvailable } from '../components/map/cmemsFeatureAvailability';
import type { WeatherLayer } from '../components/map/mapConstants';

afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
});
function openSky() {
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sky layers' }));
}
describe('atmospheric source admission at the actual layer picker', () => {
    it.each(['false', 'TRUE', '', '1'])('keeps the new fields absent for the nonliteral flag %s', (value) => {
        vi.stubEnv('VITE_ATMOSPHERE_ENABLED', value);
        render(<RadialHelmMenu activeLayers={new Set()} toggleLayer={vi.fn()} selectInGroup={vi.fn()} />);
        openSky();
        expect(screen.queryByRole('menuitemcheckbox', { name: 'GFS gusts, off' })).toBeNull();
        expect(screen.queryByRole('menuitemcheckbox', { name: 'Model visibility, off' })).toBeNull();
        expect(isWeatherLayerAvailable('gust')).toBe(false);
        expect(isWeatherLayerAvailable('visibility')).toBe(false);
        expect(screen.getByRole('menuitemcheckbox', { name: 'Pressure, off' })).toBeInTheDocument();
    });

    it('offers exactly one independently toggleable GFS gust and model visibility entry when explicitly enabled', () => {
        vi.stubEnv('VITE_ATMOSPHERE_ENABLED', 'true');
        const toggle = vi.fn();
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>(['gust'])}
                toggleLayer={toggle}
                selectInGroup={vi.fn()}
            />,
        );
        openSky();
        expect(screen.getAllByRole('menuitemcheckbox', { name: 'GFS gusts, on' })).toHaveLength(1);
        expect(screen.getAllByRole('menuitemcheckbox', { name: 'Model visibility, off' })).toHaveLength(1);
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Model visibility, off' }));
        expect(toggle).toHaveBeenCalledExactlyOnceWith('visibility');
        expect(isWeatherLayerAvailable('gust')).toBe(true);
        expect(isWeatherLayerAvailable('visibility')).toBe(true);
    });
});
