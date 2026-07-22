/**
 * mapStormGlassToReport — absence must survive as absence.
 *
 * The bug this pins (audit 2026-07-22, confirmed): marine fields ran through
 * `?? 0` before their unit multiply, so "StormGlass has no coverage at this
 * point" became a confident 0.0 — flat seas and slack water on the go/no-go
 * screen. types/weather.ts:172-176 had always specified the opposite: null
 * "is distinct from 0 which means 'calm seas'. UIs should render '—' for
 * null, never coerce to 0." The hero card was already written that way
 * (heroSlideHelpers.ts:102-106, :150-155 both emit '--' for null); only the
 * transformer disagreed, so the UI faithfully printed a number nobody had
 * measured.
 *
 * The second-order effect was worse than the display. services/weather/
 * index.ts:425 merges StormGlass over the base report behind `if
 * (sg.waveHeight != null)`. A fabricated 0 is not null, so that guard always
 * passed: real WeatherKit wave data was OVERWRITTEN with zero and then
 * labelled `sources['waveHeight'] = stormglass`. The invented reading was
 * attributed to a named provider. That is the case the last test here holds
 * shut, and it is why this matters beyond cosmetics.
 */
import { describe, expect, it } from 'vitest';

import { mapStormGlassToReport } from '../services/weather/transformers';
import type { StormGlassHour } from '../types/api';

/** An hour with the atmospheric fields present and the marine ones absent —
 *  exactly what StormGlass returns for a point outside its wave coverage. */
function hourWithoutMarine(time: string): StormGlassHour {
    return {
        time,
        airTemperature: { sg: 21 },
        windSpeed: { sg: 5 },
        gust: { sg: 7 },
        windDirection: { sg: 90 },
        pressure: { sg: 1015 },
        cloudCover: { sg: 40 },
        humidity: { sg: 60 },
        precipitation: { sg: 0 },
        visibility: { sg: 10 },
        // waveHeight / wavePeriod / currentSpeed deliberately absent
    } as unknown as StormGlassHour;
}

function hourWithMarine(time: string, waveM: number, currentMs: number): StormGlassHour {
    return {
        ...hourWithoutMarine(time),
        waveHeight: { sg: waveM },
        wavePeriod: { sg: 8 },
        currentSpeed: { sg: currentMs },
    } as unknown as StormGlassHour;
}

/** 24 consecutive hours starting now, so day-grouping has a full day. */
function hoursFrom(base: Date, n: number, make: (iso: string, i: number) => StormGlassHour) {
    return Array.from({ length: n }, (_, i) => make(new Date(base.getTime() + i * 3600_000).toISOString(), i));
}

const LAT = -27.21;
const LON = 153.1;

describe('no marine coverage → null, never 0', () => {
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(now, 24, (iso) => hourWithoutMarine(iso)),
        LAT,
        LON,
        'Nowhere Bay',
    );

    it('current waveHeight is null, not a fabricated flat sea', () => {
        expect(report.current.waveHeight).toBeNull();
        expect(report.current.waveHeight).not.toBe(0);
    });

    it('current currentSpeed is null, not fabricated slack water', () => {
        expect(report.current.currentSpeed ?? null).toBeNull();
        expect(report.current.currentSpeed).not.toBe(0);
    });

    it('current swellPeriod is null rather than a 0-second swell', () => {
        expect(report.current.swellPeriod ?? null).toBeNull();
    });

    it('hourly entries carry null through too', () => {
        expect(report.hourly.length).toBeGreaterThan(0);
        for (const h of report.hourly.slice(0, 6)) {
            expect(h.waveHeight).toBeNull();
            expect(h.currentSpeed ?? null).toBeNull();
        }
    });

    it('a day where NO hour had a reading reports null, not a calm day', () => {
        // The daily rollup seeded maxWave/maxCurrentSpeed at 0 and emitted that
        // untouched — the aggregate invented calm even with zero inputs.
        expect(report.forecast.length).toBeGreaterThan(0);
        expect(report.forecast[0].waveHeight).toBeNull();
        expect(report.forecast[0].currentSpeed ?? null).toBeNull();
    });
});

describe('real readings still arrive, converted', () => {
    const now = new Date();
    // 1.0 m wave, 1.0 m/s current — round numbers so the conversion is legible.
    const report = mapStormGlassToReport(
        hoursFrom(now, 24, (iso) => hourWithMarine(iso, 1.0, 1.0)),
        LAT,
        LON,
        'Somewhere Bay',
    );

    it('wave height converts metres → feet', () => {
        expect(report.current.waveHeight).toBeCloseTo(3.3, 1);
    });

    it('current speed converts m/s → knots', () => {
        expect(report.current.currentSpeed!).toBeCloseTo(1.9, 1);
    });

    it('daily maximum is a real maximum, not the seed', () => {
        expect(report.forecast[0].waveHeight).toBeCloseTo(3.3, 1);
    });
});

describe('a genuine ZERO is preserved as zero', () => {
    // The whole point of the distinction: 0 must still mean measured-calm, so
    // the fix must not overshoot and turn real calm into "no data".
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(now, 24, (iso) => hourWithMarine(iso, 0, 0)),
        LAT,
        LON,
        'Millpond',
    );

    it('a measured 0 m sea stays 0, not null', () => {
        expect(report.current.waveHeight).toBe(0);
        expect(report.current.waveHeight).not.toBeNull();
    });

    it('a measured 0 kt current stays 0, not null', () => {
        expect(report.current.currentSpeed).toBe(0);
    });
});

describe('the merge guard that the fabricated 0 defeated', () => {
    it('absent marine data does not pass a `!= null` merge guard', () => {
        // services/weather/index.ts:425 is `if (sg.waveHeight != null)`. Under
        // the old `?? 0` that test always passed, so StormGlass overwrote real
        // WeatherKit wave data with zero and stamped itself as the source.
        // This asserts the exact predicate that merge uses.
        const now = new Date();
        const report = mapStormGlassToReport(
            hoursFrom(now, 24, (iso) => hourWithoutMarine(iso)),
            LAT,
            LON,
            'Nowhere Bay',
        );
        expect(report.current.waveHeight != null).toBe(false);
        expect(report.current.currentSpeed != null).toBe(false);
    });
});
