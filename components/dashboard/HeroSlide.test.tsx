import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';

// Mock heavy sub-components to isolate HeroSlide logic
vi.mock('./tide/TideGraph', () => ({
    TideGraph: () => <div data-testid="tide-graph" />,
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

/** Each tide card is named for its own hour (and height when the tides
 *  bracket it), always ending in the action. */
const TIDE_TRIGGER = /show wind versus tide$/;

function renderTideCard(
    onAncestorKeyDown = vi.fn(),
    tides: { time: string; type: 'High' | 'Low'; height: number }[] = [
        { time: '2026-09-09T01:00:00Z', type: 'High', height: 2 },
        { time: '2026-09-09T07:00:00Z', type: 'Low', height: 0.5 },
    ],
) {
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
                tides={tides}
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

        fireEvent.click(screen.getByRole('button', { name: TIDE_TRIGGER }));
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: TIDE_TRIGGER })).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('Stream from modelled current'));
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back to tide graph' }));
        expect(screen.queryByRole('region', { name: 'Wind versus tide details' })).not.toBeInTheDocument();
        expect(screen.getByTestId('tide-graph')).toBeInTheDocument();

        // Closing restores the original keyboard-accessible graph trigger.
        fireEvent.keyDown(screen.getByRole('button', { name: TIDE_TRIGGER }), { key: 'Enter' });
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).toBeInTheDocument();
    });

    it.each(['Enter', ' '])('%s opening hands keyboard focus to details before an arrow can change the day', (key) => {
        const ancestorKeyDown = vi.fn();
        renderTideCard(ancestorKeyDown);
        const trigger = screen.getByRole('button', { name: TIDE_TRIGGER });
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
        const trigger = screen.getByRole('button', { name: TIDE_TRIGGER });
        trigger.focus();
        fireEvent.keyDown(trigger, { key: 'Enter' });
        const close = screen.getByRole('button', { name: 'Back to tide graph' });
        close.focus();
        // Keyboard-generated native clicks have detail 0. jsdom does not
        // synthesize the click from a key press, so supply that click itself.
        fireEvent.click(close, { detail: 0 });
        expect(screen.getByRole('button', { name: TIDE_TRIGGER })).toHaveFocus();
    });

    it('names the live tide card with its hour, height and direction', () => {
        const now = Date.now();
        renderTideCard(vi.fn(), [
            { time: new Date(now - 60 * 60_000).toISOString(), type: 'Low', height: 0.5 },
            { time: new Date(now + 5 * 60 * 60_000).toISOString(), type: 'High', height: 2.5 },
        ]);
        const trigger = screen.getByRole('button', { name: TIDE_TRIGGER });
        expect(trigger.getAttribute('aria-label')).toMatch(/^Now, \d+\.\d m rising — show wind versus tide$/);
    });

    it('never invents a height when the tides do not bracket the hour', () => {
        renderTideCard();
        expect(screen.getByRole('button', { name: TIDE_TRIGGER })).toHaveAttribute(
            'aria-label',
            'Now — show wind versus tide',
        );
    });

    it('says a day past the forecast horizon is beyond it, instead of a grid of dashes', () => {
        const emptyDay = {
            isoDate: '2026-10-06',
            date: '2026-10-06',
            airTemperature: null,
            highTemp: null,
            lowTemp: null,
            windSpeed: null,
            windGust: null,
            waveHeight: null,
            precipChance: null,
        } as any;
        render(
            <HeroSlide
                data={emptyDay}
                index={10}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="wx"
                isVisible={true}
                hourly={[]}
            />,
        );
        expect(screen.getByTestId('forecast-horizon')).toHaveTextContent(
            'Beyond the forecast horizon — check back tomorrow',
        );
    });

    it('keeps the normal overview for a far day that still has numbers', () => {
        render(
            <HeroSlide
                data={{ ...baseData, isoDate: '2026-10-06', date: '2026-10-06', highTemp: 27, lowTemp: 18 }}
                index={10}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="wx"
                isVisible={true}
                hourly={[]}
            />,
        );
        expect(screen.queryByTestId('forecast-horizon')).toBeNull();
    });

    it('names the pinned model and its last day on a day past its range', () => {
        // Past ICON's range the provider still sends the day's 24 hours, every
        // value null — so "has hourly frames" must not read as "has a forecast".
        const nullHours = Array.from({ length: 24 }, (_, h) => ({
            time: `2026-10-06T${String(h).padStart(2, '0')}:00:00+10:00`,
            temperature: null,
            windSpeed: null,
            windGust: null,
            waveHeight: null,
            condition: '',
        })) as any;
        render(
            <HeroSlide
                data={{ isoDate: '2026-10-06', date: '2026-10-06', highTemp: null, lowTemp: null } as any}
                index={10}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="wx"
                isVisible={true}
                hourly={nullHours}
                forecastRange={{ modelLabel: 'ICON', lastDayLabel: 'Sat 3 Oct' }}
            />,
        );
        expect(screen.getByTestId('forecast-horizon')).toHaveTextContent(
            'Beyond ICON’s range (ends Sat 3 Oct) — try another model',
        );
    });

    it('frames the day overview, captions high and low, and never reads dashes aloud', () => {
        render(
            <HeroSlide
                data={{ ...baseData, isoDate: '2026-10-06', date: '2026-10-06', highTemp: 27, lowTemp: null }}
                index={3}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="wx"
                isVisible={true}
                hourly={[]}
            />,
        );
        const card = screen.getByRole('group', { name: /^Forecast for / });
        expect(card.closest('.rounded-2xl')).not.toBeNull();
        expect(card).toHaveTextContent('High');
        expect(card).toHaveTextContent('Low');
        // The low is missing: its dashes are hidden and "no data" is spoken.
        const hiddenDashes = Array.from(card.querySelectorAll('[aria-hidden="true"]')).filter(
            (el) => el.textContent === '--',
        );
        expect(hiddenDashes.length).toBeGreaterThan(0);
        expect(card).toHaveTextContent('no data');
    });

    it('takes off-screen hours out of the reading order and names the day', () => {
        // Midday in Brisbane: near midnight 'Today' has no later hours to page
        // through, and this test failed on the clock rather than the code.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T02:00:00Z'));
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const now = Date.now();
        const hours = [1, 2, 3].map((h) => ({
            time: new Date(now + h * 60 * 60_000).toISOString(),
            temperature: 20,
            windSpeed: 10,
            windGust: 14,
            waveHeight: 1,
            condition: 'Clear',
        })) as any;
        const { container } = render(
            <HeroSlide
                data={baseData}
                index={0}
                units={baseUnits}
                settings={{} as any}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="wx"
                isVisible={true}
                locationType="inshore"
                tides={[{ time: new Date(now).toISOString(), type: 'High', height: 2 }]}
                hourly={hours}
                timeZone="Australia/Brisbane"
            />,
        );
        // Named for what it holds; the gestures are its description (UX scorecard run 10).
        const hourRegion = screen.getByRole('region', { name: 'Today, by hour' });
        expect(hourRegion).toHaveAccessibleDescription(/^Swipe left or right/);
        const slides = container.querySelectorAll('.snap-start');
        expect(slides.length).toBeGreaterThan(1);
        expect(slides[0]).not.toHaveAttribute('aria-hidden');
        for (const slide of Array.from(slides).slice(1)) {
            expect(slide).toHaveAttribute('aria-hidden', 'true');
            expect((slide as HTMLElement & { inert: boolean }).inert).toBe(true);
        }
        // Only the one on-screen tide card is a button VoiceOver can reach.
        expect(screen.getAllByRole('button', { name: TIDE_TRIGGER })).toHaveLength(1);
    });

    it('does not move focus when the graph opens through a pointer tap', () => {
        renderTideCard();
        const focusedBefore = document.activeElement;
        fireEvent.click(screen.getByRole('button', { name: TIDE_TRIGGER }), { detail: 1 });
        expect(screen.getByRole('region', { name: 'Wind versus tide details' })).not.toHaveFocus();
        expect(document.activeElement).toBe(focusedBefore);
    });
});
