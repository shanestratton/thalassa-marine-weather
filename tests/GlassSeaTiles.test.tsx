/**
 * The Glass's offshore sea tiles tell the truth (build 123, W1-07).
 *
 * Re-verified on b123 c10fdda5, 2026-10-08:
 *   1. SWELL 2 and PER. 2 drew their arrow from `swellDirection`, which the
 *      StormGlass transformer fills from waveDirection: the TOTAL sea's
 *      direction, beside a secondary swell's height and period. This feed
 *      gives no secondary-swell direction, so there is no arrow until real
 *      partitions arrive (W1-13).
 *   2. SWELL 2's height is stored in feet, like waveHeight, and the tile
 *      printed those feet under a hard-coded 'ft', so a metric skipper read
 *      feet. It now converts with, and labels in, the user's Seas unit.
 *
 * Fictional readings at offshore points around the world, plus one in
 * Queensland, in metres and in feet.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/dashboard/TideAndVessel', () => ({
    TideGraph: () => <div data-testid="tide-graph" />,
    SunMoonWidget: () => <div />,
    VesselWidget: () => <div />,
    VesselStatusWidget: () => <div />,
    TideWidget: () => <div />,
    MoonVisual: () => <div />,
    SolarArc: () => <div />,
    getMoonPhaseData: () => ({ phase: 'Full Moon', illumination: 100, emoji: '🌕' }),
}));
vi.mock('../components/dashboard/WeatherGrid', () => ({
    MetricsWidget: () => <div />,
    DetailedMetricsWidget: () => <div />,
    BeaufortWidget: () => <div />,
    AlertsBanner: () => <div />,
}));
vi.mock('../components/dashboard/WeatherCharts', () => ({
    HourlyWidget: () => <div />,
    DailyWidget: () => <div />,
    MapWidget: () => <div />,
}));
vi.mock('../components/dashboard/Advice', () => ({ AdviceWidget: () => <div /> }));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ nextUpdate: Date.now() + 60000, weatherData: null, loading: false }),
}));
// As in HeroSlide.test.tsx: AnchorWatchSyncService calls .catch() on
// App.addListener at module load, which the global mock does not return.
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn().mockResolvedValue(undefined),
        getInfo: vi.fn().mockResolvedValue({ name: 'Thalassa', id: 'dev.thalassa.app', build: '1', version: '1.0.0' }),
        exitApp: vi.fn(),
    },
}));

import { HeroSlide } from '../components/dashboard/HeroSlide';
import { computeCardDisplayValues } from '../components/dashboard/hero/heroSlideHelpers';
import { mapStormGlassToReport } from '../services/weather/transformers';
import type { SourcedWeatherMetrics, UnitPreferences } from '../types';
import type { StormGlassHour } from '../types/api';

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

/** secondarySwellHeight is stored in FEET (transformers scale metres by
 *  3.28084), as waveHeight is. Expected readings are that value in each unit. */
const SITES = [
    { place: 'Gulf of Lion', swell2Ft: 2.6, metres: '0.8', feet: '2.6', period: 7 },
    { place: 'North Sea, 55N 3E', swell2Ft: 4.3, metres: '1.3', feet: '4.3', period: 9 },
    { place: 'off Monterey', swell2Ft: 6.9, metres: '2.1', feet: '6.9', period: 15 },
    { place: 'Martinique, Atlantic side', swell2Ft: 3.3, metres: '1', feet: '3.3', period: 11 },
    { place: 'off Tahiti', swell2Ft: 5.2, metres: '1.6', feet: '5.2', period: 13 },
    { place: 'off the Whitsundays', swell2Ft: 1.6, metres: '0.5', feet: '1.6', period: 6 },
] as const;

function offshoreData(swell2Ft: number, period: number) {
    return {
        windSpeed: 14,
        windGust: 19,
        windDirection: 'W',
        windDegree: 270,
        waveHeight: 6.6,
        swellPeriod: 8,
        // The TOTAL sea's direction, as transformers.ts fills it. SWELL 2
        // must not borrow it.
        swellDirection: 'SW',
        secondarySwellHeight: swell2Ft,
        secondarySwellPeriod: period,
        airTemperature: 21,
        waterTemperature: 19,
        pressure: 1016,
        humidity: 70,
        uvIndex: 4,
        visibility: 20,
        condition: 'Partly Cloudy',
        description: 'Fresh westerly',
        sunrise: '06:40',
        sunset: '18:10',
        currentSpeed: 0.6,
        currentDirection: 90,
        cape: 120,
    } as unknown as SourcedWeatherMetrics;
}

function renderOffshore(units: UnitPreferences, swell2Ft: number, period: number) {
    return render(
        <HeroSlide
            data={offshoreData(swell2Ft, period)}
            index={0}
            units={units}
            settings={{} as never}
            updateSettings={vi.fn()}
            addDebugLog={undefined}
            displaySource="StormGlass"
            isVisible={true}
            locationType="offshore"
        />,
    );
}

/** The MetricGridPanel cell under a heading: [heading row, value row]. */
function cell(label: string): HTMLElement {
    const heading = screen.getAllByText(label, { exact: true })[0];
    return heading.parentElement!.parentElement as HTMLElement;
}
const valueRow = (c: HTMLElement) => c.children[1] as HTMLElement;
const readout = (c: HTMLElement) => Array.from(valueRow(c).querySelectorAll('span')).map((s) => s.textContent);
/** Arrows drawn beside the reading (the heading's icon is not counted). */
const arrowsIn = (c: HTMLElement) => valueRow(c).querySelectorAll('svg').length;

describe('Glass offshore grid: SWELL 2 and PER. 2 draw no borrowed arrow', () => {
    it.each(SITES)('$place: no total-sea arrow on SWELL 2 or PER. 2', ({ swell2Ft, period }) => {
        renderOffshore(metric, swell2Ft, period);
        expect(arrowsIn(cell('SWELL 2'))).toBe(0);
        expect(arrowsIn(cell('PER. 2'))).toBe(0);
    });

    it('keeps the other offshore tiles as they were (no arrows, same labels)', () => {
        renderOffshore(metric, 4.3, 9);
        for (const label of ['WATER', 'DRIFT', 'SET', 'CAPE', 'SWELL 2', 'PER. 2']) {
            expect(screen.getAllByText(label, { exact: true }).length).toBeGreaterThan(0);
        }
        expect(readout(cell('PER. 2'))).toEqual(['9', 's']);
    });
});

describe("Glass offshore grid: SWELL 2 height in the user's Seas unit", () => {
    it.each(SITES)('$place: metric skipper reads metres', ({ swell2Ft, period, metres }) => {
        renderOffshore(metric, swell2Ft, period);
        expect(readout(cell('SWELL 2'))).toEqual([metres, 'm']);
    });

    it.each(SITES)('$place: imperial skipper reads feet', ({ swell2Ft, period, feet }) => {
        renderOffshore(imperial, swell2Ft, period);
        expect(readout(cell('SWELL 2'))).toEqual([feet, 'ft']);
    });

    it('follows the Seas setting, not the length setting', () => {
        // Feet for tides and lengths, metres for seas: the sea tile says metres.
        renderOffshore({ ...metric, length: 'ft', waveHeight: 'm' }, 4.3, 9);
        expect(readout(cell('SWELL 2'))).toEqual(['1.3', 'm']);
    });

    it('a missing reading is a dash with the same unit, never an invented height', () => {
        render(
            <HeroSlide
                data={{ ...offshoreData(0, 0), secondarySwellHeight: null, secondarySwellPeriod: null }}
                index={0}
                units={metric}
                settings={{} as never}
                updateSettings={vi.fn()}
                addDebugLog={undefined}
                displaySource="StormGlass"
                isVisible={true}
                locationType="offshore"
            />,
        );
        expect(readout(cell('SWELL 2'))).toEqual(['--', 'm']);
        expect(readout(cell('PER. 2'))).toEqual(['--', 's']);
    });
});

describe('computeCardDisplayValues: secondary swell converts with the unit it labels', () => {
    const data = (ft: number | null) => ({ secondarySwellHeight: ft }) as unknown as SourcedWeatherMetrics;

    it.each(SITES)('$place: metres and feet', ({ swell2Ft, metres, feet }) => {
        const m = computeCardDisplayValues(data(swell2Ft), metric, 1, true);
        expect(String(m.secondarySwellHeight)).toBe(metres);
        expect(m.secondarySwellUnit).toBe('m');
        const ft = computeCardDisplayValues(data(swell2Ft), imperial, 1, true);
        expect(String(ft.secondarySwellHeight)).toBe(feet);
        expect(ft.secondarySwellUnit).toBe('ft');
    });

    it('keeps a genuine flat sea: 0 ft is 0 m, not a dash', () => {
        const flat = computeCardDisplayValues(data(0), metric, 1, true);
        expect(flat.secondarySwellHeight).toBe(0);
        expect(flat.secondarySwellUnit).toBe('m');
    });

    it('absent is a dash in either unit', () => {
        expect(computeCardDisplayValues(data(null), metric, 1, true).secondarySwellHeight).toBe('--');
        expect(computeCardDisplayValues(data(null), imperial, 1, true).secondarySwellHeight).toBe('--');
    });
});

describe('StormGlass transformer: the storage contract the Glass reads', () => {
    // Off Monterey, fictional readings, metres and degrees as StormGlass sends them.
    const hour = (iso: string): StormGlassHour =>
        ({
            time: iso,
            airTemperature: { sg: 15 },
            windSpeed: { sg: 8 },
            waveHeight: { sg: 2.4 },
            wavePeriod: { sg: 9.5 },
            waveDirection: { sg: 290 },
            // Requested, but not what swellDirection carries.
            swellDirection: { sg: 200 },
            swellPeriod: { sg: 14 },
            secondarySwellHeight: { sg: 1.2 },
            secondarySwellPeriod: { sg: 16 },
        }) as unknown as StormGlassHour;
    const now = Date.now();
    const hours = Array.from({ length: 6 }, (_, i) => hour(new Date(now + i * 3600_000).toISOString()));
    const report = mapStormGlassToReport(hours, 36.6, -122.4, 'Off Monterey');

    it('secondary swell height is stored in feet, like waveHeight', () => {
        expect(report.current.waveHeight).toBe(7.9);
        expect(report.current.secondarySwellHeight).toBe(3.9);
        expect(report.hourly[0].secondarySwellHeight).toBe(3.9);
        expect(report.current.secondarySwellPeriod).toBe(16);
    });

    it("swellDirection and swellPeriod are the TOTAL sea's (waveDirection, wavePeriod)", () => {
        expect(report.current.swellDirection).toBe('WNW');
        expect(report.current.swellPeriod).toBe(9.5);
    });
});
