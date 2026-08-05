import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import type { PointWeatherData } from '../services/weather/pointWeather';

const point = (overrides: Partial<PointWeatherData> = {}): PointWeatherData => ({
    lat: -27.47,
    lon: 153.02,
    fetchedAt: Date.now(),
    marineStatus: 'available',
    windSpeedKmh: 18.52,
    windDirectionDeg: 90,
    windGustsKmh: 27.78,
    pressureMsl: 1012,
    temperatureC: 24,
    humidity: 70,
    cloudCover: 20,
    waveHeightM: 1.2,
    wavePeriodS: 8,
    waveDirectionDeg: 110,
    swellHeightM: 0.8,
    swellPeriodS: 10,
    swellDirectionDeg: 120,
    ...overrides,
});

describe('WeatherInspectPopup recovery and provenance', () => {
    it('shows an actionable error instead of an empty popup', () => {
        const retry = vi.fn();
        render(
            <WeatherInspectPopup
                data={null}
                loading={false}
                error="Check the internet connection and try this point again."
                onRetry={retry}
                onClose={vi.fn()}
            />,
        );

        expect(screen.getByRole('alert')).toHaveTextContent('Weather unavailable');
        fireEvent.click(screen.getByRole('button', { name: 'Retry weather' }));
        expect(retry).toHaveBeenCalledOnce();
    });

    it('identifies a partial marine-source failure while retaining atmospheric data', () => {
        render(
            <WeatherInspectPopup
                data={point({ marineStatus: 'unavailable', waveHeightM: null, swellHeightM: null })}
                loading={false}
                onClose={vi.fn()}
            />,
        );

        expect(screen.getByText(/Marine wave data could not be reached/)).toBeInTheDocument();
        expect(screen.getByText(/Open-Meteo · fetched/)).toBeInTheDocument();
    });
});
