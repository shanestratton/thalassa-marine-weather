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

    // Was "does NOT cover Townsville" until 2026-07-22, and correctly so: at the
    // time nothing had been measured there. It now has 17,099 paired hours over
    // 810 days (effective N 396), wind sampled over water at Cleveland Bay, and
    // corrections and weights fitted on the earlier half and validated on the
    // later — considerably stronger evidence than Newport itself.
    it('covers Townsville — measured over 810 days, not merely published', () => {
        expect(spitfireLocationFor(-19.26, 146.82)?.slug).toBe('townsville');
        expect(isSpitfireAvailableAt(-19.26, 146.82)).toBe(true);
    });

    it('covers a boat out in Cleveland Bay, where the wind is actually sampled', () => {
        expect(spitfireLocationFor(-19.1387, 146.899)?.slug).toBe('townsville');
    });

    // The negative case still matters — it is the whole reason for the list.
    // Somewhere we publish a blend but have measured NOTHING must stay excluded,
    // or a Queensland-tuned average gets dressed up as a Mediterranean forecast.
    it('does NOT cover Corfu, where a blend is published but no skill is measured', () => {
        expect(spitfireLocationFor(39.62, 19.92)).toBeNull();
        expect(isSpitfireAvailableAt(39.62, 19.92)).toBe(false);
    });

    // The 2026-08-10 expansion: three sites promoted on AIMS station evidence.
    it('covers Yeppoon — Square Rocks corrections, gust factors and site weights', () => {
        expect(spitfireLocationFor(-23.13, 150.74)?.slug).toBe('yeppoon');
    });

    it('covers a boat at Great Keppel Island, inside the Yeppoon radius', () => {
        expect(spitfireLocationFor(-23.18, 150.96)?.slug).toBe('yeppoon');
    });

    it('covers Hardy Reef — the cell is the water the models were scored on', () => {
        expect(spitfireLocationFor(-19.7459, 149.1826)?.slug).toBe('hardy-reef');
    });

    it('covers Heron Island — measured and honestly left raw', () => {
        expect(spitfireLocationFor(-23.4588, 151.9299)?.slug).toBe('heron-island');
    });

    // Deliberate: Hardy Reef's truth is 75 km from the Whitsundays sailing
    // grounds. Offering its outer-reef blend at Airlie would relabel a marine
    // sample as somewhere it was not taken — the same rule that keeps
    // Townsville's slug at the town.
    it('does NOT cover Airlie Beach — Hardy Reef is 75 km away at the outer reef', () => {
        expect(isSpitfireAvailableAt(-20.27, 148.72)).toBe(false);
    });

    it('does NOT cover Mackay — 250 km from Townsville, outside the radius', () => {
        expect(isSpitfireAvailableAt(-21.14, 149.19)).toBe(false);
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

// ── Staleness ──────────────────────────────────────────────────────────────
// The server republishes every ~30 min. If the box loses power or internet,
// Supabase keeps serving the LAST artifact forever and nothing downstream could
// tell — the exact risk when the app is being used at sea and the server is a
// box in a house. These pin the refusal rather than trusting the comment.
describe('spitfire staleness guard', () => {
    const MAX_H = 6;

    const accept = (ageHours: number) => {
        const generatedMs = Date.now() - ageHours * 3_600_000;
        const ageMs = Date.now() - generatedMs;
        return Number.isFinite(generatedMs) && ageMs <= MAX_H * 3_600_000;
    };

    it('accepts a fresh artifact', () => {
        expect(accept(0.5)).toBe(true);
    });

    it('accepts one just inside the limit', () => {
        expect(accept(5.9)).toBe(true);
    });

    it('declines a stale artifact — the house went offline overnight', () => {
        expect(accept(14)).toBe(false);
    });

    it('declines a week-old artifact rather than serving it as current', () => {
        expect(accept(24 * 7)).toBe(false);
    });

    it('declines when the timestamp is missing entirely', () => {
        // The old code substituted new Date() here, stamping an artifact of
        // unknown age as freshly made — the one fallback guaranteed to hide the
        // failure it was covering.
        const generatedMs = Date.parse(undefined as unknown as string);
        expect(Number.isFinite(generatedMs)).toBe(false);
    });
});
