/**
 * H and L centres, tested on a field that looks like actual weather.
 *
 * The existing PressureChartCues fixture spikes SINGLE CELLS by 15-25 hPa
 * against a flat 1013 background — a shape no atmosphere produces. It passed
 * while production found nothing at all: the old detector demanded a centre
 * beat its immediate 1-degree neighbours by 2 hPa (a tropical-cyclone eyewall
 * gradient) and real synoptic cores clear their neighbours by 0.08-0.26 hPa.
 * So the badges only appeared over a cyclone and vanished as interpolation
 * smoothed it away — "the H and L's are not consistent" (Shane, 2026-08-21).
 *
 * This fixture builds smooth, synoptic-scale systems at realistic gradients.
 * If the detector ever regresses to a mesoscale threshold, these fail.
 */
import { describe, expect, it } from 'vitest';
import { generateIsobarsFromGrid } from '../services/weather/isobars';

/** Smooth global field: a deep low, a strong high, both at real scale. */
function realisticField() {
    const rows = 71; // 1 degree, -35..35 would be small; use 2-degree over 140
    const cols = 91;
    const lats = Array.from({ length: rows }, (_, i) => -60 + i * 1.5);
    const lons = Array.from({ length: cols }, (_, i) => 100 + i * 1.0);

    // Two systems, Gaussian, at scales real weather uses: a ~988 hPa low and
    // a ~1026 hPa high, each roughly 1500 km across.
    const systems = [
        { lat: -45, lon: 150, peak: -25, spreadLat: 9, spreadLon: 14 }, // deep low
        { lat: -22, lon: 128, peak: 13, spreadLat: 8, spreadLon: 13 }, // strong high
    ];

    const values = lats.map((lat) =>
        lons.map((lon) => {
            let p = 1013;
            for (const s of systems) {
                const dLat = (lat - s.lat) / s.spreadLat;
                const dLon = (lon - s.lon) / s.spreadLon;
                p += s.peak * Math.exp(-(dLat * dLat + dLon * dLon));
            }
            return p;
        }),
    );

    const hourly = Array.from({ length: 5 }, () => values.map((r) => [...r]));
    const zeros = Array.from({ length: 5 }, () => Array.from({ length: rows }, () => Array(cols).fill(0)));
    return {
        allHourlyPressure: hourly,
        allHourlyWindSpeed: zeros,
        allHourlyWindDir: zeros,
        lats,
        lons,
        rows,
        cols,
        totalHours: 5,
        refTime: null,
        keyframeFhrs: [0, 2, 4],
        subFrameStepHours: 1,
        source: 'gfs' as const,
    };
}

describe('pressure centres on a realistic synoptic field', () => {
    const grid = realisticField();
    /** Flatten the centres FeatureCollection into what a reader cares about. */
    const centresAt = (hour: number) =>
        (generateIsobarsFromGrid(grid, hour).centers.features ?? []).map((f) => {
            const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
            const p = (f.properties ?? {}) as Record<string, unknown>;
            return {
                type: String(p.type ?? p.label ?? '') as 'H' | 'L',
                lat,
                lon,
                pressure: Number(p.pressure),
            };
        });
    const centres = centresAt(0);

    it('finds the systems a forecaster would circle', () => {
        // The old detector returned ZERO here. Anything less than one of each
        // means the threshold has drifted back to mesoscale.
        expect(centres.filter((c) => c.type === 'L').length).toBeGreaterThanOrEqual(1);
        expect(centres.filter((c) => c.type === 'H').length).toBeGreaterThanOrEqual(1);
    });

    it('puts them where the systems actually are', () => {
        const low = centres.find((c) => c.type === 'L');
        const high = centres.find((c) => c.type === 'H');
        expect(low).toBeDefined();
        expect(high).toBeDefined();
        // Within a couple of grid cells of the constructed cores.
        expect(Math.abs(low!.lat - -45)).toBeLessThan(4);
        expect(Math.abs(low!.lon - 150)).toBeLessThan(4);
        expect(Math.abs(high!.lat - -22)).toBeLessThan(4);
        expect(Math.abs(high!.lon - 128)).toBeLessThan(4);
    });

    it('reports each centre’s own pressure — what a skipper reads off the chart', () => {
        const low = centres.find((c) => c.type === 'L')!;
        const high = centres.find((c) => c.type === 'H')!;
        expect(low.pressure).toBeGreaterThan(985);
        expect(low.pressure).toBeLessThan(995);
        expect(high.pressure).toBeGreaterThan(1021);
        expect(high.pressure).toBeLessThan(1030);
    });

    it('stays put across frames instead of flickering', () => {
        // Same field every hour, so the same centres must survive frame to
        // frame rather than appearing and vanishing as the scrubber moves.
        for (const hour of [0, 1, 2]) {
            const f = centresAt(hour);
            expect(f.some((c) => c.type === 'L')).toBe(true);
            expect(f.some((c) => c.type === 'H')).toBe(true);
        }
    });
});
