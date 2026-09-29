/**
 * Phase 0 (Shane approved 2026-09-29): a charted clearing line is the edge of
 * a danger, never a channel.
 *
 * The only way from origin to destination crosses a 200 m band charted at
 * 1.0 m, too shallow for a 2.0 m draft. Before the lead gate, a NAVLNE
 * CATNAV 1 (clearing line) or CATNAV 2 (transit) along the route made that
 * band a preferred corridor rescued to 5 m, so the crossing came back as
 * clean deep water. It must come back flagged: the chart says 1.0 m.
 * Synthetic geometry at lon 168.4 (its own grid-cache fingerprint).
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../services/inshoreRouterEngine';

const LAT = -27.2;
const BAND_W = 168.4;
const BAND_E = 168.402; // ≈ 200 m
const rect = (w: number, s: number, e: number, n: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const layers = (nav?: Record<string, unknown>): InshoreLayers => ({
    DEPARE: fc(
        rect(BAND_W - 0.4, LAT - 0.4, BAND_W, LAT + 0.4, { acronym: 'DEPARE', DRVAL1: 12, DRVAL2: 20 }),
        rect(BAND_W, LAT - 0.4, BAND_E, LAT + 0.4, { acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 2 }),
        rect(BAND_E, LAT - 0.4, BAND_E + 0.4, LAT + 0.4, { acronym: 'DEPARE', DRVAL1: 12, DRVAL2: 20 }),
    ),
    ...(nav
        ? {
              NAVLINE: fc({
                  type: 'Feature',
                  properties: nav,
                  geometry: {
                      type: 'LineString',
                      coordinates: [
                          [BAND_W - 0.02, LAT],
                          [BAND_E + 0.02, LAT],
                      ],
                  },
              }),
          }
        : {}),
});
const req: RouteRequest = {
    fromLat: LAT,
    fromLon: BAND_W - 0.012,
    toLat: LAT,
    toLon: BAND_E + 0.012,
    draftM: 2.0,
    safetyM: 0.5,
    resolutionM: 25,
};

/** Metres of the returned route that ride the 1.0 m band flagged as caution. */
function flaggedBandM(l: InshoreLayers): number {
    const r = routeInshore(l, req);
    if (!('polyline' in r)) throw new Error(`route failed: ${r.error}`);
    let m = 0;
    for (let i = 1; i < r.polyline.length; i++) {
        const [lonA, latA] = r.polyline[i - 1];
        const [lonB, latB] = r.polyline[i];
        const midLon = (lonA + lonB) / 2;
        if (midLon < BAND_W || midLon > BAND_E || !r.cautionMask?.[i - 1]) continue;
        m += Math.hypot((lonB - lonA) * 111_320 * Math.cos((LAT * Math.PI) / 180), (latB - latA) * 110_540);
    }
    return m;
}

describe('inshore router — clearing and transit lines never vouch for depth', () => {
    it('baseline: crossing the 1.0 m band is flagged', () => {
        expect(flaggedBandM(layers())).toBeGreaterThan(0);
    });

    it.each([
        ['clearing line', 1],
        ['transit', 2],
    ])('a chart %s along the route still leaves the crossing flagged', (_name, CATNAV) => {
        expect(flaggedBandM(layers({ acronym: 'NAVLNE', CATNAV }))).toBeGreaterThan(0);
    });
});
