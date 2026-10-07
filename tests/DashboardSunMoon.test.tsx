/**
 * The Glass header's Sun and moon chip, wired through the Dashboard (build
 * 123, W1-09 review): the chip opens the sheet only for a placed location,
 * and the sheet is for the day on screen, from that row's own date (a row is
 * not always today plus its index: a cached report opened days later, or a
 * provider that skips a day). Fictional data only.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    data: null as Record<string, unknown> | null,
    header: {} as { onOpenSunMoon?: () => void },
    hero: {} as { onDayChange?: (d: number) => void; onActiveDataChange?: (d: unknown) => void },
    sheet: null as null | { isoDate: string; isToday: boolean; lat: number; lon: number; timeZone?: string },
}));

vi.mock('../hooks/useDashboardController', () => ({
    useDashboardController: () => ({
        data: h.data,
        current: (h.data as { current?: unknown } | null)?.current,
        hourly: [],
        boatingAdvice: null,
        lockerItems: [],
        isLandlocked: false,
        isPro: true,
        isPlaying: false,
        handleAudioBroadcast: vi.fn(),
        shareReport: vi.fn(),
        staleRefresh: false,
        refreshInterval: 30 * 60_000,
        settings: { units: { speed: 'kts', temp: 'C', waveHeight: 'm', length: 'm', distance: 'nm' } },
    }),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { units: { speed: 'kts', temp: 'C', waveHeight: 'm', length: 'm', distance: 'nm' } },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: h.data, loading: false, nextUpdate: Date.now() + 60000 }),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../utils/lazyRetry', () => ({ lazyRetry: (fn: () => Promise<never>) => React.lazy(fn) }));
vi.mock('../components/dashboard/Hero', () => ({
    HeroSection: (props: typeof h.hero) => {
        h.hero = props;
        return <div data-testid="hero-section" />;
    },
}));
vi.mock('../components/dashboard/CompactHeaderRow', () => ({
    CompactHeaderRow: (props: typeof h.header) => {
        h.header = props;
        return <div data-testid="compact-header" />;
    },
}));
vi.mock('../components/dashboard/SunMoonSheet', () => ({
    SunMoonSheet: (props: NonNullable<typeof h.sheet>) => {
        h.sheet = props;
        return <div data-testid="sun-moon-sheet" />;
    },
}));
vi.mock('../components/dashboard/StatusBadges', () => ({ StatusBadges: () => <div /> }));
vi.mock('../components/dashboard/HeroHeader', () => ({ HeroHeader: () => <div /> }));
vi.mock('../components/dashboard/HeroWidgets', () => ({ HeroWidgets: () => <div /> }));
vi.mock('../components/dashboard/CurrentConditionsCard', () => ({ CurrentConditionsCard: () => <div /> }));
vi.mock('../components/dashboard/RainForecastCard', () => ({ RainForecastCard: () => <div /> }));
vi.mock('../components/WidgetRenderer', () => ({ DashboardWidgetContext: React.createContext({}) }));
vi.mock('../services/weather/api/weatherkit', () => ({
    fetchMinutelyRainWithSummary: vi.fn().mockResolvedValue(null),
}));

import { Dashboard } from '../components/Dashboard';

const props = {
    onOpenMap: vi.fn(),
    onTriggerUpgrade: vi.fn(),
    displayTitle: 'Simon’s Town',
    timeZone: 'Africa/Johannesburg',
    utcOffset: 2,
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

function report(coordinates: { lat: number; lon: number }) {
    const current = {
        windSpeed: 14,
        windGust: 20,
        airTemperature: 19,
        condition: 'Clear',
        sunrise: '05:41',
        sunset: '18:24',
        uvIndex: 4,
    };
    return {
        locationName: 'Simon’s Town',
        coordinates,
        timeZone: 'Africa/Johannesburg',
        generatedAt: new Date().toISOString(),
        alerts: [],
        current,
        forecast: [],
        hourly: [],
    };
}

/** Flush the Dashboard's requestAnimationFrame batch. */
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 10:00 on Thu 8 Oct in Simon's Town (UTC+2).
    vi.setSystemTime(new Date('2026-10-08T08:00:00Z'));
    h.header = {};
    h.hero = {};
    h.sheet = null;
});

describe('the Dashboard wires the Sun and moon chip to its sheet', () => {
    it('opens the sheet on today at the Glass point', async () => {
        h.data = report({ lat: -34.19, lon: 18.43 });
        render(<Dashboard {...props} />);
        expect(h.header.onOpenSunMoon).toBeTypeOf('function');
        await act(async () => h.header.onOpenSunMoon!());
        expect(await screen.findByTestId('sun-moon-sheet')).toBeInTheDocument();
        expect(h.sheet).toMatchObject({
            lat: -34.19,
            lon: 18.43,
            timeZone: 'Africa/Johannesburg',
            isoDate: '2026-10-08',
            isToday: true,
        });
        vi.useRealTimers();
    });

    it('offers no sheet for the 0°, 0° stub of a location still being placed', () => {
        h.data = report({ lat: 0, lon: 0 });
        render(<Dashboard {...props} />);
        expect(screen.getByTestId('compact-header')).toBeInTheDocument();
        expect(h.header.onOpenSunMoon).toBeUndefined();
        vi.useRealTimers();
    });

    it('opens on the day row’s own date, not today plus the row number', async () => {
        h.data = report({ lat: -34.19, lon: 18.43 });
        render(<Dashboard {...props} />);
        vi.useRealTimers();
        // Row 2 is Wed 14 Oct: the forecast skipped days (a report cached on passage).
        await act(async () => {
            h.hero.onDayChange!(2);
            h.hero.onActiveDataChange!({ ...report({ lat: -34.19, lon: 18.43 }).current, isoDate: '2026-10-14' });
        });
        await frame();
        await act(async () => h.header.onOpenSunMoon!());
        await screen.findByTestId('sun-moon-sheet');
        expect(h.sheet).toMatchObject({ isoDate: '2026-10-14', isToday: false });
    });
});
