/**
 * No out-and-back (2026-10-01).
 *
 * A route must never visit deep water only to come back through the same
 * shallows. In the Newport → Pinkenba repro's TIER-2 north-exit case the pin
 * sits in the charted 0–2 m band 113 m from Newport gate 1/2; its charted
 * 'needs tide' tail (owner decision 7) was taken from the deep water its own
 * charted water reaches most cheaply — 2.3 km out past it — so the route ran
 * out through the shallows to 5 m water and a tail came back: 4.51 NM (2.07 NM
 * on the old code). When the pin's charted water joins the route nearer the
 * pin, the route goes through it directly (amber where a tide clears it, with
 * its chip), unless the deep way is shorter or equal.
 *
 * The synthetic chart copies that shape: a deep marina basin, a 3.3 km
 * channel charted 1–2 m leading north out of it to flats charted 1–2 m, the
 * pin on the flats 450 m from the channel mouth, and deep water 2 km east of
 * the pin. Need 2.9 m (2.4 m draft + 0.5 m UKC): the channel and the flats
 * are charted-shallow, never drying.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import type { InshoreLayers } from '../../services/engine/types';
import { haversineM } from '../../services/engine/geometry';
import { revisits } from '../helpers/routeRevisits';

const rect = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const band = (x0: number, y0: number, x1: number, y1: number, DRVAL1: number, DRVAL2: number): Feature =>
    rect(x0, y0, x1, y1, { acronym: 'DEPARE', DRVAL1, DRVAL2 });
const land = (x0: number, y0: number, x1: number, y1: number): Feature => rect(x0, y0, x1, y1, { acronym: 'LNDARE' });

const DEEP_W = 153.33; // the deep water's west edge, 2 km east of the pin
const chart = (): InshoreLayers => ({
    DEPARE: fc(
        band(153.3, -27.51, 153.31, -27.5, 5, 10), // the marina
        band(153.305, -27.5, 153.307, -27.47, 1, 2), // the channel north out of it
        band(153.3, -27.47, DEEP_W, -27.44, 1, 2), // the flats
        band(DEEP_W, -27.47, 153.4, -27.44, 10, 20), // deep water east
    ),
    LNDARE: fc(
        land(153.2, -27.6, 153.3, -27.3),
        land(153.3, -27.44, 153.45, -27.3),
        land(153.31, -27.6, 153.45, -27.47),
        land(153.3, -27.5, 153.305, -27.47),
        land(153.307, -27.5, 153.31, -27.47),
        land(153.3, -27.6, 153.31, -27.51),
        land(153.4, -27.47, 153.45, -27.44),
    ),
});
const REQ: RouteRequest = {
    fromLat: -27.505,
    fromLon: 153.305,
    toLat: -27.466,
    toLon: 153.31,
    draftM: 2.4,
    safetyM: 0.5,
    resolutionM: 50,
};
const isResult = (r: ReturnType<typeof routeInshore>): r is RouteResult => 'polyline' in r;
const lengthM = (poly: readonly [number, number][]): number =>
    poly.slice(1).reduce((m, p, i) => m + haversineM(poly[i][1], poly[i][0], p[1], p[0]), 0);

describe('no out-and-back — a pin in charted-shallow water is reached through its own water', () => {
    it('goes up the channel and across the flats to the pin, never out to the deep water and back', () => {
        const r = routeInshore(chart(), REQ);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        // Ends AT the pin, its tail a charted needs-tide stretch (decision 7).
        const [lon, lat] = r.polyline[r.polyline.length - 1];
        expect(haversineM(REQ.toLat, REQ.toLon, lat, lon)).toBeLessThan(1);
        expect(r.shallowRuns?.some((s) => s.endpointTail === 'destination')).toBe(true);
        // Never out to the deep water east of the flats.
        expect(Math.max(...r.polyline.map((p) => p[0]))).toBeLessThan(DEEP_W);
        expect(revisits(r.polyline)).toBe(false);
        // Within a sane bound of the direct charted way: 3.3 km of channel and
        // ~0.45 km of flats (was ~7.4 km: out 2 km to the deep water, 2 km back).
        expect(lengthM(r.polyline)).toBeLessThan(1.25 * 3750);
        expect(r.debug?.outAndBackCutM?.destination ?? 0).toBeGreaterThan(2000);
    });

    it('symmetrically, a departure from the flats leaves through its own water', () => {
        const q = { ...REQ, fromLat: REQ.toLat, fromLon: REQ.toLon, toLat: REQ.fromLat, toLon: REQ.fromLon };
        const r = routeInshore(chart(), q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.polyline[0]).toEqual([q.fromLon, q.fromLat]);
        expect(Math.max(...r.polyline.map((p) => p[0]))).toBeLessThan(DEEP_W);
        expect(revisits(r.polyline)).toBe(false);
        expect(lengthM(r.polyline)).toBeLessThan(1.25 * 3750);
    });

    it('the revisit detector sees an out-and-back', () => {
        const out: [number, number][] = [
            [153.31, -27.466],
            [153.34, -27.466],
            [153.311, -27.4661],
        ];
        expect(revisits(out)).toBe(true);
        expect(
            revisits([
                [153.31, -27.466],
                [153.34, -27.466],
            ]),
        ).toBe(false);
    });
});
