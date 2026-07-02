/**
 * Drying-tier caution cost — the "don't cut across the bank" knob.
 *
 * Flat 40× for ALL caution made A* indifferent between a drying bank
 * (DRVAL1 ≤ 0 — dries at LAT) and wet-but-shallow water (e.g. a 2 m band for
 * a 2.4 m draft): both cost the same, so the route cut straight across banks
 * a local skipper skirts (Shane's Newport exit crossed charted 0 / −2 m with
 * a 2 m band alongside). Drying cells now cost 120× (3× wet caution) — the
 * route must divert through the wet band.
 *
 * NOT the reverted depth-grading of d55ea29f (that graded PREFERRED water);
 * this grades only within red, and marked channels stay exempt via
 * `preferred`.
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

describe('drying-tier caution cost', () => {
    it('crosses a caution wall through the WET band, not the drying bank on the straight line', () => {
        // Deep west | full-height caution wall (south half DRYING DRVAL1=0,
        // north half WET DRVAL1=2) | deep east. The straight line runs through
        // the DRYING half; the wet crossing is a ~300 m northward diversion.
        // Flat 40×/40× took the straight line; 120× drying must divert north.
        const layers = {
            DEPARE: fc(
                rect(152.8, -27.76, 152.815, -27.74, { DRVAL1: 10, acronym: 'DEPARE' }),
                // Wall: south = drying bank, north = 2 m wet shallow.
                rect(152.815, -27.76, 152.825, -27.752, { DRVAL1: 0, acronym: 'DEPARE' }),
                rect(152.815, -27.752, 152.825, -27.74, { DRVAL1: 2, acronym: 'DEPARE' }),
                rect(152.825, -27.76, 152.84, -27.74, { DRVAL1: 10, acronym: 'DEPARE' }),
            ),
        };
        const req: RouteRequest = {
            fromLat: -27.755, // aligned with the DRYING half
            fromLon: 152.805,
            toLat: -27.755,
            toLon: 152.835,
            draftM: 2.0,
            safetyM: 1.0, // floor 3 m → both wall bands read caution
            resolutionM: 50,
        };
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;

        // Every point ALONG the route inside the wall's lon range must sit in
        // the WET (northern) band — sampled, because the smoother can span the
        // whole wall with one segment and leave no vertex inside it. One grid
        // cell of slack for rasterisation.
        const cellSlackDeg = 0.0006; // ~65 m
        const inWall: [number, number][] = [];
        for (let i = 0; i + 1 < r.polyline.length; i++) {
            const [aLon, aLat] = r.polyline[i];
            const [bLon, bLat] = r.polyline[i + 1];
            for (let s = 0; s <= 40; s++) {
                const t = s / 40;
                const lon = aLon + (bLon - aLon) * t;
                if (lon > 152.815 && lon < 152.825) inWall.push([lon, aLat + (bLat - aLat) * t]);
            }
        }
        expect(inWall.length).toBeGreaterThan(0);
        for (const [lon, lat] of inWall) {
            expect(lat, `wall crossing at ${lon.toFixed(4)},${lat.toFixed(4)} must be in the wet band`).toBeGreaterThan(
                -27.752 - cellSlackDeg,
            );
        }
        // And the run's min depth reflects the WET band it actually crossed.
        const runs = r.shallowRuns ?? [];
        expect(runs.length).toBeGreaterThanOrEqual(1);
        const main = runs.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
        expect(main.minDepthM).toBe(2);
    });
});
