/**
 * The "Measured …" line in the map inspect popup (build 123, W1-11).
 *
 * The popup renders in its own React root, outside the settings providers, so
 * the hook hands it the user's units and the nearest-buoy answer. FICTIONAL
 * readings; the station names are real networks so the credit format is real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import type { PointWeatherData } from '../services/weather/pointWeather';
import type { NearestBuoyResult } from '../services/weather/buoys/types';

const NOW = Date.UTC(2026, 9, 7, 17, 5);

const point = (overrides: Partial<PointWeatherData> = {}): PointWeatherData => ({
    lat: 36.9,
    lon: -122.1,
    fetchedAt: NOW,
    marineStatus: 'available',
    windSpeedKmh: 18.52,
    windDirectionDeg: 300,
    windGustsKmh: 27.78,
    pressureMsl: 1014,
    temperatureC: 16,
    humidity: 70,
    cloudCover: 20,
    waveHeightM: 1.4,
    wavePeriodS: 9,
    waveDirectionDeg: 290,
    swellHeightM: null,
    swellPeriodS: null,
    swellDirectionDeg: null,
    ...overrides,
});

const found: NearestBuoyResult = {
    status: 'found',
    distanceNm: 23.2,
    obs: {
        key: 'ndbc:46042',
        network: 'ndbc',
        label: 'NDBC 46042',
        owner: 'NDBC',
        lat: 36.79,
        lon: -122.4,
        time: NOW - 40 * 60_000,
        hsM: 1.42,
        periodS: 9.1,
        fromDeg: 135,
        sstC: 14.9,
    },
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('WeatherInspectPopup — nearest wave buoy line', () => {
    it('shows the measured line with owner, distance and age', () => {
        render(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} buoy={found} />);
        expect(screen.getByText('Measured 1.4 m · 9 s from SE · NDBC 46042 · 23 NM · 40 min ago')).toBeInTheDocument();
    });

    it("uses the user's units", () => {
        render(
            <WeatherInspectPopup
                data={point()}
                loading={false}
                onClose={vi.fn()}
                buoy={found}
                units={{ waveHeight: 'ft', distance: 'km' }}
            />,
        );
        expect(screen.getByText('Measured 4.7 ft · 9 s from SE · NDBC 46042 · 43 km · 40 min ago')).toBeInTheDocument();
    });

    it('says plainly when there is none', () => {
        render(
            <WeatherInspectPopup
                data={point()}
                loading={false}
                onClose={vi.fn()}
                buoy={{ status: 'none', radiusNm: 50, unreachable: [], covered: true }}
            />,
        );
        expect(screen.getByText('No wave buoy reporting within 50 NM')).toBeInTheDocument();
    });

    it('never says "no buoy" where the app reads no buoy network at all', () => {
        render(
            <WeatherInspectPopup
                data={point()}
                loading={false}
                onClose={vi.fn()}
                buoy={{ status: 'none', radiusNm: 50, unreachable: [], covered: false }}
            />,
        );
        expect(screen.getByText('No wave buoy feed read here yet')).toBeInTheDocument();
        expect(screen.queryByText(/No wave buoy reporting/)).toBeNull();
    });

    it('shows a quiet checking line while the buoy feeds load', () => {
        render(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} buoy="checking" />);
        expect(screen.getByText(/Checking wave buoys/)).toBeInTheDocument();
    });

    it('shows nothing about buoys on land, or when the check could not run', () => {
        const { rerender } = render(
            <WeatherInspectPopup
                data={point({ marineStatus: 'land', waveHeightM: null })}
                loading={false}
                onClose={vi.fn()}
                buoy={found}
            />,
        );
        expect(screen.queryByText(/Measured/)).toBeNull();
        rerender(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} buoy={null} />);
        expect(screen.queryByText(/Measured|wave buoy/i)).toBeNull();
        // Callers that never asked (no buoy prop) get no line either.
        rerender(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} />);
        expect(screen.queryByText(/Measured|wave buoy/i)).toBeNull();
    });
});

describe('useWeatherInspectPopup — wiring', () => {
    const hook = fs.readFileSync(path.join(process.cwd(), 'components/map/useWeatherInspectPopup.tsx'), 'utf8');

    it('loads the buoy feed lazily, and only paints into the popup it was asked for', () => {
        expect(hook).toContain("import('../../services/weather/buoys/feed')");
        const at = hook.indexOf('findNearestWaveBuoy(lat, lon)');
        expect(at).toBeGreaterThan(-1);
        const after = hook.slice(at, at + 500);
        expect(after).toContain('inspectRootRef.current !== root');
        expect(after).toContain('view.buoy =');
    });

    it("hands the popup the user's units", () => {
        expect(hook).toMatch(/units=\{settingsRef\.current\.units\}/);
    });
});
