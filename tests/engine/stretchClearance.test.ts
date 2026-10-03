/**
 * A segment drawn red over its shallow stretch alone (CAUTION_WHY.STRETCH,
 * G2 2026-10-04) keeps the rest of its line its own colour — so the rest of
 * it is measured for a shallow band's clearance as a clean segment's is
 * (G2 review, 2026-10-04).
 *
 * The review's probe: a line runs 0–5 m north of a 0–2 m band's edge for
 * about 920 m, then 1 m into the band for its last 17%. Draft 2.4 m, safety
 * 0.5 m, no tide loaded. The grid flags it caution (its cells are the band's),
 * the exact reading finds the band under its last 17%, and it became SHALLOW |
 * STRETCH: red over the 17%, GREEN over the 83% that runs 5 m from a band the
 * router itself keeps 30 m clear of (DRVAL2 2 < 2.9 m: the cliff clearance).
 * A caution segment's clearance counted only bands that DRY, so nothing
 * measured that green. The same water was red in every other case: at
 * 85dc7e07 (the whole segment), on a clean segment and on a GRID_ONLY one.
 *
 * Synthetic water off an invented coast — no chart data.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { collectShallowRuns } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import { latLonToGrid } from '../../services/engine/geometry';
import { CAUTION } from '../../services/engine/constants';
import { CAUTION_WHY, nearSpanBlocks, type InshoreLayers } from '../../services/engine/types';
import { inshoreRoutePieces, inshoreSegmentStates } from '../../components/map/inshoreRouteState';

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

const W = 170.0;
const SOUTH = -41.006;
const D_LAT = 50 / 111_320;
const EDGE = SOUTH + 12.7 * D_LAT;
const M = 1 / 111_320;
const DRAFT = 2.4;
const SAFETY = 0.5;
// 10–15 m water to the north; a 0–2 m band (it never clears the keel) south.
const layers = {
    DEPARE: fc(
        rect(W, EDGE, W + 0.02, -40.99, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15, _scaleRank: 4505 }),
        rect(W, -41.002, W + 0.02, EDGE, { acronym: 'DEPARE', DRVAL1: 0, DRVAL2: 2, _scaleRank: 4505 }),
    ),
} as InshoreLayers;
const grid = buildNavGrid(layers, [W - 0.005, SOUTH, W + 0.025, -40.986], 50, DRAFT, SAFETY, 30);

/** 5 m north of the band's edge, then 1 m into the band for its last 17%. */
const crossing: [number, number][] = [
    [W + 0.002, EDGE + 5 * M],
    [W + 0.016, EDGE - 1 * M],
];

/** As the engine flags it: caution where the line crosses a CAUTION cell. */
const cellCaution = (pl: [number, number][]): boolean[] =>
    pl.slice(0, -1).map(([lonA, latA], i) => {
        const [lonB, latB] = pl[i + 1];
        for (let k = 0; k <= 80; k++) {
            const t = k / 80;
            const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
            if (grid.cells[y * grid.width + x] === CAUTION) return true;
        }
        return false;
    });

const run = (caution: boolean[], extra: Partial<Parameters<typeof collectShallowRuns>[0]> = {}) =>
    collectShallowRuns({
        layers,
        grid,
        polyline: crossing,
        caution,
        draftM: DRAFT,
        safetyM: SAFETY,
        hazardMask: [false],
        ...extra,
    });
const drawn = (r: ReturnType<typeof run>, caution: boolean[], tide?: { highestM: number }) => {
    const states = inshoreSegmentStates({
        polyline: crossing,
        cautionMask: caution,
        canalMask: [false],
        channelMask: [false],
        offshoreMask: [false],
        ...r,
    })!;
    return inshoreRoutePieces(
        crossing,
        states,
        [],
        r.chartedShallowSpans,
        tide ? { depthM: r.tideDepthM, needM: DRAFT + SAFETY, highestM: tide.highestM } : undefined,
    ).map((p) => p.state);
};

describe('a STRETCH segment: the rest of its line is measured as a clean segment is', () => {
    const caution = cellCaution(crossing);

    it('the reproduction: the grid flags it caution, and it is drawn over its stretch (STRETCH)', () => {
        expect(caution).toEqual([true]);
        const r = run(caution);
        expect(r.cautionWhy).toEqual([CAUTION_WHY.SHALLOW | CAUTION_WHY.STRETCH]);
    });

    it('its approach 5 m off the 0–2 m band is a near stretch (30 m kept), red with no tide loaded', () => {
        const r = run(caution);
        const near = r.chartedShallowSpans.filter((s) => s.near);
        expect(near.length).toBe(1);
        expect(near[0].startT).toBe(0);
        expect(near[0].endT).toBeGreaterThan(0.8);
        expect(near[0].near!.requiredM).toBe(30);
        expect(near[0].near!.clearanceM).toBeLessThan(6);
        // A tide could clear the band (0 m charted), but none was loaded to
        // prove it: red for Save and Plan My Day (owner decision 10).
        expect(near[0].tideLiftable).toBe(true);
        expect(near[0].tideUnknown).toBe(true);
        expect(near.every(nearSpanBlocks)).toBe(true);
        // Its crossing is still the band's own stretch, the tide's to lift.
        const own = r.chartedShallowSpans.filter((s) => !s.near);
        expect(own.length).toBe(1);
        expect(own[0].endT).toBe(1);
        expect(own[0].tideLiftable).toBe(true);
    });

    it('drawn red end to end — as the same line on a clean segment, and as at 85dc7e07', () => {
        expect(drawn(run(caution), caution)).toEqual(['danger']);
        expect(drawn(run([false]), [false])).toEqual(['danger']);
    });

    it('a tide the route knows clears the band (0 m + 3 m ≥ 2.9 m): amber, saveable for its approach', () => {
        const [lon, lat] = crossing[0];
        const r = run(caution, { tideCeilings: [{ lat, lon, highestM: 3, days: 1 }] });
        const near = r.chartedShallowSpans.filter((s) => s.near);
        expect(near.length).toBe(1);
        expect(near[0].tideLiftable).toBe(true);
        expect(near[0].tideUnknown).toBeUndefined();
        expect(near.some(nearSpanBlocks)).toBe(false);
        expect(drawn(r, caution, { highestM: 3 })).toEqual(['tide']);
    });

    it('a tide the route knows cannot clear it (0 m + 2 m < 2.9 m): red, refused', () => {
        const [lon, lat] = crossing[0];
        const r = run(caution, { tideCeilings: [{ lat, lon, highestM: 2, days: 1 }] });
        const near = r.chartedShallowSpans.filter((s) => s.near);
        expect(near.length).toBe(1);
        expect(near[0].tideLiftable).toBeUndefined();
        expect(near.every(nearSpanBlocks)).toBe(true);
    });

    it('a STRETCH segment 40 m off the band on its way in adds no near stretch beyond the 30 m', () => {
        // In 10 m water, 40 m north of the edge, then into the band at its end.
        const far: [number, number][] = [
            [W + 0.002, EDGE + 40 * M],
            [W + 0.003, EDGE + 40 * M],
            [W + 0.004, EDGE - 1 * M],
        ];
        const r = collectShallowRuns({
            layers,
            grid,
            polyline: far,
            caution: cellCaution(far),
            draftM: DRAFT,
            safetyM: SAFETY,
            hazardMask: [false, false],
        });
        const near = r.chartedShallowSpans.filter((s) => s.near);
        // Only the last metres of the approach, inside 30 m of the edge.
        expect(near.every((s) => s.startSeg === 1)).toBe(true);
    });
});
