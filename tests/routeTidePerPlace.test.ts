/**
 * The route's tide, place by place (round-4 review, 2026-09-30).
 *
 * Owner decision 10 (Shane, 2026-09-30: "Amber if a tide clears it") made the
 * route line's colour hang on the highest tide. It was read from ONE curve,
 * fetched at the longest shallow run's midpoint, and that top coloured every
 * shallow stretch of the route: on Newport → Rivergate the curve came from
 * the Bramble Bay run, the river-mouth bank ~25 km away. And the curve asked
 * WorldTides for 3 days for a departure today, so "highest" was this week's
 * top: at neaps a chip said "never clears" of water next week's springs
 * clear.
 *
 * Now one curve per 0.25° bucket of the tide cache the shallow water lies in
 * (at most MAX_TIDE_CURVES, the buckets holding the most of it first), each
 * over the 14 days the rest of the app loads; a stretch is coloured by its
 * own bucket's top, and one in a bucket nobody fetched stays red.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    DEPART_MS: Date.UTC(2026, 9, 1, 0, 0),
    calls: [] as unknown[][],
    /** The range by bucket the mocked tide service answers with (none: no curve). */
    rangeByBucket: new Map<string, number>(),
}));

vi.mock('mapbox-gl', () => {
    class Marker {
        el: HTMLElement;
        constructor(o: { element: HTMLElement }) {
            this.el = o.element;
        }
        setLngLat() {
            return this;
        }
        addTo() {
            return this;
        }
        getElement() {
            return this.el;
        }
    }
    return { default: { Marker } };
});
vi.mock('../services/TideHeightService', async (orig) => {
    const real = await orig<typeof import('../services/TideHeightService')>();
    return {
        ...real,
        fetchTideCurve: vi.fn(async (lat: number, lon: number, ...rest: unknown[]) => {
            h.calls.push([lat, lon, ...rest]);
            const range = h.rangeByBucket.get(real.tideCurveBucket(lat, lon));
            if (range === undefined) return null;
            const step = (6 * 60 + 12) * 60;
            const t0 = h.DEPART_MS / 1000 - 24 * 3600;
            const extremes = Array.from({ length: 56 }, (_, k) => ({
                dt: t0 + k * step,
                date: '',
                height: k % 2 === 0 ? 0 : range,
                type: (k % 2 === 0 ? 'Low' : 'High') as 'Low' | 'High',
            }));
            return real.buildTideCurve({ status: 200, responseDatum: 'LAT', extremes });
        }),
    };
});

import { annotateTideWindows, MAX_TIDE_CURVES, tideFetchPlan, type RouteChip } from '../components/map/tideWindowChips';
import {
    inshoreRoutePieces,
    inshoreSegmentStates,
    routeTideDepths,
    tideLiftablePieces,
    type InshoreRouteMasks,
} from '../components/map/inshoreRouteState';
import { TIDE_CURVE_MAX_DAYS } from '../services/TideHeightService';
import type { ShallowRunInfo } from '../services/engine/types';
import type mapboxgl from 'mapbox-gl';

const NEED_M = 2.9;
const all = (n: number, v: boolean): boolean[] => new Array(n).fill(v);

// Three 1.5 m stretches in three 0.25° buckets (-27.25,153 / -27.25,153.5 /
// -27.25,153.75), deep water between.
const r: InshoreRouteMasks = {
    polyline: [
        [153.0, -27.3],
        [153.01, -27.3],
        [153.49, -27.3],
        [153.5, -27.3],
        [153.74, -27.3],
        [153.75, -27.3],
    ],
    cautionMask: [true, false, true, false, true],
    canalMask: all(5, false),
    channelMask: all(5, false),
    offshoreMask: all(5, false),
    chartedShallowMask: [true, false, true, false, true],
    landPaintConflictMask: all(5, false),
    tideDepthM: [1.5, null, 1.5, null, 1.5],
};
const states = () => inshoreSegmentStates(r)!;
const liftable = () => tideLiftablePieces(r.polyline, states(), [], routeTideDepths(r), NEED_M);
const run = (seg: number, lon: number, lengthM = 990): ShallowRunInfo => ({
    startSeg: seg,
    endSeg: seg,
    lengthM,
    minDepthM: 1.5,
    midLat: -27.3,
    midLon: lon,
    minAtLat: -27.3,
    minAtLon: lon,
});

describe('tideFetchPlan — one curve per bucket, the most shallow water first', () => {
    it('asks for each bucket the shallow water lies in, once', () => {
        const plan = tideFetchPlan([run(0, 153.005), run(2, 153.495), run(4, 153.745)], liftable());
        expect(plan.map((p) => p.bucket).sort()).toEqual(['-27.25,153', '-27.25,153.5', '-27.25,153.75']);
    });

    it(`at most ${MAX_TIDE_CURVES}, heaviest first`, () => {
        const runs = [0, 1, 2, 3, 4, 5].map((k) => run(0, 153 + k * 0.25, 100 * (k + 1)));
        const plan = tideFetchPlan(runs, []);
        expect(plan).toHaveLength(MAX_TIDE_CURVES);
        expect(plan[0].bucket).toBe('-27.25,154.25');
    });
});

describe('annotateTideWindows — each place by its own tide, over 14 days', () => {
    it('fetches one 14-day curve per bucket, and colours each stretch by its own', async () => {
        h.calls.length = 0;
        h.rangeByBucket.clear();
        h.rangeByBucket.set('-27.25,153', 2.5);
        h.rangeByBucket.set('-27.25,153.5', 1.0);
        // -27.25,153.75: no tide station answers.
        const markers: mapboxgl.Marker[] = [];
        let drawnWith: ((lon: number, lat: number) => number | null) | null = null;
        await annotateTideWindows({
            map: {} as mapboxgl.Map,
            runs: [run(0, 153.005), run(2, 153.495), run(4, 153.745)],
            draftM: 2.4,
            needM: NEED_M,
            departureMs: h.DEPART_MS,
            // The clock (decision 11 fix-up, 2026-10-01: tops are read from
            // the later of now and the departure) — the test's own.
            nowMs: h.DEPART_MS,
            isStale: () => false,
            markers,
            liftable: liftable(),
            onTide: (highestAt) => {
                drawnWith = highestAt;
                return inshoreRoutePieces(r.polyline, states(), [], [], {
                    depthM: routeTideDepths(r),
                    needM: NEED_M,
                    highestM: null,
                    highestAt,
                });
            },
        });
        // One fetch per bucket, each asking for the app's 14 days.
        expect(h.calls).toHaveLength(3);
        for (const c of h.calls) expect(c[4]).toEqual({ days: TIDE_CURVE_MAX_DAYS });
        expect(TIDE_CURVE_MAX_DAYS).toBe(14);
        // The line was drawn from each place's own top.
        expect(drawnWith).not.toBeNull();
        const at = drawnWith as unknown as (lon: number, lat: number) => number | null;
        expect(at(153.005, -27.3)).toBeCloseTo(2.5, 6);
        expect(at(153.495, -27.3)).toBeCloseTo(1.0, 6);
        expect(at(153.745, -27.3)).toBeNull();
        const texts = markers.map((m) => (m as unknown as { el: HTMLElement }).el.textContent);
        expect(texts[0]).toMatch(/^clears /);
        // RE-PINNED 14 → 13 days (decision 11 fix-up, 2026-10-01): the top is
        // read from the departure on; the curve's first day (from yesterday
        // 00:00, the proxy's anchor) is past.
        expect(texts[1]).toBe('no tide in 13 days clears it — needs +1.4 m, highest 1.0 m');
        expect(texts[2]).toBe('tide times not loaded here — needs +1.4 m');
    });

    it('no curve anywhere: nothing redrawn, every stretch red with "no tide data"', async () => {
        h.calls.length = 0;
        h.rangeByBucket.clear();
        const markers: mapboxgl.Marker[] = [];
        const onTide = vi.fn();
        await annotateTideWindows({
            map: {} as mapboxgl.Map,
            runs: [run(0, 153.005)],
            draftM: 2.4,
            needM: NEED_M,
            departureMs: h.DEPART_MS,
            isStale: () => false,
            markers,
            liftable: liftable().slice(0, 1),
            onTide,
        });
        expect(onTide).not.toHaveBeenCalled();
        const chips = markers.map((m) => (m as unknown as { el: HTMLElement }).el.textContent);
        expect(chips).toEqual(['no tide data — needs +1.4 m'] satisfies RouteChip['text'][]);
    });
});
