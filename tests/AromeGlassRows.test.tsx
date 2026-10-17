import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ForecastDay, HourlyForecast, UnitPreferences, WeatherMetrics } from '../types';
const observed = vi.hoisted(() => new Map<number, { data: WeatherMetrics; hourly: HourlyForecast[] }>());
vi.mock('../components/dashboard/HeroSlide', () => ({
    HeroSlide: (props: { index: number; data: WeatherMetrics; hourly: HourlyForecast[] }) => {
        observed.set(props.index, { data: props.data, hourly: props.hourly });
        return null;
    },
}));
vi.mock('../context/SettingsContext', () => ({ useSettings: () => ({ settings: {}, updateSettings: vi.fn() }) }));
import { HeroSection } from '../components/dashboard/Hero';
import { aromeContext, aromeReport } from '../services/weather/aromeReport';
import { aromePointFixture, AROME_TEST_POINT as point, AROME_TEST_RUN as run } from './fixtures/arome142';
const units: UnitPreferences = { speed: 'kts', temp: 'C', length: 'm', waveHeight: 'm', distance: 'nm' };
function report() {
    const native = aromePointFixture();
    native.hourly.temperature_2m = Array(49).fill(24);
    return aromeReport(aromeContext(point, 'Fictional', 'coastal', run + 3600_000), native, point, run + 3600_000)!;
}
function show(nativeHourlyRows: boolean, forecast?: ForecastDay[]) {
    const data = report();
    render(
        <HeroSection
            current={data.current}
            forecasts={forecast ?? data.forecast}
            hourly={data.hourly}
            timeZone={data.timeZone}
            units={units}
            generatedAt={data.generatedAt}
            nativeHourlyRows={nativeHourlyRows}
        />,
    );
    return data;
}
afterEach(() => {
    cleanup();
    observed.clear();
    vi.useRealTimers();
});
describe('AROME Glass native calendar rows', () => {
    it('keeps every exact original hour accessible while complete and partial days retain distinct dates and unknown extrema', () => {
        vi.useFakeTimers({ now: new Date(run + 3600_000), toFake: ['Date'] });
        const data = show(true);
        const rows = [...observed.values()];
        expect(rows.map((row) => row.data.isoDate)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
        expect(rows.map((row) => row.hourly.length)).toEqual([13, 24, 12]);
        expect(rows.flatMap((row) => row.hourly)).toEqual(data.hourly);
        expect(rows[0].data.highTemp).toBeUndefined();
        expect(rows[1].data.highTemp).toBe(24);
        expect(rows[2].data).toMatchObject({ airTemperature: null, windSpeed: null, uvIndex: null });
        expect(rows[2].data.highTemp).toBeUndefined();
        expect(rows[2].data.lowTemp).toBeUndefined();
        expect(rows[2].hourly.at(-1)?.time).toBe('2026-10-19T00:00:00.000Z');
    });
    it('does not add hourly-only days to the unchanged global/manual path', () => {
        vi.useFakeTimers({ now: new Date(run + 3600_000), toFake: ['Date'] });
        show(false);
        expect([...observed.values()].map((row) => row.data.isoDate)).toEqual(['2026-10-17', '2026-10-18']);
    });
    it('never duplicates the complete day and removes prior local dates after midnight', () => {
        vi.useFakeTimers({ now: new Date('2026-10-18T13:00:00Z'), toFake: ['Date'] });
        show(true, []);
        expect([...observed.values()].map((row) => row.data.isoDate)).toEqual(['2026-10-19']);
        expect(observed.get(0)?.hourly).toHaveLength(12);
        expect(observed.get(0)?.data.highTemp).toBeUndefined();
    });
});
