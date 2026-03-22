/**
 * Dashboard — smoke tests for the main weather dashboard.
 *
 * Dashboard depends on many hooks and sub-components. We mock the heavy
 * dependencies and test that the component renders and assembles its
 * sub-components correctly.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock all heavy sub-components
vi.mock('../hooks/useDashboardController', () => ({
    useDashboardController: () => ({
        weatherData: {
            locationName: 'Brisbane',
            windSpeed: 15,
            windGust: 22,
            windDirection: 'NNW',
            windDegree: 340,
            waveHeight: 1.5,
            airTemperature: 24,
            waterTemperature: 22,
            condition: 'Partly Cloudy',
            sunrise: '06:00',
            sunset: '18:30',
            alerts: [],
            forecast: [],
            hourly: [],
            source: 'WeatherKit',
        },
        settings: {
            units: { speed: 'kts', temp: 'C', waveHeight: 'ft', length: 'ft', distance: 'nm' },
            isPro: true,
            timeDisplay: 'local',
            mapboxToken: 'pk.test',
            savedLocations: [],
        },
        updateSettings: vi.fn(),
        isRefreshing: false,
        displaySource: 'WeatherKit',
        showForecastSheet: vi.fn(),
        addDebugLog: undefined,
    }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            units: { speed: 'kts', temp: 'C', waveHeight: 'ft', length: 'ft', distance: 'nm' },
            isPro: true,
            timeDisplay: 'local',
            mapboxToken: 'pk.test',
            savedLocations: [],
        },
        updateSettings: vi.fn(),
    }),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: { locationName: 'Brisbane', alerts: [], forecast: [], hourly: [] },
        loading: false,
        nextUpdate: Date.now() + 60000,
    }),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../utils/lazyRetry', () => ({
    lazyRetry: (fn: () => Promise<any>) => React.lazy(fn),
}));

vi.mock('../components/dashboard/Hero', () => ({
    HeroSection: () => <div data-testid="hero-section">Hero</div>,
}));

vi.mock('../components/dashboard/CompactHeaderRow', () => ({
    CompactHeaderRow: () => <div data-testid="compact-header">Header</div>,
}));

vi.mock('../components/dashboard/StatusBadges', () => ({
    StatusBadges: () => <div data-testid="status-badges">Badges</div>,
}));

vi.mock('../components/dashboard/HeroHeader', () => ({
    HeroHeader: () => <div data-testid="hero-header">HeroHeader</div>,
}));

vi.mock('../components/dashboard/HeroWidgets', () => ({
    HeroWidgets: () => <div data-testid="hero-widgets">HeroWidgets</div>,
}));

vi.mock('../components/dashboard/CurrentConditionsCard', () => ({
    CurrentConditionsCard: () => <div data-testid="current-conditions">Conditions</div>,
}));

vi.mock('../components/dashboard/RainForecastCard', () => ({
    RainForecastCard: () => <div data-testid="rain-forecast">Rain</div>,
}));

vi.mock('../components/dashboard/WeatherHelpers', () => ({
    getMoonPhase: () => ({ phase: 'Full Moon', illumination: 100, emoji: '🌕' }),
}));

vi.mock('../components/WidgetRenderer', () => ({
    DashboardWidgetContext: React.createContext({}),
}));

vi.mock('../services/weather/api/weatherkit', () => ({
    fetchMinutelyRainWithSummary: vi.fn().mockResolvedValue(null),
}));

import { Dashboard } from '../components/Dashboard';

describe('Dashboard', () => {
    const defaultProps = {
        onOpenMap: vi.fn(),
        onTriggerUpgrade: vi.fn(),
        displayTitle: 'Brisbane',
        timeZone: 'Australia/Brisbane',
        utcOffset: 10,
        timeDisplaySetting: 'local' as const,
        onToggleFavorite: vi.fn(),
        favorites: [] as string[],
        isRefreshing: false,
        isNightMode: false,
        isMobileLandscape: false,
        viewMode: 'overview' as const,
        mapboxToken: 'pk.test',
        onLocationSelect: vi.fn(),
    };

    it('renders without crashing', () => {
        const { container } = render(<Dashboard {...defaultProps} />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<Dashboard {...defaultProps} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('accepts and passes through callback props without errors', () => {
        const onOpenMap = vi.fn();
        const onTriggerUpgrade = vi.fn();
        expect(() => {
            render(<Dashboard {...defaultProps} onOpenMap={onOpenMap} onTriggerUpgrade={onTriggerUpgrade} />);
        }).not.toThrow();
    });
});
