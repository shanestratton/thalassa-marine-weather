/**
 * tideAssist route profile — the EXPLICIT "shortest" option.
 *
 * Doctrine: tide never silently changes preference — the DEFAULT (safest)
 * profile prices all caution at 40×/120× and detours around a recoverable
 * bank. The tideAssist profile is a user-chosen alternative: caution cells
 * wet at LAT with requiredRise ≤ 1.8 m price at 10×, so the short way across
 * a 2.0 m bank (Shane's southern-Bribie crossing: 2.4 m keel + 0.5 margin −
 * 2.0 charted = +0.9 m above LAT) becomes routable — and the run ships its
 * real charted depth so the tide-window chip can say WHEN.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import type { FeatureCollection, Feature } from 'geojson';

function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}
const fc = (...f: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: f });
const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;

// Wide corridor: deep water everywhere EXCEPT a 2.0 m band crossing the
// southern 2/3 of the corridor at mid-lon. Endpoints sit in the SOUTH, so the
// straight line crosses the band (~500 m) while a deep gap exists ~2 km north.
const layers = {
    DEPARE: fc(
        rect(152.5, -27.93, 152.52, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }), // west deep
        rect(152.52, -27.93, 152.525, -27.9, { DRVAL1: 2.0, acronym: 'DEPARE' }), // the bank (south 2/3)
        rect(152.52, -27.9, 152.525, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }), // deep gap (north)
        rect(152.525, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }), // east deep
    ),
};
const base: RouteRequest = {
    fromLat: -27.925,
    fromLon: 152.505,
    toLat: -27.925,
    toLon: 152.54,
    draftM: 2.4,
    safetyM: 0.5, // floor 2.9 → the 2.0 band is caution, requiredRise 0.9 ≤ 1.8
    resolutionM: 50,
};

/** Mean crossing latitude of the route within the bank's lon range. */
function crossingLat(poly: [number, number][]): number {
    const lats: number[] = [];
    for (let i = 0; i + 1 < poly.length; i++) {
        for (let s = 0; s <= 20; s++) {
            const t = s / 20;
            const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
            if (lon > 152.52 && lon < 152.525) lats.push(poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t);
        }
    }
    return lats.reduce((a, b) => a + b, 0) / Math.max(1, lats.length);
}

describe('tideAssist route profile', () => {
    it('SAFEST (default) detours north through the deep gap', () => {
        const r = routeInshore(layers, base);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(crossingLat(r.polyline)).toBeGreaterThan(-27.9006); // crossed in the deep gap
    });

    it('TIDE-ASSIST crosses the 2.0 m bank directly and ships the depth for the window', () => {
        const r = routeInshore(layers, { ...base, routeProfile: 'tideAssist' });
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(crossingLat(r.polyline)).toBeLessThan(-27.905); // crossed through the bank
        const runs = r.shallowRuns ?? [];
        expect(runs.length).toBeGreaterThanOrEqual(1);
        // The run carries the REAL 2.0 m — requiredRise 2.9 − 2.0 = +0.9 m above LAT.
        expect(runs.some((x) => x.minDepthM === 2)).toBe(true);
    });
});
