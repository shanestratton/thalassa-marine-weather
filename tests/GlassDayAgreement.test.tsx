/**
 * The Glass day card's model-agreement chip, end to end on the real
 * components (build 123, W1-09): a visible forecast day reads the SAME
 * memoised ten-day spread the comparison sheet reads (one request per 0.1°
 * cell, never a second), judges its own local day with the shared module,
 * shows nothing offline, and a tap opens the comparison on that day.
 * Fictional numbers only.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DndContext } from '@dnd-kit/core';

vi.mock('../services/weather/ModelSpreadService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weather/ModelSpreadService')>()),
    queryModelSpread: vi.fn(),
}));
// The sheet itself is ModelComparisonMatrix's own tests; here, what it is asked to open on.
vi.mock('../components/dashboard/ModelComparisonMatrix', () => ({
    ModelComparisonMatrix: (props: { initialParam?: string; initialDay?: number }) => (
        <div data-testid="matrix" data-param={props.initialParam ?? ''} data-day={props.initialDay ?? ''} />
    ),
}));
vi.mock('../components/dashboard/TideAndVessel', () => ({
    TideGraph: () => <div data-testid="tide-graph" />,
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ nextUpdate: Date.now() + 60000, weatherData: null, loading: false }),
}));
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn().mockResolvedValue(undefined),
        getInfo: vi.fn().mockResolvedValue({ name: 'Thalassa', id: 'dev.thalassa.app', build: '1', version: '1.0.0' }),
        exitApp: vi.fn(),
    },
}));

import { queryModelSpread, type ModelSpreadResult } from '../services/weather/ModelSpreadService';
import { COMPARE_MODELS } from '../services/weather/forecastModels';
import { HeroSlide } from '../components/dashboard/HeroSlide';
import { HeroWidgets } from '../components/dashboard/HeroWidgets';
import { requestModelComparison, MODEL_COMPARE_EVENT } from '../components/dashboard/hero/heroSlideHelpers';
import { useUIStore } from '../stores/uiStore';

const H = 3_600_000;
const units = { speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' } as never;
// Off Marseille; the answer starts 14:00 CEST on Thu 8 Oct.
const MARSEILLE = { lat: 43.2, lon: 5.3 };
const T0 = Date.UTC(2026, 9, 8, 12);

/** Seven models; on Sat 10 Oct GFS's strongest hour is 12 kt above the rest. */
function spread(): ModelSpreadResult {
    const times = Array.from({ length: 240 }, (_, i) => T0 + i * H);
    const sat = (t: number) =>
        t >= Date.parse('2026-10-10T00:00:00+02:00') && t < Date.parse('2026-10-11T00:00:00+02:00');
    return {
        atmos: {
            times,
            models: COMPARE_MODELS.map((m, k) => ({
                ...m,
                values: {
                    wind_speed_10m: times.map((t) => (k === 5 && sat(t) ? 26 : 14 + 0.3 * k)),
                    wind_direction_10m: times.map(() => 315),
                } as never,
            })),
        },
        marine: null,
    };
}

/** A forecast day's 24 hours on Marseille's clock. */
const hoursOf = (isoDate: string) =>
    Array.from({ length: 24 }, (_, h) => ({
        time: new Date(Date.parse(`${isoDate}T00:00:00+02:00`) + h * H).toISOString(),
        temperature: 19,
        windSpeed: 14,
        windGust: 18,
        windDegree: 315,
        condition: 'Clear',
    })) as never;

function day(isoDate: string, index: number, extra: Partial<React.ComponentProps<typeof HeroSlide>> = {}) {
    return (
        <HeroSlide
            data={{ isoDate, date: isoDate, highTemp: 21, lowTemp: 14, windSpeed: 14, windGust: 18 } as never}
            index={index}
            units={units}
            settings={{} as never}
            updateSettings={vi.fn()}
            addDebugLog={undefined}
            displaySource="wx"
            timeZone="Europe/Paris"
            coordinates={MARSEILLE}
            locationType="offshore"
            hourly={hoursOf(isoDate)}
            isVisible
            {...extra}
        />
    );
}

beforeEach(() => {
    vi.mocked(queryModelSpread).mockReset();
    vi.mocked(queryModelSpread).mockResolvedValue(spread());
    useUIStore.setState({ isOffline: false });
});
afterEach(() => {
    useUIStore.setState({ isOffline: false });
});

describe('the Glass day card reads the models’ verdict for its own day', () => {
    it('asks the shared spread for the Glass point and shows that day’s chip', async () => {
        render(day('2026-10-09', 1));
        const chip = await screen.findByRole('button', { name: 'Wind: models agree, 7 models' });
        expect(chip).toBeInTheDocument();
        expect(queryModelSpread).toHaveBeenCalledWith(MARSEILLE.lat, MARSEILLE.lon, { passive: true });
    });

    it('splits the day GFS runs 12 kt stronger, and nowhere else', async () => {
        render(day('2026-10-10', 2));
        expect(await screen.findByRole('button', { name: 'Wind: models split, 7 models' })).toBeInTheDocument();
    });

    it('holds the chip’s line, unasked, while the day is off screen', () => {
        render(day('2026-10-09', 1, { isVisible: false }));
        expect(queryModelSpread).not.toHaveBeenCalled();
        expect(screen.getByTestId('day-agreement-pending')).toHaveAttribute('aria-hidden', 'true');
    });

    it('shows no chip offline, rather than a stale one, and asks nothing', async () => {
        const { rerender } = render(day('2026-10-09', 1));
        await screen.findByRole('button', { name: /^Wind: models agree/ });
        act(() => useUIStore.setState({ isOffline: true }));
        rerender(day('2026-10-09', 1));
        expect(screen.queryByRole('button', { name: /^Wind:/ })).toBeNull();
        expect(screen.queryByTestId('day-agreement-pending')).toBeNull();
        vi.mocked(queryModelSpread).mockClear();
        render(day('2026-10-11', 3));
        expect(queryModelSpread).not.toHaveBeenCalled();
    });

    it('asks again when the Glass report refreshes, so the chip is never older than the report', async () => {
        const { rerender } = render(day('2026-10-09', 1, { generatedAt: '2026-10-08T12:00:00Z' }));
        await screen.findByRole('button', { name: /^Wind: models agree/ });
        expect(queryModelSpread).toHaveBeenCalledTimes(1);
        rerender(day('2026-10-09', 1, { generatedAt: '2026-10-08T12:30:00Z' }));
        await waitFor(() => expect(queryModelSpread).toHaveBeenCalledTimes(2));
    });

    it('shows no chip when the forecast servers never answered', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue({ atmos: null, marine: null, unreachable: ['atmos', 'marine'] });
        render(day('2026-10-09', 1));
        await waitFor(() => expect(screen.queryByTestId('day-agreement-pending')).toBeNull());
        expect(screen.queryByRole('button', { name: /^Wind:/ })).toBeNull();
    });

    it('a tap asks for the comparison on that day, on the tab that decided it', async () => {
        const seen: { dayMs: number; param: string }[] = [];
        const on = (event: Event) => seen.push((event as CustomEvent).detail);
        window.addEventListener(MODEL_COMPARE_EVENT, on);
        try {
            render(day('2026-10-10', 2));
            fireEvent.click(await screen.findByRole('button', { name: /^Wind: models split/ }));
        } finally {
            window.removeEventListener(MODEL_COMPARE_EVENT, on);
        }
        expect(seen).toHaveLength(1);
        expect(seen[0].param).toBe('wind');
        // Inside Marseille's Saturday.
        expect(seen[0].dayMs).toBeGreaterThanOrEqual(Date.parse('2026-10-10T00:00:00+02:00'));
        expect(seen[0].dayMs).toBeLessThan(Date.parse('2026-10-11T00:00:00+02:00'));
    });
});

describe('the Glass grid opens the comparison where a day card asked', () => {
    it('on that day and that tab', async () => {
        render(
            <DndContext>
                <HeroWidgets data={{ windSpeed: 14 } as never} units={units} locationType="offshore" isLive={false} />
            </DndContext>,
        );
        const dayMs = Date.parse('2026-10-10T12:00:00+02:00');
        act(() => requestModelComparison({ dayMs, param: 'dir' }));
        const matrix = await screen.findByTestId('matrix');
        expect(matrix).toHaveAttribute('data-param', 'dir');
        expect(matrix).toHaveAttribute('data-day', String(dayMs));
    });
});
