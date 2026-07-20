import { describe, it, expect } from 'vitest';
import { spitfireLocationFor, isSpitfireAvailableAt, applySpitfireToReport, type SpitfireLocation } from './spitfire';
import type { MarineWeatherReport } from '../../types';

const NEWPORT = { lat: -27.2, lon: 153.1 };

describe('spitfire availability', () => {
    it('covers Newport', () => {
        expect(spitfireLocationFor(NEWPORT.lat, NEWPORT.lon)?.slug).toBe('newport');
        expect(isSpitfireAvailableAt(NEWPORT.lat, NEWPORT.lon)).toBe(true);
    });

    it('covers a boat a few km off Newport', () => {
        expect(isSpitfireAvailableAt(-27.25, 153.15)).toBe(true);
    });

    it('does NOT cover Townsville — the blend says nothing about it', () => {
        expect(spitfireLocationFor(-19.26, 146.82)).toBeNull();
        expect(isSpitfireAvailableAt(-19.26, 146.82)).toBe(false);
    });

    it('does not cover Brisbane city, ~30 km away, despite being close-ish', () => {
        expect(isSpitfireAvailableAt(-27.47, 153.02)).toBe(false);
    });

    it('is unavailable when position is unknown', () => {
        expect(isSpitfireAvailableAt(null, null)).toBe(false);
    });
});

function makeReport(over: Record<string, unknown> = {}): MarineWeatherReport {
    return {
        locationName: 'Newport, QLD',
        coordinates: NEWPORT,
        generatedAt: '2026-07-21T00:00:00.000Z',
        current: { windSpeed: 99, windGust: 99, uvIndex: null, visibility: null, windDirection: 'N' },
        hourly: [],
        forecast: [],
        tides: [{ time: 'x', type: 'High', height: 1.6 }],
        tideHourly: [],
        modelUsed: 'wk+sg',
        boatingAdvice: '',
        alerts: [],
        ...over,
    } as unknown as MarineWeatherReport;
}

function makeSpitfire(consensusOver: Record<string, unknown> = {}): SpitfireLocation {
    return {
        slug: 'newport',
        name: 'Newport QLD',
        lat: NEWPORT.lat,
        lon: NEWPORT.lon,
        tz: 'Australia/Brisbane',
        generatedAt: '2026-07-21T00:10:00Z',
        consensus: {
            label: 'SPITFIRE',
            cadence: 'weighted blend of 5 models',
            current: {
                temperature_2m: 17.7,
                wind_speed_10m: 9.8,
                wind_gusts_10m: 17.5,
                wind_direction_10m: 164,
                pressure_msl: 1027.7,
                relative_humidity_2m: 76.3,
                cloud_cover: 70.3,
                precipitation: 0,
                feels_like: 15.3,
                dew_point: 13.5,
                wind_speed_10m_min: 6.1,
                wind_speed_10m_max: 16.9,
            },
            hourly: {},
            daily: {},
            weights: { dwd_icon: 0.244, jma_gsm: 0.18 },
            weights_status: 'live',
            weights_scope: 'nowcast wind at Newport only',
            mae_kt: { dwd_icon: 2.77, jma_gsm: 8.02 },
            member_labels: { dwd_icon: 'DWD ICON', jma_gsm: 'JMA GSM' },
            // Overrides apply to the consensus block, which is the only part
            // these tests vary. Spreading them at the top level instead would
            // silently replace the whole consensus and drop `current`.
            ...consensusOver,
        },
    } as SpitfireLocation;
}

describe('applySpitfireToReport', () => {
    it('overlays the consensus atmospherics, in knots, without conversion', () => {
        const report = makeReport();
        applySpitfireToReport(report, makeSpitfire());

        expect(report.current.windSpeed).toBe(9.8);
        expect(report.current.windGust).toBe(17.5);
        expect(report.current.airTemperature).toBe(17.7);
        expect(report.current.pressure).toBe(1027.7);
        expect(report.current.windDegree).toBe(164);
        expect(report.current.windDirection).toBe('SSE');
    });

    it('carries the band — the thing no single model has', () => {
        const report = makeReport();
        applySpitfireToReport(report, makeSpitfire());
        expect(report.current.windSpeedMin).toBe(6.1);
        expect(report.current.windSpeedMax).toBe(16.9);
    });

    it('keeps tides and other scaffolding the normal pipeline assembled', () => {
        const report = makeReport();
        applySpitfireToReport(report, makeSpitfire());
        expect(report.tides).toHaveLength(1);
        expect(report.tides[0].height).toBe(1.6);
    });

    it('records live weights, MAE and the honest scope of what was scored', () => {
        const report = makeReport();
        applySpitfireToReport(report, makeSpitfire());
        expect(report.spitfire?.label).toBe('SPITFIRE');
        expect(report.spitfire?.maeKt.dwd_icon).toBe(2.77);
        expect(report.spitfire?.weightsScope).toContain('Newport');
    });

    it('overlays hourly rows by epoch hour and carries the per-hour band', () => {
        const report = makeReport({
            hourly: [
                { time: '2026-07-21T02:00:00Z', windSpeed: 1, windGust: 1, temperature: 1 },
                { time: '2026-07-21T03:00:00Z', windSpeed: 1, windGust: 1, temperature: 1 },
            ],
        });
        const s = makeSpitfire({
            hourly: {
                time: ['2026-07-21T02:00:00+00:00', '2026-07-21T03:00:00+00:00'],
                wind_speed_10m: [11, 12],
                wind_gusts_10m: [18, 19],
                wind_speed_10m_min: [8, 9],
                wind_speed_10m_max: [15, 16],
            },
        });
        applySpitfireToReport(report, s);

        expect(report.hourly.map((h) => h.windSpeed)).toEqual([11, 12]);
        expect(report.hourly.map((h) => h.windSpeedMin)).toEqual([8, 9]);
        expect(report.hourly.map((h) => h.windSpeedMax)).toEqual([15, 16]);
    });

    it('leaves an hour alone when the consensus has no matching hour', () => {
        const report = makeReport({
            hourly: [{ time: '2026-07-21T02:00:00Z', windSpeed: 7, windGust: 7, temperature: 1 }],
        });
        const s = makeSpitfire({
            hourly: { time: ['2026-07-25T02:00:00+00:00'], wind_speed_10m: [99] },
        });
        applySpitfireToReport(report, s);
        expect(report.hourly[0].windSpeed).toBe(7);
    });
});
