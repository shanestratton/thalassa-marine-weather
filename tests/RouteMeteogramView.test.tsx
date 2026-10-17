import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ load: vi.fn(), polar: vi.fn() }));
vi.mock('../services/routeMeteogramWeather', () => ({ loadRouteMeteogram: h.load }));
vi.mock('../services/routingPolar', () => ({ resolveRoutingPolar: h.polar }));
import RouteMeteogram, { RouteWeatherView } from '../components/weather/RouteMeteogram';
import { useSettingsStore } from '../stores/settingsStore';
import { WindStore } from '../stores/WindStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    routeWeatherFixture,
    routeWeatherFixturePins as pins,
    routeWeatherFixtureStart as departureMs,
    routeWeatherFixturePolar,
    routeWeatherFixtureVessel,
} from './fixtures/routeWeatherFixture';

beforeEach(() => {
    vi.clearAllMocks();
    WindStore.reset();
    setAuthIdentityScope(null);
    useSettingsStore.setState({
        settings: {
            ...useSettingsStore.getState().settings,
            satelliteMode: false,
            vessel: routeWeatherFixtureVessel,
            polarSource: 'factory',
            polarSource_type: 'manual',
        },
    });
    h.load.mockResolvedValue(routeWeatherFixture('route-a'));
    h.polar.mockResolvedValue(routeWeatherFixturePolar);
});
const props = () => ({ pins, departureMs, cruisingSpeedKts: 6, identity: 'route-a', onReport: vi.fn() });

describe('explicit route weather controls and stale result fencing', () => {
    it('opening the UI makes no weather or polar request', () => {
        render(<RouteMeteogram {...props()} />);
        expect(h.load).not.toHaveBeenCalled();
        expect(h.polar).not.toHaveBeenCalled();
    });
    it('a missing planned speed never assumes a cruising speed', async () => {
        render(<RouteMeteogram {...props()} cruisingSpeedKts={undefined} />);
        expect(screen.getByRole('spinbutton')).toHaveValue(null);
        fireEvent.click(screen.getByRole('button', { name: 'Use weather aboard' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Set a valid planned speed');
        expect(h.load).not.toHaveBeenCalled();
    });
    it('uses the chosen routing polar and clears rows immediately when planned speed changes', async () => {
        const input = props();
        render(<RouteMeteogram {...input} />);
        fireEvent.click(screen.getByRole('button', { name: 'Use weather aboard' }));
        await screen.findByTestId('route-meteogram');
        expect(h.polar).toHaveBeenCalledWith(expect.objectContaining({ vessel: routeWeatherFixtureVessel }));
        expect(h.load.mock.calls[0][0].performance.polar).toBe(routeWeatherFixturePolar);
        expect(h.load.mock.calls[0][0].downloadModel).toBeUndefined();
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '8' } });
        expect(screen.queryByTestId('route-meteogram')).toBeNull();
        expect(input.onReport).toHaveBeenLastCalledWith(null);
    });
    it.each(['geometry', 'cancel', 'account'])('cannot publish a stale request after %s changes', async (change) => {
        let finish!: (report: ReturnType<typeof routeWeatherFixture>) => void;
        h.load.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const input = props(),
            view = render(<RouteMeteogram {...input} />);
        fireEvent.click(screen.getByRole('button', { name: 'Use weather aboard' }));
        await waitFor(() => expect(h.load).toHaveBeenCalledOnce());
        const old = routeWeatherFixture('route-a');
        if (change === 'geometry')
            view.rerender(<RouteMeteogram {...input} identity="route-b" pins={pins.slice(0, 2)} />);
        if (change === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel route weather' }));
        if (change === 'account')
            act(() => {
                setAuthIdentityScope('other-fixture-account');
            });
        await act(async () => {
            finish(old);
        });
        expect(screen.queryByTestId('route-meteogram')).toBeNull();
        expect(input.onReport).not.toHaveBeenCalledWith(old);
        expect(h.load.mock.calls[0][1].signal.aborted).toBe(true);
    });
    it('Satellite Mode keeps aboard sampling available and disables the bulk download', () => {
        useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, satelliteMode: true } });
        render(<RouteMeteogram {...props()} />);
        expect(screen.getByRole('button', { name: 'Download selected forecast' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Use weather aboard' })).toBeEnabled();
        expect(screen.getByText(/Satellite Mode:/)).toBeInTheDocument();
    });
    it('shows the same exact endpoint and UTC in the selected row and hourly table, preserving unknowns', () => {
        const report = routeWeatherFixture();
        render(<RouteWeatherView report={report} />);
        fireEvent.change(screen.getByRole('slider', { name: 'Route weather hour' }), {
            target: { value: String(report.rows.length - 1) },
        });
        expect(screen.getByText(/0.0000°, 4.0000°/)).toBeInTheDocument();
        fireEvent.click(screen.getByText(/Hourly weather table/));
        expect(screen.getByRole('table', { name: 'Route weather in UTC' })).toHaveTextContent('Unknown');
        expect(screen.getByText(/Polar speed is a sailing model/)).toBeInTheDocument();
        expect(screen.getByTestId('route-weather-credit')).toHaveTextContent('CC BY-SA 4.0');
    });
});
