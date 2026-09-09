import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

// Mock useWeather context
vi.mock('../../context/WeatherContext', () => ({
    useWeather: () => ({
        nextUpdate: Date.now() + 60000,
        weatherData: null,
        loading: false,
    }),
}));

// Override the global @capacitor/app mock from tests/setup.ts: Capacitor 8's
// App.addListener returns Promise<PluginListenerHandle>, and the
// AnchorWatchSyncService singleton (pulled in via HeroSlide's import chain)
// calls .catch() on it at module load. The global mock still returns a
// synchronous handle, which crashes the suite before any test runs.
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn().mockResolvedValue(undefined),
        getInfo: vi.fn().mockResolvedValue({ name: 'Thalassa', id: 'dev.thalassa.app', build: '1', version: '1.0.0' }),
        exitApp: vi.fn(),
    },
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

function renderTideCard(onAncestorKeyDown = vi.fn()) {
    return render(
        <div onKeyDown={onAncestorKeyDown}>
            <HeroSlide
                data={baseData}
                index={0}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="StormGlass"
                isVisible={true}
                locationType="inshore"
                tides={[
                    { time: '2026-09-09T01:00:00Z', type: 'High', height: 2 },
                    { time: '2026-09-09T07:00:00Z', type: 'Low', height: 0.5 },
                ]}
            />
        </div>,
    );
}

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
            />,
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
            />,
        );
        // The rendered output should contain water temperature from props
        expect(container.textContent).toContain('19');
    });

    it('keeps wind-versus-tide details open on content taps and closes only through the back control', () => {
        renderTideCard();

        fireEvent.click(screen.getByRole('button', { name: 'Show wind versus tide' }));
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Show wind versus tide' })).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('+12h'));
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back to tide graph' }));
        expect(screen.queryByRole('region', { name: 'Wind versus tide details' })).not.toBeInTheDocument();
        expect(screen.getByTestId('tide-graph')).toBeInTheDocument();

        // Closing restores the original keyboard-accessible graph trigger.
        fireEvent.keyDown(screen.getByRole('button', { name: 'Show wind versus tide' }), { key: 'Enter' });
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).toBeInTheDocument();
    });

    it.each(['Enter', ' '])('%s opening hands keyboard focus to details before an arrow can change the day', (key) => {
        const ancestorKeyDown = vi.fn();
        renderTideCard(ancestorKeyDown);
        const trigger = screen.getByRole('button', { name: 'Show wind versus tide' });
        trigger.focus();
        fireEvent.keyDown(trigger, { key });

        const details = screen.getByRole('region', { name: 'Wind versus tide details' });
        expect(details).toHaveFocus();
        ancestorKeyDown.mockClear();
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
        expect(ancestorKeyDown).not.toHaveBeenCalled();
    });

    it('restores focus to the graph after activating the back control with the keyboard', () => {
        renderTideCard();
        const trigger = screen.getByRole('button', { name: 'Show wind versus tide' });
        trigger.focus();
        fireEvent.keyDown(trigger, { key: 'Enter' });
        const close = screen.getByRole('button', { name: 'Back to tide graph' });
        close.focus();
        // Keyboard-generated native clicks have detail 0. jsdom does not
        // synthesize the click from a key press, so supply that click itself.
        fireEvent.click(close, { detail: 0 });
        expect(screen.getByRole('button', { name: 'Show wind versus tide' })).toHaveFocus();
    });

    it('does not move focus when the graph opens through a pointer tap', () => {
        renderTideCard();
        const focusedBefore = document.activeElement;
        fireEvent.click(screen.getByRole('button', { name: 'Show wind versus tide' }), { detail: 1 });
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).not.toHaveFocus();
        expect(document.activeElement).toBe(focusedBefore);
    });
});
