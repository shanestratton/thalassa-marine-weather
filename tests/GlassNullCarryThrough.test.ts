/**
 * Missing marine and weather values reach the Glass as null, never as a
 * confident 0 (Shane, 2026-09-26: "1 - yes" to carrying null through so the
 * existing '--' path fires). The UX referee had measured WAVE '0 m' with a
 * red worsening arrow, PER. '0 s' and 'UV 0' on a Glass whose WIND and GUST
 * cells honestly said '--' for the same missing model.
 *
 * Two rules, pinned here for the StormGlass transformer and the two shared
 * helpers:
 *   1. absent → null / undefined / '' / '--', by field type;
 *   2. a GENUINE 0 the source reported stays 0 (transformersMarineNulls.test
 *      holds the marine half of that; this file holds precipitation and UV).
 */
import { describe, expect, it } from 'vitest';

import { getPrecipitationLabelV2 } from '../services/WeatherFormatter';
import { getCondition, mapStormGlassToReport } from '../services/weather/transformers';
import type { StormGlassHour } from '../types/api';

/** Wind only — the shape of a model that has no UV, precipitation, pressure,
 *  cloud or direction at this point. */
function bareHour(time: string): StormGlassHour {
    return {
        time,
        airTemperature: { sg: 21 },
        windSpeed: { sg: 5 },
        gust: { sg: 7 },
        humidity: { sg: 60 },
        visibility: { sg: 10 },
    } as unknown as StormGlassHour;
}

function hoursFrom(base: Date, n: number, make: (iso: string, i: number) => StormGlassHour) {
    return Array.from({ length: n }, (_, i) => make(new Date(base.getTime() + i * 3600_000).toISOString(), i));
}

const LAT = -27.21;
const LON = 153.1;

describe('StormGlass transformer — absent atmospheric fields stay absent', () => {
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(now, 48, (iso) => bareHour(iso)),
        LAT,
        LON,
        'Nowhere Bay',
    );

    it('current: UV, precipitation and pressure are null, not 0', () => {
        expect(report.current.uvIndex).toBeNull();
        expect(report.current.precipitation).toBeNull();
        expect(report.current.pressure).toBeNull();
    });

    it('current: no direction means no cardinal, no degree and no swell label', () => {
        expect(report.current.windDirection).toBe('--');
        expect(report.current.windDegree).toBeUndefined();
        expect(report.current.swellDirection).toBeUndefined();
    });

    it('current: no cloud and no precipitation means no condition word', () => {
        expect(report.current.condition).toBe('');
        expect(report.current.precipLabel).toBe('--');
    });

    it('hourly: UV, pressure and precipitation carry null; direction carries --/undefined', () => {
        const h = report.hourly[0];
        expect(h.uvIndex).toBeNull();
        expect(h.pressure).toBeNull();
        expect(h.precipitation).toBeNull();
        expect(h.windDirection).toBe('--');
        expect(h.windDegree).toBeUndefined();
    });

    it('daily: a day with no reported precipitation or pressure has neither, and UV is null', () => {
        const d = report.forecast[0];
        expect(d.precipitation).toBeUndefined();
        expect(d.pressure).toBeUndefined();
        expect(d.uvIndex).toBeNull();
        expect(d.precipLabel).toBe('--');
    });
});

describe('StormGlass transformer — a reported zero is still a zero', () => {
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(
            now,
            48,
            (iso) => ({ ...bareHour(iso), precipitation: { sg: 0 }, uvIndex: { sg: 0 } }) as StormGlassHour,
        ),
        LAT,
        LON,
        'Dry Bay',
    );

    it('keeps precipitation 0 and UV 0 when the source said so', () => {
        expect(report.current.precipitation).toBe(0);
        expect(report.current.uvIndex).toBe(0);
        expect(report.forecast[0].precipitation).toBe(0);
        expect(report.forecast[0].uvIndex).toBe(0);
        expect(report.current.precipLabel).toBe('DRY');
    });
});

describe('shared helpers', () => {
    it('getPrecipitationLabelV2 says -- for a missing value and DRY for a reported 0', () => {
        expect(getPrecipitationLabelV2(null, null)).toEqual({ label: '--', value: '--' });
        expect(getPrecipitationLabelV2(null, 0)).toEqual({ label: 'DRY', value: '0.0 mm' });
        expect(getPrecipitationLabelV2(null, 2.3).label).toBe('SHOWERS');
    });

    it('getCondition returns the empty sentinel when it has nothing to go on', () => {
        expect(getCondition(null, null, true)).toBe('');
        expect(getCondition(null, 0, true)).toBe('');
        expect(getCondition(10, null, true)).toBe('Sunny');
        expect(getCondition(10, 0, true)).toBe('Sunny');
        expect(getCondition(null, 6, true)).toBe('Rain');
    });
});
