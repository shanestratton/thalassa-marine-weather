/**
 * The details grid names the sea it shows (build 123, W1-07).
 *
 * `waveHeight`, `swellPeriod` and `swellDirection` on the report are the
 * TOTAL sea, wind sea and every swell together (transformers.ts fills them
 * from StormGlass's waveHeight, wavePeriod and waveDirection; Open-Meteo's
 * from wave_height, wave_period and wave_direction). The grid called that
 * 'Swell' offshore and its mean period 'Peak Energy'. Total sea is 'Waves';
 * a model's period is the 'Mean period'. A wave buoy's figure is its
 * dominant (peak) period, so it says that instead (tests/BuoyPeriodKind.test.ts
 * keeps a buoy's mean period out of that field).
 *
 * NOTE: no screen mounts DetailedMetricsWidget today. Its only caller is
 * WidgetRenderer, which nothing has rendered since January 2026 (Dashboard
 * imports only its context type). These tests keep the widget honest for
 * when it returns; they are not evidence about the Glass. The Glass's own sea
 * wording is pinned in tests/GlassSeaWording.test.tsx and tests/GlassSeaTiles.test.tsx.
 *
 * Fictional readings, offshore and coastal, around the world, in metres and feet.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    current: { detailsWidgets: ['wave', 'wavePeriod', 'swell'] as string[], vessel: { type: 'sail' } },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: settings.current, updateSettings: vi.fn() }),
}));
// The sortable grid is a lazy chunk; render its items straight through.
vi.mock('../components/dashboard/DndSortableGrid', () => ({
    default: ({ items, children }: { items: string[]; children: (id: string) => React.ReactNode }) => (
        <div>
            {items.map((id) => (
                <div key={id} data-testid={`tile-${id}`}>
                    {children(id)}
                </div>
            ))}
        </div>
    ),
}));

import { DetailedMetricsWidget } from '../components/dashboard/WeatherGrid';
import type { SourcedWeatherMetrics, UnitPreferences, WeatherMetrics } from '../types';

const metric: UnitPreferences = {
    speed: 'kts',
    length: 'm',
    waveHeight: 'm',
    temp: 'C',
    distance: 'nm',
    visibility: 'nm',
};
const imperial: UnitPreferences = {
    speed: 'kts',
    length: 'ft',
    waveHeight: 'ft',
    temp: 'F',
    distance: 'nm',
    visibility: 'nm',
};

type Where = 'offshore' | 'coastal' | 'inshore';
/** waveHeight is stored in feet app-wide; expected readings in each unit. */
const SITES: { place: string; where: Where; ft: number; m: string; feet: string; dir?: string }[] = [
    { place: 'Gulf of Lion', where: 'offshore', ft: 8.2, m: '2.5', feet: '8.2', dir: 'NW' },
    { place: 'North Sea, 55N 3E', where: 'offshore', ft: 9.8, m: '3', feet: '9.8', dir: 'N' },
    { place: 'off Monterey', where: 'offshore', ft: 7.2, m: '2.2', feet: '7.2', dir: 'WNW' },
    { place: 'Martinique, Le Marin', where: 'coastal', ft: 3.0, m: '0.9', feet: '3' },
    { place: 'off Tahiti', where: 'offshore', ft: 6.6, m: '2', feet: '6.6', dir: 'S' },
    { place: 'Whitsundays, Airlie Beach', where: 'inshore', ft: 1.6, m: '0.5', feet: '1.6', dir: 'SE' },
];

function current(ft: number, dir?: string, period: number | null = 8): WeatherMetrics {
    return {
        windSpeed: 14,
        windDirection: 'W',
        waveHeight: ft,
        swellPeriod: period,
        swellDirection: dir,
        airTemperature: 20,
        description: '',
        condition: 'Clear',
        uvIndex: 3,
    };
}

const renderGrid = (data: WeatherMetrics, units: UnitPreferences, where: Where) =>
    render(<DetailedMetricsWidget current={data} units={units} locationType={where} />);

const tileText = async (id: string) => (await screen.findByTestId(`tile-${id}`)).textContent ?? '';

describe('WeatherGrid: total sea is Waves, never Swell', () => {
    it.each(SITES)('$place ($where): metres', async ({ where, ft, m, dir }) => {
        renderGrid(current(ft, dir), metric, where);
        const wave = await tileText('wave');
        expect(wave).toContain('Waves');
        expect(wave).toContain(`${m}m`);
        expect(wave).toContain(dir ? `From ${dir}` : 'Combined Sea');
    });

    it.each(SITES)('$place ($where): feet', async ({ where, ft, feet }) => {
        renderGrid(current(ft), imperial, where);
        const wave = await tileText('wave');
        expect(wave).toContain('Waves');
        expect(wave).toContain(`${feet}ft`);
    });

    it.each(SITES)('$place ($where): no tile calls the total sea a swell', async ({ where, ft, dir }) => {
        const { container } = renderGrid(current(ft, dir), metric, where);
        await screen.findByTestId('tile-swell');
        expect(container.textContent).not.toMatch(/swell/i);
    });
});

describe("WeatherGrid: a model's period is the Mean period, never Peak Energy", () => {
    it.each(SITES)('$place ($where)', async ({ where, ft, dir }) => {
        const { container } = renderGrid(current(ft, dir, 9), metric, where);
        const per = await tileText('wavePeriod');
        expect(per).toContain('Wave Per.');
        expect(per).toContain('9s');
        expect(per).toContain('Mean period');
        const swell = await tileText('swell');
        expect(swell).toContain('Wave Period');
        expect(swell).toContain(dir ? `From ${dir}` : 'Mean period');
        expect(container.textContent).not.toMatch(/peak energy/i);
    });

    it("a wave buoy's figure is its peak period, said so", async () => {
        // A coastal wave buoy off Cape Cod: NDBC's DPD, the dominant period.
        const data: SourcedWeatherMetrics = {
            ...current(4.9, undefined, 11),
            sources: {
                swellPeriod: { value: 11, source: 'buoy', sourceColor: 'emerald', sourceName: 'Fictional Buoy 44099' },
            },
        };
        const { container } = renderGrid(data, imperial, 'coastal');
        expect(await tileText('wavePeriod')).toContain('Peak period');
        expect(await tileText('swell')).toContain('Peak period');
        expect(container.textContent).not.toMatch(/mean period|peak energy/i);
    });
});
