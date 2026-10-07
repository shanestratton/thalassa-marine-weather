/**
 * The Glass day cards' agreement chip must not turn day swipes into proxy
 * traffic (build 123, W1-09 review): the real HeroSlide over the real
 * ModelSpreadService, with the marine leg refused as a public lane does when
 * it starts returning 429. Swiping across four forecast days and back costs
 * one pair of ten-day requests, as it does when both legs answer.
 * Fictional numbers only.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn() }));
vi.mock('../components/dashboard/tide/TideGraph', () => ({
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

import { fetchOpenMeteoProxy } from '../services/weather/openMeteoProxy';
import { HeroSlide } from '../components/dashboard/HeroSlide';
import { useUIStore } from '../stores/uiStore';

const H = 3_600_000;
const units = { speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' } as never;
// Off Bequia, St Vincent and the Grenadines (UTC-4 all year).
const BEQUIA = { lat: 13.0, lon: -61.25 };
const T0 = Date.UTC(2026, 9, 8, 16) / 1000;

/** A fictional forecast-endpoint answer: every requested model, steady trades. */
function atmosAnswer(params: Record<string, string | number>) {
    const time = Array.from({ length: Number(params.forecast_hours) }, (_, i) => T0 + i * 3600);
    const hourly: Record<string, unknown> = { time };
    String(params.models)
        .split(',')
        .forEach((model, k) => {
            hourly[`wind_speed_10m_${model}`] = time.map(() => 15 + 0.4 * k);
            hourly[`wind_direction_10m_${model}`] = time.map(() => 80);
        });
    return { hourly };
}

const hoursOf = (isoDate: string) =>
    Array.from({ length: 24 }, (_, h) => ({
        time: new Date(Date.parse(`${isoDate}T00:00:00-04:00`) + h * H).toISOString(),
        temperature: 28,
        windSpeed: 15,
        windGust: 20,
        windDegree: 80,
        condition: 'Clear',
    })) as never;

const DAYS = ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'];

function carousel(visible: number) {
    return (
        <>
            {DAYS.map((isoDate, k) => (
                <HeroSlide
                    key={isoDate}
                    data={{ isoDate, date: isoDate, highTemp: 29, lowTemp: 25, windSpeed: 15, windGust: 20 } as never}
                    index={k + 1}
                    units={units}
                    settings={{} as never}
                    updateSettings={vi.fn()}
                    addDebugLog={undefined}
                    displaySource="wx"
                    timeZone="America/St_Vincent"
                    coordinates={BEQUIA}
                    locationType="offshore"
                    hourly={hoursOf(isoDate)}
                    isVisible={k === visible}
                    generatedAt="2026-10-08T16:00:00Z"
                />
            ))}
        </>
    );
}

beforeEach(() => {
    useUIStore.setState({ isOffline: false });
});

describe('day swipes and a failing leg', () => {
    it('cost one pair of requests across four days and back, with the marine leg refused', async () => {
        const proxy = vi.mocked(fetchOpenMeteoProxy);
        proxy.mockImplementation(((op: string, params: Record<string, string | number>) =>
            op === 'marine'
                ? Promise.reject(new Error('request failed (429)'))
                : Promise.resolve(atmosAnswer(params))) as never);
        const { rerender } = render(carousel(0));
        // The chip still shows: the wind leg answered.
        expect(await screen.findByRole('button', { name: /^Wind: models agree/ })).toBeInTheDocument();
        expect(proxy).toHaveBeenCalledTimes(2);
        // Each day keeps its chip once it has one: 2, 3, 4, then 4 again back on the first.
        for (const [visible, chips] of [
            [1, 2],
            [2, 3],
            [3, 4],
            [0, 4],
        ]) {
            rerender(carousel(visible));
            await waitFor(() =>
                expect(screen.getAllByRole('button', { name: /^Wind: models agree/ })).toHaveLength(chips),
            );
        }
        // Let any request a swipe started land before counting.
        await new Promise((r) => setTimeout(r, 0));
        expect(proxy).toHaveBeenCalledTimes(2);
    });
});
