import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    AUTO_MAX_LEG_M,
    coordName,
    distMetres,
    fitTraceBounds,
    isBasemapHybridDuplicateLabelLayer,
    legCacheKey,
    msToLocalInput,
    TRACE_CLUSTER_SPAN_M,
    tracerFlyTo,
} from '../components/map/mapHubHelpers';

describe('mapHubHelpers', () => {
    it('formats coordinates with hemisphere labels, including zero', () => {
        expect(coordName(-27.4689, 153.0235)).toBe('27.4689°S, 153.0235°E');
        expect(coordName(0, -0.25)).toBe('0.0000°N, 0.2500°W');
    });

    it('makes the final-leg state part of the trace cache key', () => {
        const a = { lat: -27.12345649, lon: 153.1 };
        const b = { lat: -27.2, lon: 153.2000004 };
        expect(legCacheKey(a, b, false)).toBe('-27.123456,153.100000|-27.200000,153.200000');
        expect(legCacheKey(a, b, true)).toBe('-27.123456,153.100000|-27.200000,153.200000|last');
    });

    // The padding clears Plan's route card for this flight only: Mapbox keeps
    // a call's padding on the map unless it says retainPadding: false, and
    // Obs shares this map (build 124, Obs camera centring).
    it('fits the complete trace with map-control-safe padding, and leaves none on the map', () => {
        const fitBounds = vi.fn();
        fitTraceBounds({ fitBounds } as never, []);
        expect(fitBounds).not.toHaveBeenCalled();

        fitTraceBounds({ fitBounds } as never, [
            { lat: -27.4, lon: 153.3 },
            { lat: -27.7, lon: 153.1 },
            { lat: -27.5, lon: 153.6 },
        ]);
        expect(fitBounds).toHaveBeenCalledWith(
            [
                [153.1, -27.7],
                [153.6, -27.4],
            ],
            {
                padding: { top: 90, bottom: 130, left: 300, right: 40 },
                maxZoom: 15,
                duration: 900,
                retainPadding: false,
            },
        );
    });

    it('fits a northern and western route the same way (Falmouth to A Coruña)', () => {
        const fitBounds = vi.fn();
        fitTraceBounds({ fitBounds } as never, [
            { lat: 50.15, lon: -5.07 },
            { lat: 43.37, lon: -8.4 },
        ]);
        expect(fitBounds).toHaveBeenCalledExactlyOnceWith(
            [
                [-8.4, 43.37],
                [-5.07, 50.15],
            ],
            expect.objectContaining({ retainPadding: false }),
        );
    });

    // Review 2026-10-08: with the fit's padding no longer left on the map, a
    // tracer flight that named none landed at the canvas centre, under the
    // open route card (x 12 to 300 on a phone). Before, after any route fit,
    // it reused the fit's leftover padding and landed in the strip right of
    // the card. Each flight now names that padding for itself.
    it('flies the tracer to a point beside its route card, leaving no padding on the map', () => {
        const flyTo = vi.fn();
        tracerFlyTo({ flyTo } as never, { lat: 43.369, lon: -8.398 }, 15, 700);
        expect(flyTo).toHaveBeenCalledExactlyOnceWith({
            center: [-8.398, 43.369],
            zoom: 15,
            duration: 700,
            padding: { top: 90, bottom: 130, left: 300, right: 40 },
            retainPadding: false,
        });
    });

    it('every flight the tracer card makes frames beside the card (tracerFlyTo)', () => {
        const list = readFileSync('components/map/tracer/TracerWaypointList.tsx', 'utf8');
        expect(list).not.toMatch(/\.flyTo\(/);
        expect(list.match(/tracerFlyTo\(/g)).toHaveLength(2);
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        // The tracer's own flights: new-leg seed, single-point return leg,
        // typed coordinate, paste, sailed track, course frame, ⚡ arrival,
        // queue and saved-list loads, the report's fly-to.
        expect(hub.match(/tracerFlyTo\(/g)?.length).toBeGreaterThanOrEqual(10);
        // What still flies on the whole canvas is not the tracer's: Obs's
        // recentre, the threat banner, a passage hazard, AIS vessel search,
        // and the parked closed-pill guided start.
        const raw = [...hub.matchAll(/\.flyTo\(/g)].map((m) => hub.slice(Math.max(0, m.index! - 700), m.index));
        const owner = (before: string) =>
            [
                'onRecenter={',
                'flyTo={(lat, lon, zoom)',
                'onHazardClick=',
                'onSelect={(lat, lon, mmsi, name)',
                'Guided start',
            ]
                .map((marker) => [marker, before.lastIndexOf(marker)] as const)
                .filter(([, at]) => at >= 0)
                .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'the tracer';
        expect(raw.map(owner).sort()).toEqual(
            [
                'Guided start',
                'flyTo={(lat, lon, zoom)',
                'onHazardClick=',
                'onRecenter={',
                'onSelect={(lat, lon, mmsi, name)',
            ].sort(),
        );
    });

    it('measures nearby distances and preserves route window invariants', () => {
        expect(distMetres({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
        expect(distMetres({ lat: -27, lon: 153 }, { lat: -27.009, lon: 153 })).toBeCloseTo(994.86, 1);
        expect(TRACE_CLUSTER_SPAN_M).toBeGreaterThan(AUTO_MAX_LEG_M);
    });

    it('formats datetime-local values using local calendar fields', () => {
        const date = new Date(2026, 6, 23, 9, 7, 45);
        expect(msToLocalInput(date.getTime())).toBe('2026-07-23T09:07');
    });

    it('identifies only basemap labels duplicated by the hybrid raster', () => {
        expect(
            isBasemapHybridDuplicateLabelLayer({
                id: 'settlement-major-label',
                type: 'symbol',
                source: 'composite',
            }),
        ).toBe(true);
        expect(
            isBasemapHybridDuplicateLabelLayer({
                id: 'airport-label',
                type: 'symbol',
                source: 'openmaptiles',
            }),
        ).toBe(true);

        // App-owned labels must remain available above the hybrid raster.
        expect(
            isBasemapHybridDuplicateLabelLayer({
                id: 'route-city-label',
                type: 'symbol',
                source: 'route-preview',
            }),
        ).toBe(false);
        expect(
            isBasemapHybridDuplicateLabelLayer({
                id: 'settlement-major-label',
                type: 'symbol',
            }),
        ).toBe(false);
        expect(
            isBasemapHybridDuplicateLabelLayer({
                id: 'settlement-major-label',
                type: 'line',
                source: 'composite',
            }),
        ).toBe(false);
    });
});
