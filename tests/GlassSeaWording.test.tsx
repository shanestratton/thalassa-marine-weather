/**
 * The Glass never calls the total sea a swell (build 123, W1-07, review fixes).
 *
 * `waveHeight`, `swellPeriod` and `swellDirection` on the report are the
 * TOTAL sea: wind sea and every swell together (transformers.ts fills them
 * from StormGlass's waveHeight, wavePeriod and waveDirection, Open-Meteo's
 * from wave_height, wave_period and wave_direction). Re-verified on b123
 * c10fdda5, 2026-10-08, the surfaces people actually see said 'Swell':
 *   - the Glass top row (HeroWidgets) labelled it SWELL offshore, read it out
 *     as 'Swell height ..., swell from the ...' and 'Period of the swell', and
 *     described it as long-period waves from distant storms;
 *   - the pinned hero metric said SWELL whenever a direction was set, which
 *     is almost always;
 *   - the day card captioned the mean period '8s swell' (now '8s', spoken as
 *     'waves 8 seconds apart', since '14s swell' already overflowed a 320 pt
 *     row in wide fonts and '14s waves' is wider still), and converted the
 *     height with the Lengths setting where every other sea reading uses Seas;
 *   - the deep-dive was titled 'Swell period'.
 * The only real swell on the Glass is SWELL 2, StormGlass's secondary swell.
 *
 * Fictional readings, offshore, coastal and inshore, around the world.
 */
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import { HeroWidgets } from '../components/dashboard/HeroWidgets';
import { getPinnedMetricDisplay } from '../components/dashboard/metricDisplayHelpers';
import { DailySummaryCard } from '../components/dashboard/hero/DailySummaryCard';
import { MetricDeepDiveModal } from '../components/dashboard/hero/MetricDeepDiveModal';
import type { UnitPreferences, WeatherMetrics } from '../types';

afterEach(() => {
    cleanup();
});

const metric: UnitPreferences = {
    speed: 'kts',
    temp: 'C',
    length: 'm',
    waveHeight: 'm',
    tideHeight: 'm',
    distance: 'nm',
    visibility: 'nm',
};
const imperial: UnitPreferences = {
    speed: 'kts',
    temp: 'F',
    length: 'ft',
    waveHeight: 'ft',
    tideHeight: 'ft',
    distance: 'nm',
    visibility: 'nm',
};

type Where = 'offshore' | 'coastal' | 'inshore';
/** waveHeight is stored in FEET app-wide (transformers scale metres by 3.28084). */
const SITES: { place: string; where: Where; ft: number; dir: string; from: string; period: number }[] = [
    { place: 'North Sea, 55N 3E', where: 'offshore', ft: 6.6, dir: 'SW', from: 'south', period: 9 },
    { place: 'off Monterey', where: 'offshore', ft: 7.9, dir: 'WNW', from: 'west', period: 10 },
    { place: 'off Tahiti', where: 'offshore', ft: 5.2, dir: 'S', from: 'south', period: 12 },
    { place: 'Gulf of Lion', where: 'offshore', ft: 8.2, dir: 'NW', from: 'north', period: 7 },
    { place: 'Martinique, Le Marin', where: 'coastal', ft: 3.0, dir: 'E', from: 'east', period: 8 },
    { place: 'Whitsundays, Airlie Beach', where: 'inshore', ft: 1.6, dir: 'SE', from: 'south', period: 5 },
];

const seaData = (ft: number, dir: string, period: number) =>
    ({
        airTemperature: 21,
        condition: 'Clouds',
        windSpeed: 14,
        windGust: 19,
        windDirection: 'W',
        waveHeight: ft,
        swellPeriod: period,
        // The TOTAL sea's direction, as transformers.ts fills it.
        swellDirection: dir,
        uvIndex: 3,
        visibility: 20,
        pressure: 1016,
        humidity: 70,
        precipitation: 0,
    }) as unknown as WeatherMetrics;

/** Every word the grid shows or speaks: text, names, hover titles, descriptions. */
function everyWord(root: HTMLElement): string {
    const attrs = Array.from(root.querySelectorAll('[aria-label], [title], [aria-description]')).flatMap((el) =>
        ['aria-label', 'title', 'aria-description'].map((a) => el.getAttribute(a) ?? ''),
    );
    return [root.textContent ?? '', ...attrs].join(' | ');
}

describe('Glass top row: the total sea is WAVE at every location type', () => {
    const renderRow = (where: Where, ft: number, dir: string, period: number, units = metric) =>
        render(
            <DndContext>
                <HeroWidgets data={seaData(ft, dir, period)} units={units} locationType={where} isLive />
            </DndContext>,
        );

    it.each(SITES)('$place ($where): labelled, spoken and described as waves', ({ where, ft, dir, from, period }) => {
        const { container } = renderRow(where, ft, dir, period);
        const headings = Array.from(container.querySelectorAll('.glass-metric-heading')).map((h) =>
            (h.textContent ?? '').trim(),
        );
        expect(headings).toContain('WAVE');
        const wave = screen.getByLabelText(/^Wave height /);
        expect(wave.getAttribute('aria-label')).toContain(`, waves from the ${from}`);
        expect(wave).toHaveAttribute('title', expect.stringMatching(/^Significant wave height/));
        expect(screen.getByLabelText(new RegExp(`^Period of the waves ${period} seconds`))).toBeInTheDocument();
        expect(everyWord(container)).not.toMatch(/swell/i);
    });

    it('reads in the Seas unit offshore, metres and feet alike', () => {
        renderRow('offshore', 6.6, 'SW', 9);
        expect(screen.getByLabelText(/^Wave height 2 metres/)).toBeInTheDocument();
        cleanup();
        renderRow('offshore', 6.6, 'SW', 9, imperial);
        expect(screen.getByLabelText(/^Wave height 6\.6 feet/)).toBeInTheDocument();
    });
});

describe('pinned hero metric: the total sea is WAVE, with or without a direction', () => {
    it.each(SITES)('$place', ({ ft, dir, period }) => {
        expect(getPinnedMetricDisplay('wave', seaData(ft, dir, period), metric)?.label).toBe('WAVE');
        expect(
            getPinnedMetricDisplay('wave', { ...seaData(ft, dir, period), swellDirection: undefined }, imperial)?.label,
        ).toBe('WAVE');
    });
});

describe('day card: the sea in the Seas unit, its mean period as waves', () => {
    const day = (ft: number, period: number) =>
        ({
            highTemp: 24,
            lowTemp: 17,
            condition: 'Partly Cloudy',
            windSpeed: 14,
            windGust: 19,
            windDegree: 250,
            waveHeight: ft,
            swellPeriod: period,
            precipChance: 20,
        }) as never;
    const waveColumn = () =>
        within(screen.getByTestId('day-metrics-row'))
            .getAllByTestId('day-metric')
            .find((m) => m.firstElementChild?.textContent === 'Wave')!;

    it('feet for lengths, metres for seas: the day card says metres, like the top row', () => {
        // North Sea, 1.3 m (4.3 ft) at 9 s.
        render(<DailySummaryCard daily={day(4.3, 9)} units={{ ...metric, length: 'ft' }} dateLabel="Thu 8 Oct" />);
        const wave = waveColumn();
        expect(within(wave).getByText('1.3')).toBeInTheDocument();
        expect(within(wave).getByText('m')).toBeInTheDocument();
        expect(within(wave).queryByText('ft')).toBeNull();
    });

    it('metres for lengths, feet for seas: the day card says feet', () => {
        // Off Monterey, 7.9 ft at 10 s.
        render(<DailySummaryCard daily={day(7.9, 10)} units={{ ...imperial, length: 'm' }} dateLabel="Thu 8 Oct" />);
        const wave = waveColumn();
        expect(within(wave).getByText('7.9')).toBeInTheDocument();
        expect(within(wave).getByText('ft')).toBeInTheDocument();
    });

    it.each(SITES)('$place: the period reads as the waves’, never a swell’s', ({ ft, period }) => {
        const { container } = render(<DailySummaryCard daily={day(ft, period)} units={metric} dateLabel="Thu 8 Oct" />);
        const wave = within(waveColumn());
        expect(wave.getByText(`${period}s`)).toHaveAttribute('aria-hidden', 'true');
        expect(wave.getByText(`waves ${period} seconds apart`)).toHaveClass('sr-only');
        expect(container.textContent).not.toMatch(/swell/i);
    });
});

describe('deep-dive: the period chart is the waves’ period', () => {
    it('is titled Wave period, never Swell period', () => {
        render(<MetricDeepDiveModal metric="period" onClose={vi.fn()} units={metric} hourly={[]} forecast={[]} />);
        expect(screen.getAllByText('Wave period').length).toBeGreaterThan(0);
        expect(screen.queryByText(/swell period/i)).toBeNull();
    });
});
