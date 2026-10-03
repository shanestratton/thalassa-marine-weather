/**
 * The renderer's BACKSTOP (round-3 review, 2026-09-30).
 *
 * The grid used to let OSM water (a synthetic 10 m) outrank the chart's own
 * S-57 band, so ~2.9 km of every Newport → Brisbane River route crossed the
 * river mouth's charted drying bank (ENB5 DEPARE -2.2..0) with cautionMask
 * false: the shallow sampler only looked at caution segments, so no run, no
 * chip, and the renderer drew it as a yellow marked channel. navGrid Pass 1
 * no longer lets OSM water hide a chart band (osmWaterNeverDeepens.test.ts);
 * this is the second line of defence: the sampler reads EVERY segment, and
 * wherever the finest S-57 survey charts water shallower than draft + UKC on a
 * segment the grid did not flag, that stretch is red — cut at the band's own
 * edges — with a run (so a tide chip) like any caution. Since owner decision
 * 10 (2026-09-30) it is needs-tide amber instead where some tide clears it.
 *
 * Re-pinned 2026-10-03 (the real-chart check): every segment keeps its
 * clearance from the shallow bands too, so the 30 m either side of the drying
 * bank — inside the clearance the router keeps from water that dries — is
 * drawn with it: two `near` spans flank the bank's own, coloured by the same
 * band's depth (tests/engine/clearanceStretch.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { collectShallowRuns } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import type { InshoreLayers } from '../../services/engine/types';
import { inshoreRoutePieces, inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { routeChipPlan } from '../../components/map/tideWindowChips';

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

// West 10 m | 400 m of charted DRYING bank (-2.2) | east 10 m, all one rank;
// OSM water over the lot (as the Brisbane River's multipolygon lies over the
// mouth). A 3-vertex route runs straight through: segment 0 wholly deep,
// segment 1 crosses the bank in its middle.
const W = 153.7;
const layers: InshoreLayers = {
    DEPARE: fc(
        rect(W, -27.01, W + 0.02, -26.99, { acronym: 'DEPARE', DRVAL1: 10, _scaleRank: 5566 }),
        rect(W + 0.02, -27.01, W + 0.024, -26.99, { acronym: 'DEPARE', DRVAL1: -2.2, _scaleRank: 5566 }),
        rect(W + 0.024, -27.01, W + 0.05, -26.99, { acronym: 'DEPARE', DRVAL1: 10, _scaleRank: 5566 }),
        rect(W, -27.01, W + 0.05, -26.99, { natural: 'water', water: 'river', DRVAL1: 10 }),
    ),
} as InshoreLayers;
const polyline: [number, number][] = [
    [W + 0.002, -27],
    [W + 0.012, -27],
    [W + 0.045, -27],
];
const grid = buildNavGrid(layers, [W - 0.01, -27.02, W + 0.06, -26.98], 50, 2.4, 0.2, 30);

describe('the backstop: charted-shallow water on a segment the grid did not flag', () => {
    // As if the grid had not flagged it (the old OSM rule, a 50 m cell, a splice).
    // The router's hazard mask (no charted hazard here) comes with it since
    // the round-4 review (2026-09-30): without one no stretch is the tide's
    // to lift (tideLiftable, below).
    const out = collectShallowRuns({
        layers,
        grid,
        polyline,
        caution: [false, false],
        draftM: 2.4,
        safetyM: 0.2,
        hazardMask: [false, false],
    });

    /** The bank's own stretch: charted-shallow water under the line. */
    const own = (spans: typeof out.chartedShallowSpans) => spans.filter((x) => !x.near);
    /** 30 m of segment 1 (W+0.012 → W+0.045, ~3.27 km), as a fraction. */
    const kx = 111_320 * Math.cos((27 * Math.PI) / 180);
    const tOf30 = 30 / (0.033 * kx);

    it('is found, cut at the band’s own edges, with its charted depth', () => {
        expect(own(out.chartedShallowSpans)).toHaveLength(1);
        const s = own(out.chartedShallowSpans)[0];
        expect(s.startSeg).toBe(1);
        expect(s.endSeg).toBe(1);
        expect(s.minDepthM).toBeCloseTo(-2.2, 5);
        // The bank is W+0.020..W+0.024 on a segment W+0.012..W+0.045.
        expect(s.startT).toBeCloseTo(0.008 / 0.033, 4);
        expect(s.endT).toBeCloseTo(0.012 / 0.033, 4);
        // Whole-segment masks stay caution-only (no 3 km of red for 400 m).
        expect(out.chartedShallowMask).toEqual([false, false]);
        // 2026-10-03: and the 30 m either side, the bank's clearance.
        const near = out.chartedShallowSpans.filter((x) => x.near);
        expect(near.map((x) => [x.minDepthM, x.near!.requiredM, x.near!.clearanceM])).toEqual([
            [-2.2, 30, 0],
            [-2.2, 30, 0],
        ]);
        expect(near[0].startT).toBeCloseTo(s.startT - tOf30, 3);
        expect(near[0].endT).toBeCloseTo(s.startT, 9);
        expect(near[1].startT).toBeCloseTo(s.endT, 9);
        expect(near[1].endT).toBeCloseTo(s.endT + tOf30, 3);
    });

    it('ships a run — so a tide chip — for it, anchored on the bank', () => {
        expect(out.shallowRuns).toHaveLength(1);
        const run = out.shallowRuns[0];
        expect(run.minDepthM).toBeCloseTo(-2.2, 5);
        expect(run.startSeg).toBe(1);
        expect(run.startT).toBeCloseTo(0.008 / 0.033, 4);
        expect(run.endT).toBeCloseTo(0.012 / 0.033, 4);
        expect(run.lengthM).toBeGreaterThan(350);
        expect(run.lengthM).toBeLessThan(450);
        expect(run.midLon).toBeGreaterThan(W + 0.02);
        expect(run.midLon).toBeLessThan(W + 0.024);
        expect(routeChipPlan(out.shallowRuns, []).windowed).toHaveLength(1);
    });

    it('draws red over a marked channel’s yellow there — and only there', () => {
        const states = inshoreSegmentStates({
            polyline,
            cautionMask: [false, false],
            canalMask: [false, false],
            channelMask: [true, true],
            offshoreMask: [false, false],
            chartedShallowMask: out.chartedShallowMask,
        });
        expect(states).toEqual(['channel', 'channel']);
        const pieces = inshoreRoutePieces(polyline, states!, [], out.chartedShallowSpans);
        expect(pieces.map((p) => p.state)).toEqual(['channel', 'danger', 'channel']);
        const red = pieces[1].coordinates;
        // The bank, and its 30 m clearance either side (2026-10-03).
        expect(red[0][0]).toBeCloseTo(W + 0.02 - 30 / kx, 6);
        expect(red[red.length - 1][0]).toBeCloseTo(W + 0.024 + 30 / kx, 6);
        // Red beats decision 9's amber too.
        const amber = [
            {
                reason: 'survey-ungraded' as const,
                startSeg: 0,
                startT: 0,
                endSeg: 1,
                endT: 1,
                lengthM: 4000,
                catzoc: null,
                midLat: -27,
                midLon: W + 0.02,
            },
        ];
        expect(inshoreRoutePieces(polyline, states!, amber, out.chartedShallowSpans).map((p) => p.state)).toEqual([
            'survey',
            'danger',
            'survey',
        ]);
        // Owner decision 10 (2026-09-30: "Amber if a tide clears it"): the
        // bank dries 2.2 m, so it needs +4.8 m of tide (draft 2.4 + 0.2 UKC).
        // A 2.5 m tide never gives it: red. Only a tide that reaches 4.8 m
        // would draw it needs-tide amber.
        const withTide = (highestM: number) =>
            inshoreRoutePieces(polyline, states!, [], out.chartedShallowSpans, {
                depthM: null,
                needM: 2.6,
                highestM,
            }).map((p) => p.state);
        expect(withTide(2.5)).toEqual(['channel', 'danger', 'channel']);
        expect(withTide(4.8)).toEqual(['channel', 'tide', 'channel']);
    });

    it('the grid itself now flags that bank (OSM water no longer hides it)', () => {
        const x = Math.floor((W + 0.022 - grid.minLon) / grid.dLon);
        const y = Math.floor((-27 - grid.minLat) / grid.dLat);
        expect(grid.cells[y * grid.width + x]).toBe(-1); // CAUTION
        expect(grid.shallowDepthM?.[y * grid.width + x]).toBeCloseTo(-2.2, 5);
    });

    it('nothing is added where the chart charts deep water', () => {
        const deep = collectShallowRuns({
            layers,
            grid,
            polyline: [
                [W + 0.002, -27],
                [W + 0.018, -27],
            ],
            caution: [false],
            draftM: 2.4,
            safetyM: 0.2,
        });
        expect(deep.chartedShallowSpans).toEqual([]);
        expect(deep.shallowRuns).toEqual([]);
    });
});

// Round-4 review (2026-09-30): a backstop stretch drew amber whenever its
// band's depth cleared, though the tide depth of a caution segment already
// kept the red of a charted hazard's buffer, of decision-1 water and of a
// caller that sends no hazard mask. MEASURED on a promoted route: a drying
// rock 15 m off the line inside a 60 m-wide 1.5 m band — the 59 m stretch
// went from red to amber, its window from the band's 1.5 m, not the rock.
describe('a backstop stretch is the tide’s to lift only when its depth alone is its red', () => {
    const run = (extra: { hazardMask?: boolean[]; wetConflictUnder?: boolean } = {}) => {
        const g = extra.wetConflictUnder ? { ...grid, wetConflict: new Uint8Array(grid.wetConflict ?? []) } : grid;
        if (extra.wetConflictUnder) {
            // Decision-1 water under the bank (a finer band under a coarser
            // chart's land paint), as navGrid stamps it.
            for (let x = W + 0.0202; x < W + 0.0238; x += 0.0002) {
                const cx = Math.floor((x - g.minLon) / g.dLon);
                const cy = Math.floor((-27 - g.minLat) / g.dLat);
                (g.wetConflict as Uint8Array)[cy * g.width + cx] = 1;
            }
        }
        return collectShallowRuns({
            layers,
            grid: g,
            polyline,
            caution: [false, false],
            draftM: 2.4,
            safetyM: 0.2,
            ...(extra.hazardMask ? { hazardMask: extra.hazardMask } : {}),
        });
    };
    const drawn = (spans: ReturnType<typeof run>['chartedShallowSpans']) =>
        inshoreRoutePieces(polyline, ['channel', 'channel'], [], spans, {
            depthM: null,
            needM: 2.6,
            highestM: 4.8,
        }).map((p) => p.state);

    it('charted depth alone: liftable, amber where the tide clears it', () => {
        const out = run({ hazardMask: [false, false] });
        // The bank's own stretch and its clearance either side (2026-10-03).
        expect(out.chartedShallowSpans.map((x) => x.tideLiftable)).toEqual([true, true, true]);
        expect(drawn(out.chartedShallowSpans)).toEqual(['channel', 'tide', 'channel']);
    });

    it('inside a charted hazard’s buffer: red whatever the tide', () => {
        const out = run({ hazardMask: [false, true] });
        expect(out.chartedShallowSpans.filter((x) => !x.near)).toHaveLength(1);
        expect(out.chartedShallowSpans.map((x) => x.tideLiftable)).toEqual([undefined, undefined, undefined]);
        expect(drawn(out.chartedShallowSpans)).toEqual(['channel', 'danger', 'channel']);
        expect(out.shallowRuns[0].nearHazard).toBe(true);
    });

    it('no hazard mask from the caller: red whatever the tide (fail-safe)', () => {
        const out = run();
        expect(out.chartedShallowSpans.map((x) => x.tideLiftable)).toEqual([undefined, undefined, undefined]);
        expect(drawn(out.chartedShallowSpans)).toEqual(['channel', 'danger', 'channel']);
    });

    it('over decision-1 water: red whatever the tide, and the run says the charts disagree', () => {
        const out = run({ hazardMask: [false, false], wetConflictUnder: true });
        // The bank's clearance either side too: the charts dispute the bank.
        expect(out.chartedShallowSpans.map((x) => x.tideLiftable)).toEqual([undefined, undefined, undefined]);
        expect(drawn(out.chartedShallowSpans)).toEqual(['channel', 'danger', 'channel']);
        expect(out.shallowRuns[0].chartsDisagree).toBe(true);
    });

    it('an older or cloud result without the flag is red whatever the tide', () => {
        const legacy = [{ startSeg: 1, startT: 0.3, endSeg: 1, endT: 0.4, minDepthM: 1.5 }];
        expect(drawn(legacy)).toEqual(['channel', 'danger', 'channel']);
    });
});
