/**
 * The sea in parts in the weather bubble (build 130, 130-04). Tap the sea on
 * Obs or Plan: three rows (wind sea, swell, swell 2), each with its own
 * height, period and an arrow for where it comes from; under them the wave
 * power, marked approximate, and a beta comfort word with one reason; MFWAM
 * credited in the footer. Where no open-water wave model reaches, the bubble
 * says so: never a number from a cell kilometres away, never "over land".
 *
 * Through the real point-weather path, the proxy answered with the trimmed
 * real replies in tests/fixtures/sea-partitions (fetched 2026-10-14).
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProxy } = vi.hoisted(() => ({ fetchProxy: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: fetchProxy }));

import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import { clearPointWeatherCache, fetchPointWeather } from '../services/weather/pointWeather';
import { SEA_CREDIT, SEA_NONE_LONG, clearSeaPartitionsCache } from '../services/weather/seaPartitions';
import type { VesselProfile } from '../types';

const fixture = (name: string) =>
    JSON.parse(fs.readFileSync(`tests/fixtures/sea-partitions/${name}-2026-10-14.json`, 'utf8')) as {
        hourly: Record<string, (number | null)[]>;
    };

const atmospheric = {
    current: {
        temperature_2m: 17,
        relative_humidity_2m: 70,
        wind_speed_10m: 33,
        wind_direction_10m: 345,
        wind_gusts_10m: 46,
        pressure_msl: 1009,
        cloud_cover: 40,
    },
};

async function tap(lat: number, lon: number, iso: string, marine: unknown) {
    vi.setSystemTime(Date.parse(iso));
    fetchProxy.mockImplementation((operation: string) =>
        Promise.resolve(operation === 'forecast' ? atmospheric : marine),
    );
    return fetchPointWeather(lat, lon);
}

const sloop: VesselProfile = {
    name: 'Fixture Sloop',
    type: 'sail',
    length: 34,
    beam: 11,
    draft: 5.5,
    displacement: 12000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchProxy.mockReset();
    clearPointWeatherCache();
    clearSeaPartitionsCache();
});
afterEach(() => {
    vi.useRealTimers();
});

/** The partition rows, each as [label, height, period, from]. */
function rows(container: HTMLElement) {
    const table = within(container).getByRole('table', { name: 'Waves in parts' });
    return within(table)
        .getAllByRole('row')
        .map((row) => {
            expect(within(row).getAllByRole('rowheader')).toHaveLength(1);
            return Array.from(row.querySelectorAll('th, td')).map((c) => c.textContent?.trim() ?? '');
        });
}

describe('the Gulf of Lion, 03:30 UTC: three rows, each its own arrow', () => {
    it('wind sea, swell and swell 2 with height, period and where each comes from', async () => {
        const data = await tap(43.0, 4.5, '2026-10-14T03:30:00Z', fixture('gulf-of-lion'));
        expect(data?.marineStatus).toBe('available');
        const { container } = render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        expect(rows(container)).toEqual([
            ['Wind sea', '0.7 m', '3 s', 'N'],
            ['Swell', '0.4 m', '4 s', 'W'],
            ['Swell 2', '0.1 m', '5 s', 'E'],
        ]);
        // One arrow per row, each turned for its own direction (from, less the chart's bearing).
        const arrows = container.querySelectorAll('table [data-sea-arrow]');
        expect(arrows).toHaveLength(3);
        expect((arrows[0] as SVGElement).style.transform).toBe('rotate(calc(532deg - var(--chart-bearing, 0deg)))');
        expect((arrows[1] as SVGElement).style.transform).toBe('rotate(calc(450deg - var(--chart-bearing, 0deg)))');
        expect(arrows[2].getAttribute('aria-label')).toBe('from E');
    });

    it('the wave power, approximate; the comfort word, beta, comfort not safety; MFWAM and NOAA credited', async () => {
        const data = await tap(43.0, 4.5, '2026-10-14T03:30:00Z', fixture('gulf-of-lion'));
        render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        // 0.49 × 0.82² × 3.6 = 1.19
        expect(screen.getByText(/≈ 1\.2 kW\/m wave power \(approx\.\)/)).toBeInTheDocument();
        const comfort = screen.getByTestId('sea-comfort');
        expect(comfort).toHaveTextContent('Lively (beta)');
        expect(comfort).toHaveTextContent('comfort, not safety');
        expect(comfort).toHaveTextContent('generic 38 ft boat');
        expect(comfort).toHaveTextContent('moderate sea for a generic 38 ft boat');
        // MFWAM 0.82 m against GFS Wave 1.3 m: models differ, and NOAA is credited beside GFS Wave's number.
        expect(screen.getByText('Wave models differ: MFWAM 0.8 m, GFS Wave (NOAA) 1.3 m')).toBeInTheDocument();
        // MFWAM's credit rides on the footer, which names Open-Meteo through it.
        const footer = screen.getByTestId('inspect-credit');
        expect(footer).toHaveTextContent(SEA_CREDIT);
        expect(footer).toHaveTextContent(/Open-Meteo/);
        expect(footer).toHaveTextContent(/fetched now/);
    });
});

describe("the user's units", () => {
    it('feet for a skipper whose seas are in feet, and her own estimated waterline', async () => {
        const data = await tap(53.5, 3.0, '2026-10-14T06:30:00Z', fixture('north-sea'));
        const { container } = render(
            <WeatherInspectPopup
                data={data}
                loading={false}
                onClose={vi.fn()}
                units={{ waveHeight: 'ft', distance: 'nm' }}
                vessel={sloop}
            />,
        );
        const r = rows(container);
        // 0.42 m, 1.26 m and 0.44 m in feet.
        expect(r.map((row) => row[1])).toEqual(['1.4 ft', '4.1 ft', '1.4 ft']);
        expect(container.textContent).not.toMatch(/\d m\b/);
        // 34 ft LOA × 0.85 = 28.9 ft of waterline, whole feet past ten.
        expect(screen.getByTestId('sea-comfort')).toHaveTextContent('est. waterline 29 ft');
        // MFWAM 1.42 m against GFS Wave 1.6 m: they agree, so no line and no NOAA credit.
        expect(screen.queryByText(/Wave models differ/)).toBeNull();
        expect(container.textContent).not.toContain('NOAA');
    });
});

describe('small parts read "none", never a false calm', () => {
    it('the Whitsundays, off Whitehaven: a 0.08 m wind sea and a 0.06 m second swell are none', async () => {
        const data = await tap(-20.3, 149.1, '2026-10-14T06:30:00Z', fixture('whitehaven'));
        const { container } = render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        expect(rows(container)).toEqual([
            ['Wind sea', 'none', '', ''],
            ['Swell', '0.1 m', '2 s', 'NE'],
            ['Swell 2', 'none', '', ''],
        ]);
        expect(container.querySelectorAll('table [data-sea-arrow]')).toHaveLength(1);
        // MFWAM 0.18 m against GFS Wave 0.52 m: they differ, said once.
        expect(screen.getByText('Wave models differ: MFWAM 0.2 m, GFS Wave (NOAA) 0.5 m')).toBeInTheDocument();
    });

    it('an unknown period: no wave power and no word, and it says so', async () => {
        const reply = fixture('gulf-of-lion');
        reply.hourly.wave_period_meteofrance_wave = reply.hourly.wave_period_meteofrance_wave.map(() => null);
        const data = await tap(43.0, 4.5, '2026-10-14T03:30:00Z', reply);
        render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        expect(screen.queryByText(/kW\/m/)).toBeNull();
        expect(screen.getByTestId('sea-comfort')).toHaveTextContent('Comfort needs a wave period');
        expect(screen.getByTestId('sea-comfort')).not.toHaveTextContent(/Comfortable|Lively|Uncomfortable|Hard going/);
    });
});

describe('while the sea is still in the air', () => {
    it('the three rows hold their place reading "--", the loading line takes the comfort line’s, and MFWAM is already credited', () => {
        const partial = {
            lat: 43,
            lon: 4.5,
            fetchedAt: Date.now(),
            marineStatus: 'pending' as const,
            windSpeedKmh: 33,
            windDirectionDeg: 345,
            windGustsKmh: 46,
            pressureMsl: 1009,
            temperatureC: 17,
            humidity: 70,
            cloudCover: 40,
            sea: null,
        };
        const { container } = render(<WeatherInspectPopup data={partial} loading={false} onClose={vi.fn()} />);
        expect(rows(container)).toEqual([
            ['Wind sea', '--', '', ''],
            ['Swell', '--', '', ''],
            ['Swell 2', '--', '', ''],
        ]);
        expect(screen.getByRole('table', { name: 'Waves in parts' })).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('status')).toHaveTextContent('Sea state loading');
        expect(screen.getByTestId('inspect-credit')).toHaveTextContent(SEA_CREDIT);
        expect(container.textContent).not.toMatch(/over land|No open-water/);
    });
});

describe('where no open-water wave model reaches', () => {
    it('Airlie Beach, answered from 17.7 km out: the sheltered sentence, no number, never "over land"', async () => {
        const data = await tap(-20.268, 148.718, '2026-10-14T06:30:00Z', fixture('airlie-beach'));
        expect(data?.marineStatus).toBe('sheltered');
        expect(data?.sea).toBeNull();
        const { container } = render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        expect(screen.getByText(SEA_NONE_LONG)).toBeInTheDocument();
        expect(container.textContent).not.toMatch(/over land/i);
        expect(screen.queryByRole('table', { name: 'Waves in parts' })).toBeNull();
        expect(container.textContent).not.toMatch(/\d(\.\d)? ?m\b/);
        // No wave number, so no wave credit.
        expect(screen.getByTestId('inspect-credit')).not.toHaveTextContent('MFWAM');
    });

    it('a cell that answered only nulls is sheltered too', async () => {
        const reply = fixture('gulf-of-lion');
        for (const key of Object.keys(reply.hourly))
            if (key !== 'time') reply.hourly[key] = reply.hourly[key].map(() => null);
        const data = await tap(43.0, 4.5, '2026-10-14T03:30:00Z', reply);
        expect(data?.marineStatus).toBe('sheltered');
        render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        expect(screen.getByText(SEA_NONE_LONG)).toBeInTheDocument();
    });
});

describe('wiring', () => {
    const hook = fs.readFileSync(path.join(process.cwd(), 'components/map/useWeatherInspectPopup.tsx'), 'utf8');

    it("the bubble is handed the skipper's vessel for the comfort word", () => {
        expect(hook).toMatch(/vessel=\{settingsRef\.current\.vessel\}/);
    });
});
