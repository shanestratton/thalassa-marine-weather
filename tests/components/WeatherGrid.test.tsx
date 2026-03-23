/**
 * WeatherGrid — smoke tests (592 LOC dashboard component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: {
            locationName: 'Test',
            windSpeed: 15,
            windGust: 22,
            windDirection: 'NE',
            waveHeight: 1.2,
            airTemperature: 22,
            condition: 'Clear',
            alerts: [],
            forecast: [],
            hourly: [],
        },
        loading: false,
    }),
}));

import { BeaufortWidget } from '../../components/dashboard/WeatherGrid';

describe('WeatherGrid', () => {
    beforeEach(() => vi.clearAllMocks());

    describe('BeaufortWidget', () => {
        it('renders without crashing', () => {
            const { container } = render(<BeaufortWidget windSpeed={15} />);
            expect(container).toBeDefined();
        });

        it('renders with null wind', () => {
            const { container } = render(<BeaufortWidget windSpeed={null} />);
            expect(container).toBeDefined();
        });

        it('renders content for valid wind', () => {
            const { container } = render(<BeaufortWidget windSpeed={25} />);
            expect(container.innerHTML.length).toBeGreaterThan(0);
        });
    });
});
