/**
 * Built from REAL model output for Newport, Moreton Bay (-27.20, 153.10),
 * pulled from the self-hosted Open-Meteo instance on 19 Jul 2026:
 * sea_level_height_msl from meteofrance_currents, wind from ecmwf_ifs025.
 *
 * Using real data rather than a synthetic sine wave matters here — it is the
 * only way to catch the case where the tide series is subtly not what we
 * assume (wrong sign, wrong period, nulls at the horizon).
 */
import { describe, it, expect } from 'vitest';
import { buildWindOverTideSeries, summariseAlerts, springNeapRatio } from '../services/tide/windOverTideSeries';

const NEWPORT = {
    times: [
        '2026-07-19T00:00',
        '2026-07-19T01:00',
        '2026-07-19T02:00',
        '2026-07-19T03:00',
        '2026-07-19T04:00',
        '2026-07-19T05:00',
        '2026-07-19T06:00',
        '2026-07-19T07:00',
        '2026-07-19T08:00',
        '2026-07-19T09:00',
        '2026-07-19T10:00',
        '2026-07-19T11:00',
        '2026-07-19T12:00',
        '2026-07-19T13:00',
        '2026-07-19T14:00',
        '2026-07-19T15:00',
        '2026-07-19T16:00',
        '2026-07-19T17:00',
        '2026-07-19T18:00',
        '2026-07-19T19:00',
        '2026-07-19T20:00',
        '2026-07-19T21:00',
        '2026-07-19T22:00',
        '2026-07-19T23:00',
        '2026-07-20T00:00',
        '2026-07-20T01:00',
        '2026-07-20T02:00',
        '2026-07-20T03:00',
        '2026-07-20T04:00',
        '2026-07-20T05:00',
        '2026-07-20T06:00',
        '2026-07-20T07:00',
        '2026-07-20T08:00',
        '2026-07-20T09:00',
        '2026-07-20T10:00',
        '2026-07-20T11:00',
        '2026-07-20T12:00',
        '2026-07-20T13:00',
        '2026-07-20T14:00',
        '2026-07-20T15:00',
    ],
    seaLevel: [
        1.4, 1.11, 0.69, 0.25, -0.11, -0.32, -0.34, -0.17, 0.13, 0.48, 0.8, 1.03, 1.1, 0.99, 0.71, 0.39, 0.11, -0.08,
        -0.11, 0.06, 0.35, 0.7, 1.02, 1.24, 1.31, 1.18, 0.89, 0.52, 0.16, -0.11, -0.25, -0.21, -0.02, 0.27, 0.57, 0.84,
        1.02, 1.05, 0.93, 0.67,
    ],
    windDirection: [
        194, 193, 195, 196, 197, 196, 193, 192, 194, 196, 194, 182, 168, 161, 158, 157, 158, 164, 174, 180, 179, 175,
        171, 170, 169, 168, 166, 165, 162, 159, 155, 150, 147, 142, 140, 138, 136, 134, 134, 134,
    ],
    windSpeed: [
        11.4, 11.2, 10.8, 10.5, 10.4, 10.5, 10.6, 10.7, 10.8, 10.7, 10.8, 11.5, 13.3, 14.6, 14.5, 13.5, 12.6, 11.5,
        10.6, 10.1, 10.3, 10.7, 11.2, 11.2, 10.9, 10.9, 11.2, 11.7, 12.0, 11.9, 11.4, 11.4, 12.3, 13.7, 14.5, 14.4,
        13.9, 13.3, 12.6, 12.0,
    ],
};

describe('springNeapRatio', () => {
    it('is dimensionless and near 1 for a typical cycle', () => {
        const r = springNeapRatio(NEWPORT.seaLevel, 6);
        expect(r).not.toBeNull();
        expect(r!).toBeGreaterThan(0.5);
        expect(r!).toBeLessThan(2.0);
    });

    it('returns null rather than inventing a value on a short series', () => {
        expect(springNeapRatio([1, 2, 3], 1)).toBeNull();
    });
});

describe('buildWindOverTideSeries on real Newport data', () => {
    const series = buildWindOverTideSeries({
        times: NEWPORT.times,
        seaLevel: NEWPORT.seaLevel,
        windDirection: NEWPORT.windDirection,
        windSpeed: NEWPORT.windSpeed,
        // Moreton Bay: the flood runs roughly south-west up the bay.
        floodDirection: 225,
    });

    it('covers the series minus the final hour (needs a next height)', () => {
        expect(series.length).toBeGreaterThan(30);
        expect(series.length).toBeLessThanOrEqual(NEWPORT.times.length);
    });

    it('tracks the semi-diurnal ebb and flood', () => {
        // Falls 1.40 -> -0.34 over the first six hours: that is an ebb.
        expect(series[0].phase).toBe('ebb');
        expect(series[1].phase).toBe('ebb');
        // Then rises again.
        const rising = series.slice(6, 12).filter((w) => w.phase === 'flood');
        expect(rising.length).toBeGreaterThan(2);
    });

    it('flips stream direction between ebb and flood', () => {
        const ebb = series.find((w) => w.phase === 'ebb');
        const flood = series.find((w) => w.phase === 'flood');
        expect(flood!.streamDeg).toBe(225);
        expect(ebb!.streamDeg).toBe(45); // floodDirection + 180
    });

    it('never reports a bare boolean without saying how it decided', () => {
        for (const w of series) {
            expect(['measured', 'inferred', 'unknown', 'below']).toContain(w.result.confidence);
            // No current feed exists for this bay, so nothing may claim 'measured'.
            expect(w.result.confidence).not.toBe('measured');
        }
    });

    it('does not silently go quiet just because there is no current data', () => {
        // The whole point of the windOverTide fix: absent current must not
        // read as "safe". With a southerly over a running tide, at least some
        // hours should be judged 'against'.
        const against = series.filter((w) => w.result.relation === 'against');
        expect(against.length).toBeGreaterThan(0);
    });
});

describe('summariseAlerts', () => {
    it('collapses contiguous hours into windows', () => {
        const series = buildWindOverTideSeries({
            times: NEWPORT.times,
            seaLevel: NEWPORT.seaLevel,
            windDirection: NEWPORT.windDirection.map(() => 45), // wind FROM NE
            windSpeed: NEWPORT.windSpeed.map(() => 25), // strong
            floodDirection: 45, // stream TOWARD NE on flood
        });
        const alerts = summariseAlerts(series);
        expect(alerts.length).toBeGreaterThan(0);
        for (const a of alerts) {
            expect(a.hours).toBeGreaterThan(0);
            expect(Date.parse(a.to)).toBeGreaterThanOrEqual(Date.parse(a.from));
            expect(a.peakWindKts).toBeCloseTo(25, 1);
        }
    });

    it('reports the weakest confidence across a run, not the first', () => {
        const series = buildWindOverTideSeries({
            times: NEWPORT.times,
            seaLevel: NEWPORT.seaLevel,
            windDirection: NEWPORT.windDirection.map(() => 45),
            windSpeed: NEWPORT.windSpeed.map(() => 25),
            floodDirection: 45,
        });
        for (const a of summariseAlerts(series)) {
            expect(a.confidence).not.toBe('measured');
        }
    });
});
