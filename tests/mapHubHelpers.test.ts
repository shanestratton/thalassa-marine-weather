import { describe, expect, it, vi } from 'vitest';
import {
    AUTO_MAX_LEG_M,
    coordName,
    distMetres,
    fitTraceBounds,
    legCacheKey,
    msToLocalInput,
    TRACE_CLUSTER_SPAN_M,
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

    it('fits the complete trace with map-control-safe padding', () => {
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
            },
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
});
