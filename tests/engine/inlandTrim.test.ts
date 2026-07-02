/**
 * Inland-tail trim — a route may never TERMINATE on charted dry land.
 *
 * A destination geocoded to a suburb centroid (Shane's "Pinkenba" pin) is made
 * reachable by the relax machinery (LNDARE → 500×-cost CAUTION), so the raw
 * route crawls up the bank as red and the tide chips price a land crossing.
 * The engine must trim the overland tail: final vertex at the water's edge,
 * per-segment masks kept consistent, destinationInlandTrimM reporting what was
 * cut. Berth arrivals are NOT trimmed — carved canal / injected marina water
 * and charted-shallow (drying) cells are water evidence, and the golden
 * Newport→Rivergate berth test locks that side.
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

describe('inland destination tail trim', () => {
    it('a suburb-centroid destination on LNDARE gets its overland tail trimmed to the water edge', () => {
        // Deep water west | charted LAND east. Destination ~2.5 km INSIDE the
        // land polygon — far enough that the deep-snap preference (1500 m)
        // cannot rescue it, so the localized relax retry wins the swap and the
        // shipped route reaches the pin over relax-carved red land. The trim
        // must then cut that tail back to the shoreline.
        const layers = {
            DEPARE: fc(rect(152.9, -27.66, 152.93, -27.64, { DRVAL1: 10, acronym: 'DEPARE' })),
            LNDARE: fc(rect(152.93, -27.66, 152.97, -27.64, { acronym: 'LNDARE' })),
        };
        const req: RouteRequest = {
            fromLat: -27.65,
            fromLon: 152.905,
            toLat: -27.65,
            toLon: 152.955, // ~2.5 km inside the LNDARE
            draftM: 2.0,
            safetyM: 0.5,
            resolutionM: 50,
        };
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;

        // The trim fired and reported the overland cut.
        expect(r.destinationInlandTrimM ?? 0).toBeGreaterThan(200);
        // Final vertex sits at (or within a cell of) the water's edge — never
        // deep inside the land polygon.
        const [endLon] = r.polyline[r.polyline.length - 1];
        expect(endLon).toBeLessThan(152.9315);
        // Masks stay per-segment consistent after the trim.
        for (const mask of [r.cautionMask, r.canalMask, r.channelMask, r.offshoreMask]) {
            if (mask) expect(mask.length).toBe(r.polyline.length - 1);
        }
    });
});
