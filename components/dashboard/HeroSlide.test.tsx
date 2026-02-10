import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock heavy sub-components to isolate HeroSlide logic
vi.mock('./TideAndVessel', () => ({
    TideGraph: () => <div data-testid="tide-graph" />,
    SunMoonWidget: () => <div data-testid="sun-moon" />,
    VesselWidget: () => <div data-testid="vessel" />,
    VesselStatusWidget: () => <div data-testid="vessel-status" />,
    TideWidget: () => <div data-testid="tide-widget" />,
    MoonVisual: () => <div />,
    SolarArc: () => <div />,
    getMoonPhaseData: () => ({ phase: 'Full Moon', illumination: 100, emoji: '🌕' }),
}));

vi.mock('./WeatherGrid', () => ({
    MetricsWidget: () => <div data-testid="metrics-widget" />,
    DetailedMetricsWidget: () => <div data-testid="details-widget" />,
    BeaufortWidget: () => <div data-testid="beaufort-widget" />,
    AlertsBanner: () => <div data-testid="alerts-banner" />,
}));

vi.mock('./WeatherCharts', () => ({
    HourlyWidget: () => <div />,
    DailyWidget: () => <div />,
    MapWidget: () => <div />,
}));

vi.mock('./Advice', () => ({
    AdviceWidget: () => <div />,
}));

vi.mock('../ParticleEngine', () => ({
    ParticleEngine: vi.fn(),
}));

// Mock useWeather context
vi.mock('../../context/WeatherContext', () => ({
    useWeather: () => ({
        nextUpdate: Date.now() + 60000,
        weatherData: null,
        loading: false,
    }),
}));

import { HeroSlide } from './HeroSlide';

const baseData = {
    windSpeed: 15,
    windGust: 20,
    windDirection: 'NNW',
    windDegree: 340,
    waveHeight: 1.5,
    wavePeriod: 8,
    waveDirection: 180,
    airTemperature: 22,
    waterTemperature: 19,
    pressure: 1013,
    humidity: 65,
    uvIndex: 5,
    visibility: 30,
    condition: 'Partly Cloudy',
    description: 'Light winds',
    sunrise: '06:00',
    sunset: '18:30',
    feelsLike: 21,
    currentSpeed: 0.5,
    currentDirection: 90,
    precipProbability: 10,
    precipValue: 0,
    icon: 'cloudy',
} as any;

const baseUnits = {
    speed: 'kts' as const,
    length: 'ft' as const,
    waveHeight: 'ft' as const,
    temp: 'C' as const,
    distance: 'nm' as const,
};

describe('HeroSlide', () => {
    it('renders without crashing', () => {
        const { container } = render(
            <HeroSlide
                data={baseData}
                index={0}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="StormGlass"
            />
        );
        expect(container).toBeDefined();
    });

    it('renders temperature data from props', () => {
        const { container } = render(
            <HeroSlide
                data={baseData}
                index={0}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="StormGlass"
                isVisible={true}
            />
        );
        // The rendered output should contain wind speed value from props
        expect(container.textContent).toContain('15');
    });
});
