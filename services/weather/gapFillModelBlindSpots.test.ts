import { describe, it, expect } from 'vitest';
import { gapFillModelBlindSpots } from './index';
import type { MarineWeatherReport } from '../../types';

/** Minimal report shaped just enough for the gap-filler. */
function makeReport(over: Record<string, unknown> = {}): MarineWeatherReport {
    return {
        locationName: 'Newport, QLD',
        coordinates: { lat: -27.21, lon: 153.1 },
        generatedAt: '2026-07-21T00:00:00.000Z',
        current: { uvIndex: null, visibility: null },
        hourly: [],
        forecast: [],
        tides: [],
        tideHourly: [],
        modelUsed: 'wx_dwd_icon',
        boatingAdvice: '',
        alerts: [],
        timeZone: 'Australia/Brisbane',
        ...over,
    } as unknown as MarineWeatherReport;
}

describe('gapFillModelBlindSpots', () => {
    it('borrows UV and visibility when the pinned model has neither', () => {
        const report = makeReport();
        const supplement = makeReport({ current: { uvIndex: 4.4, visibility: 12.5 } });

        expect(gapFillModelBlindSpots(report, supplement)).toBe(true);
        expect(report.current.uvIndex).toBe(4.4);
        expect(report.current.visibility).toBe(12.5);
    });

    it("never overwrites the pinned model's own values", () => {
        // UKMO/GFS DO publish visibility — the model must win over WeatherKit.
        const report = makeReport({ current: { uvIndex: null, visibility: 9.1 } });
        const supplement = makeReport({ current: { uvIndex: 4.4, visibility: 25.0 } });

        gapFillModelBlindSpots(report, supplement);
        expect(report.current.visibility).toBe(9.1); // model's own, untouched
        expect(report.current.uvIndex).toBe(4.4); // genuine hole, filled
    });

    it('is a no-op without a supplement (returns false, leaves nulls honest)', () => {
        const report = makeReport();
        expect(gapFillModelBlindSpots(report, null)).toBe(false);
        expect(report.current.uvIndex).toBeNull();
        expect(report.current.visibility).toBeNull();
    });

    it('reports false when the supplement has nothing to offer', () => {
        const report = makeReport();
        const supplement = makeReport({ current: { uvIndex: null, visibility: null } });
        expect(gapFillModelBlindSpots(report, supplement)).toBe(false);
    });

    it('matches hourly rows on UTC epoch hour', () => {
        const report = makeReport({
            hourly: [
                { time: '2026-07-21T02:00:00Z', uvIndex: null, visibility: null },
                { time: '2026-07-21T03:00:00Z', uvIndex: null, visibility: null },
            ],
        });
        const supplement = makeReport({
            hourly: [
                // Same instants, written with a +00:00 offset instead of Z —
                // the two upstreams don't agree on formatting.
                { time: '2026-07-21T02:00:00+00:00', uvIndex: 3, visibility: 20 },
                { time: '2026-07-21T03:00:00+00:00', uvIndex: 5, visibility: 18 },
            ],
        });

        expect(gapFillModelBlindSpots(report, supplement)).toBe(true);
        expect(report.hourly.map((h) => h.uvIndex)).toEqual([3, 5]);
        expect(report.hourly.map((h) => h.visibility)).toEqual([20, 18]);
    });

    it("aligns Open-Meteo's zone-less local times with WeatherKit's UTC ones", () => {
        // Open-Meteo is queried with `timezone=auto`, so it returns times with
        // NO zone suffix ("2026-07-21T12:00") that `new Date()` reads as the
        // DEVICE's local time. WeatherKit returns real UTC instants. These
        // line up only while the device's zone matches the location's — true
        // for a boat sitting where it's looking, which is the case this
        // pipeline is built for. Computed from the runtime zone so the
        // assertion holds wherever the suite runs, and fails loudly if the
        // matching key ever stops being epoch-based.
        const localNaive = '2026-07-21T12:00';
        const sameInstantUtc = new Date(localNaive).toISOString();

        const report = makeReport({ hourly: [{ time: localNaive, uvIndex: null, visibility: null }] });
        const supplement = makeReport({ hourly: [{ time: sameInstantUtc, uvIndex: 6, visibility: 22 }] });

        expect(gapFillModelBlindSpots(report, supplement)).toBe(true);
        expect(report.hourly[0].uvIndex).toBe(6);
        expect(report.hourly[0].visibility).toBe(22);
    });

    it('leaves an hour untouched when the supplement has no matching hour', () => {
        const report = makeReport({ hourly: [{ time: '2026-07-21T02:00', uvIndex: null, visibility: null }] });
        const supplement = makeReport({ hourly: [{ time: '2026-07-25T02:00:00Z', uvIndex: 9, visibility: 30 }] });

        gapFillModelBlindSpots(report, supplement);
        expect(report.hourly[0].uvIndex).toBeNull();
        expect(report.hourly[0].visibility).toBeNull();
    });

    it('fills daily UV max by ISO date, gap-fill only', () => {
        const report = makeReport({
            forecast: [
                { isoDate: '2026-07-21', uvIndex: null },
                { isoDate: '2026-07-22', uvIndex: 7 },
            ],
        });
        const supplement = makeReport({
            forecast: [
                { isoDate: '2026-07-21', uvIndex: 5 },
                { isoDate: '2026-07-22', uvIndex: 99 },
            ],
        });

        expect(gapFillModelBlindSpots(report, supplement)).toBe(true);
        expect(report.forecast[0].uvIndex).toBe(5); // filled
        expect(report.forecast[1].uvIndex).toBe(7); // preserved
    });
});
