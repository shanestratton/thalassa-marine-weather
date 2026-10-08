/**
 * Near stretches, round-3 fix-up (2026-10-03): what refuses, what is named,
 * what is found and what a saved plan keeps.
 *
 * 61e36ccb measured every segment against the shallow bands round it and
 * drew the stretch inside the clearance red or amber. The review found:
 *   1. Save and Plan My Day refused a route with ANY near stretch, even one
 *      beside a 1 m band a tide clears (amber under owner decision 10). Save
 *      refuses only a RED one now: no tide lifts it, the route's tide ceiling
 *      proves none clears the band, or no tide was loaded for the place to
 *      prove one does (nearSpanBlocks; the fix-up review's high finding — a
 *      line 1 m from a reef drying 3 m, drawn red 'no tide data', was
 *      saveable). (Plan My Day refused an amber one too until build 124,
 *      when the planner stopped routing; that case went with it.)
 *   2. Inside water the marks own (a dredged channel, a fairway, a mark
 *      pair's gate) a near stretch was neither drawn nor named — Tangalooma's
 *      last leg passed 27.4 m from a 0–2 m band where 30 m is kept, inside its
 *      channel. It is a CHANNEL EDGE now: amber, named, never a refusal —
 *      unless a charted hazard's buffer makes it red, or the line comes
 *      within 5 m of the band (CHANNEL_EDGE_FLOOR_M; fix-up review).
 *   3. nearShallowBand found a band only through the 50 m cells whose
 *      centres it owns, so the any-angle string pull chorded past a thin
 *      drying strip holding no centre. It reads the bands' own extents too.
 *   6. A plan saved from the voyage form keeps the stretches themselves, and
 *      says again what the route said (red, amber, channel edge) — counting
 *      a stretch the engine cut into pieces once (fix-up review).
 *
 * Synthetic water off an invented coast — no chart data.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/piTls', () => ({
    piRequest: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => false,
}));
vi.mock('../../services/enc/EncCellMetadata', () => ({ cellsForBBox: async () => [], listCells: () => [] }));
vi.mock('../../services/enc/EncCellStore', () => ({ loadCellGeoJSON: async () => null }));
vi.mock('../../services/PiCacheService', () => ({
    piCache: { isAvailable: () => false, baseUrl: 'http://test.invalid' },
}));
vi.mock('../../services/OsmRouteOverlayService', () => ({ getOsmRouteOverlay: async () => null }));

import type { Feature, FeatureCollection } from 'geojson';
import { CHANNEL_EDGE_FLOOR_M, collectShallowRuns, nearShallowBand } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import {
    forEachCellOnSegment,
    gridToLatLon,
    haversineM,
    segmentGeometryDistanceM,
} from '../../services/engine/geometry';
import { CAUTION } from '../../services/engine/constants';
import { chartAreaIndexFor } from '../../services/routing/leadLandClip';
import {
    nearSpanBlocks,
    type ChartedShallowSpan,
    type InshoreLayers,
    type NavGrid,
    type TideCeiling,
} from '../../services/engine/types';
import { inshoreRoutePieces, inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { routeRedStretches } from '../../components/map/routeRedReasons';
import {
    inshoreRouteCaveats,
    inshoreRouteNotice,
    nearShallowSummary,
    savedInshoreRouteCaveats,
} from '../../components/map/inshoreRouteNotice';
import { evaluateAutoroutingProposalSave } from '../../services/autoroutingProposalSave';
import { inshoreRouteToGeoJSON } from '../../services/InshoreRouter';
import { lineExposureReader, LINE_STATE, pullTaut, chartMarkPoints } from '../../services/engine/stringPull';
import type { AutoroutingTrialRoute } from '../../types/autorouting';

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const box = (x0: number, y0: number, x1: number, y1: number): number[][] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
];

const W = 170.0;
const SOUTH = -41.006;
const D_LAT = 50 / 111_320;
const M_LAT = 1 / 111_320;
const RANK = 4505;
const DRAFT = 2.4;
const SAFETY = 0.5;
const FLOOR = DRAFT + SAFETY;
const BBOX: [number, number, number, number] = [W, SOUTH, W + 0.03, SOUTH + 0.012];
const KX = 111_320 * Math.cos((41 * Math.PI) / 180);
const NEAR_SAVE =
    'Part of this route passes too close to water charted shallower than this boat needs. It cannot be saved.';

type Band = { x0: number; y0: number; x1: number; y1: number; d1: number; d2: number; dredged?: boolean };

/** 10–15 m water over the grid with bands let into it (holes); a `dredged`
 *  one as an S-57 DRGARE — water navGrid Pass 4 prefers (the marks own it). */
function charts(...bands: Band[]): InshoreLayers {
    const props = (b: { d1: number; d2: number; dredged?: boolean }) => ({
        acronym: b.dredged ? 'DRGARE' : 'DEPARE',
        DRVAL1: b.d1,
        DRVAL2: b.d2,
        _scaleRank: RANK,
    });
    const feature = (b: Band): Feature => ({
        type: 'Feature',
        properties: props(b),
        geometry: { type: 'Polygon', coordinates: [box(b.x0, b.y0, b.x1, b.y1)] },
    });
    return {
        DEPARE: fc(
            {
                type: 'Feature',
                properties: props({ d1: 10, d2: 15 }),
                geometry: {
                    type: 'Polygon',
                    coordinates: [box(...BBOX), ...bands.map((b) => box(b.x0, b.y0, b.x1, b.y1).reverse())],
                },
            },
            ...bands.filter((b) => !b.dredged).map(feature),
        ),
        DRGARE: fc(...bands.filter((b) => b.dredged).map(feature)),
    } as InshoreLayers;
}

/** The band's south edge 1 m below the row 12 / 13 boundary (clearanceStretch). */
const EDGE = SOUTH + 13 * D_LAT - 1 * M_LAT;
const X0 = W + 0.01;
const X1 = W + 0.0136;
const REEF: Band = { x0: X0, y0: EDGE, x1: X1, y1: EDGE + 0.0018, d1: -3, d2: 0 };
const SHOAL: Band = { ...REEF, d1: 2, d2: 5 };
const lineOff = (offM: number): [number, number][] => [
    [W + 0.004, EDGE - offM * M_LAT],
    [W + 0.02, EDGE - offM * M_LAT],
];

const cautionOf = (grid: NavGrid, line: readonly [number, number][]): boolean[] =>
    line.slice(0, -1).map((a, i) => {
        let red = false;
        forEachCellOnSegment(grid, a, line[i + 1], (idx) => {
            const v = grid.cells[idx];
            if (Number.isNaN(v) || v === CAUTION) red = true;
        });
        return red;
    });

/** A tide ceiling over the whole grid (the 0.25° bucket of its centre). */
const ceiling = (highestM: number): TideCeiling[] => [{ lat: SOUTH + 0.006, lon: W + 0.015, highestM, days: 14 }];

const lengthOf = (cs: readonly (readonly [number, number])[]) =>
    cs.slice(1).reduce((m, p, i) => m + haversineM(cs[i][1], cs[i][0], p[1], p[0]), 0);

function read(
    layers: InshoreLayers,
    line: [number, number][],
    opts: { highestM?: number; tideCeilings?: TideCeiling[]; hazardMask?: boolean[] | null } = {},
) {
    const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
    const caution = cautionOf(grid, line);
    const out = collectShallowRuns({
        layers,
        grid,
        polyline: line,
        caution,
        draftM: DRAFT,
        safetyM: SAFETY,
        ...(opts.hazardMask === null ? {} : { hazardMask: opts.hazardMask ?? caution.map(() => false) }),
        ...(opts.tideCeilings ? { tideCeilings: opts.tideCeilings } : {}),
    });
    const none = caution.map(() => false);
    const masks = {
        polyline: line,
        cautionMask: caution,
        canalMask: none,
        channelMask: none,
        offshoreMask: none,
        chartedShallowMask: out.chartedShallowMask,
        landPaintConflictMask: out.landPaintConflictMask,
        cautionWhy: out.cautionWhy,
        cautionDepthM: out.cautionDepthM,
        cautionNearShallow: out.cautionNearShallow,
        tideDepthM: out.tideDepthM,
    };
    const states = inshoreSegmentStates(masks)!;
    const tide =
        opts.highestM === undefined ? undefined : { depthM: out.tideDepthM, needM: FLOOR, highestM: opts.highestM };
    const pieces = inshoreRoutePieces(line, states, [], out.chartedShallowSpans, tide);
    const route = {
        id: 'r',
        provider: 'Thalassa',
        coordinates: line,
        warnings: [],
        createdAt: '2026-10-03T00:00:00.000Z',
        engine: {
            stateMask: states,
            cautionMask: caution,
            canalMask: none,
            chartedShallowMask: out.chartedShallowMask,
            landPaintConflictMask: out.landPaintConflictMask,
            cautionWhy: out.cautionWhy,
            chartedShallowSpans: out.chartedShallowSpans,
            hardLandAwayM: 0,
            backstop: 'verified',
            cellsUsed: ['T'],
            distanceNM: 1,
            elapsedMs: 1,
        },
    } as unknown as AutoroutingTrialRoute;
    return {
        grid,
        caution,
        out,
        near: out.chartedShallowSpans.filter((s) => s.near),
        drawn: pieces.map((p) => [p.state, Math.round(lengthOf(p.coordinates))] as const),
        words: routeRedStretches(
            line,
            pieces,
            { ...masks, chartedShallowSpans: out.chartedShallowSpans, tideNeedM: FLOOR },
            tide,
        ).map((s) => s.why),
        caveats: inshoreRouteCaveats({ nearShallow: nearShallowSummary(out.chartedShallowSpans) }),
        save: evaluateAutoroutingProposalSave(route, null, DRAFT, false),
    };
}

describe('1. Save refuses only a RED near stretch', () => {
    it('a 2–5 m shoal 8 m off that the tide the route knows clears (amber): saved with its note', () => {
        const r = read(charts(SHOAL), lineOff(8), { tideCeilings: ceiling(1.0) });
        expect(r.near).toHaveLength(1);
        expect(r.near[0].tideLiftable).toBe(true);
        expect(r.near[0].tideUnknown).toBeUndefined();
        expect(nearSpanBlocks(r.near[0])).toBe(false);
        // The next gate (the leg review), not the near stretch.
        expect(r.save).toEqual({ eligible: false, reason: 'Finish current chart checks before saving.' });
        expect(r.caveats).toEqual([
            'This route passes 8 m from water charted 2.0 m — closer than the 10 m the router keeps off it. Check the chart there before you go.',
        ]);
        // Drawn amber where the tide clears the shoal, red where it does not.
        expect(read(charts(SHOAL), lineOff(8), { highestM: 1 }).drawn.map(([st]) => st)).toEqual([
            'green',
            'tide',
            'green',
        ]);
    });

    it('…red at a 0.5 m tide top: 2.0 m + 0.5 m < 2.9 m, no tide the app knows clears it', () => {
        const never = read(charts(SHOAL), lineOff(8), { tideCeilings: ceiling(0.5) });
        expect(never.near).toHaveLength(1);
        expect(never.near[0].tideLiftable).toBeUndefined();
        expect(nearSpanBlocks(never.near[0])).toBe(true);
        expect(never.save).toEqual({ eligible: false, reason: NEAR_SAVE });
        expect(never.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
    });

    it('a reef drying 3 m 4 m off: red and refused once a ceiling proves no tide clears it', () => {
        const r = read(charts(REEF), lineOff(4), { tideCeilings: ceiling(2.5) });
        expect(r.near).toHaveLength(1);
        expect(nearSpanBlocks(r.near[0])).toBe(true);
        expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
    });

    it('NO tide loaded for the place: red for Save, as the map draws it (owner decision 10)', () => {
        // The fix-up review's probe: a reef drying 3 m 4 m and 1 m off, with
        // no tide ceiling, was saveable and planned amber while the map drew
        // it red 'no tide data'. 3e3a3603 refused it; so does this.
        for (const [band, off, words] of [
            [REEF, 4, 'passes 4 m from water charted to dry 3.0 m'],
            [REEF, 1, 'runs on the edge of water charted to dry 3.0 m'],
            [SHOAL, 8, 'passes 8 m from water charted 2.0 m'],
        ] as const) {
            const r = read(charts(band), lineOff(off));
            expect(r.near).toHaveLength(1);
            // The map may still lift it under a live tide; nothing proves one here.
            expect(r.near[0].tideLiftable).toBe(true);
            expect(r.near[0].tideUnknown).toBe(true);
            expect(nearSpanBlocks(r.near[0])).toBe(true);
            expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
            expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
            expect(r.caveats[0]).toContain(words);
        }
    });

    it('red whatever the tide inside a charted hazard’s buffer, or with no hazard mask to prove otherwise', () => {
        for (const hazardMask of [[true], null]) {
            const r = read(charts(SHOAL), lineOff(8), { hazardMask, tideCeilings: ceiling(1.0) });
            expect(r.near).toHaveLength(1);
            expect(r.near[0].tideLiftable).toBeUndefined();
            expect(nearSpanBlocks(r.near[0])).toBe(true);
            expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
        }
    });

    it('a ceiling for another place proves nothing here: the tide is unknown, so red', () => {
        const r = read(charts(SHOAL), lineOff(8), {
            tideCeilings: [{ lat: -27.4, lon: 153.2, highestM: 0.2, days: 14 }],
        });
        expect(r.near[0].tideLiftable).toBe(true);
        expect(r.near[0].tideUnknown).toBe(true);
        expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
    });
});

/** Row 12's south edge (the grid starts at SOUTH). */
const ROW12 = SOUTH + 12 * D_LAT;

describe('2. a near stretch inside a channel the marks own is a CHANNEL EDGE: amber, named, saved', () => {
    // A 50 m dredged channel (5 m) between banks drying 1.5 m, and a line down
    // its middle, 25 m from each bank (clearanceStretch's S2): the ring skips
    // channel water, so the router cannot steer off the banks there.
    const banks = (x0: number, x1: number, d1 = -1.5, d2 = 0): Band[] => [
        { x0, y0: ROW12 - 2 * D_LAT, x1, y1: ROW12, d1, d2 },
        { x0, y0: ROW12 + D_LAT, x1, y1: ROW12 + 3 * D_LAT, d1, d2 },
    ];
    const channel: Band = { x0: W + 0.004, y0: ROW12, x1: W + 0.026, y1: ROW12 + D_LAT, d1: 5, d2: 10, dredged: true };
    const line: [number, number][] = [
        [W + 0.005, ROW12 + 0.5 * D_LAT],
        [W + 0.025, ROW12 + 0.5 * D_LAT],
    ];
    const B0 = W + 0.008;
    const B1 = W + 0.022;

    it('down a dredged channel between drying banks: drawn amber over the banks, named, not refused', () => {
        const r = read(charts(...banks(B0, B1), channel), line);
        expect(r.caution).toEqual([false]);
        forEachCellOnSegment(r.grid, line[0], line[1], (idx) => expect(r.grid.preferred[idx]).toBe(1));
        // 61e36ccb: no stretch at all — neither drawn nor named.
        expect(r.near.length).toBeGreaterThan(0);
        for (const s of r.near) {
            expect(s.channelEdge).toBe(true);
            expect(s.tideLiftable).toBeUndefined();
            expect(s.near).toMatchObject({ depthM: -1.5, requiredM: 30 });
            expect(s.near!.clearanceM).toBeCloseTo(25, 1);
            expect(nearSpanBlocks(s)).toBe(false);
        }
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'edge', 'green']);
        // Its reach: the banks' length plus the 30 m capsule's chord each side.
        const reach = Math.sqrt(30 * 30 - 25 * 25);
        const banksM = (B1 - B0) * KX;
        expect(r.drawn[1][1]).toBeGreaterThan(banksM + 2 * reach - 2);
        expect(r.drawn[1][1]).toBeLessThan(banksM + 2 * reach + 2);
        expect(r.words).toEqual([]);
        expect(r.out.cautionNearShallow).toEqual([null]);
        expect(r.caveats).toEqual([
            "In the marked channel this route runs close to the edge of the channel's charted shallows: 25 m from water charted to dry 1.5 m, inside the 30 m the router keeps off it elsewhere. Keep to the middle of the channel.",
        ]);
        expect(
            inshoreRouteNotice({
                stateMaskOk: true,
                nearShallow: nearShallowSummary(r.out.chartedShallowSpans),
                ntmLockBanner: null,
            })?.title,
        ).toBe('Close to the channel edge');
        expect(r.save).toEqual({ eligible: false, reason: 'Finish current chart checks before saving.' });
    });

    it("Tangalooma's last leg: 27.4 m from a 0–2 m band in its channel is named, not silent", () => {
        // A 0–2 m band (its deep end never clears the keel: 30 m) 27.4 m off
        // a line in a dredged channel.
        const off = 27.4;
        const band: Band = {
            x0: B0,
            y0: ROW12 + 0.5 * D_LAT + off * M_LAT,
            x1: B1,
            y1: ROW12 + 3 * D_LAT,
            d1: 0,
            d2: 2,
        };
        const wide: Band = { ...channel, y1: band.y0 };
        const r = read(charts(band, wide), line);
        expect(r.near.length).toBeGreaterThan(0);
        expect(r.near.every((s) => s.channelEdge === true)).toBe(true);
        expect(Math.min(...r.near.map((s) => s.near!.clearanceM))).toBeCloseTo(off, 1);
        expect(r.near[0].near).toMatchObject({ depthM: 0, requiredM: 30 });
        expect(r.caveats[0]).toMatch(
            /^In the marked channel this route runs close to the edge of the channel's charted shallows: 27 m from water charted 0\.0 m/,
        );
        expect(r.save.reason).not.toBe(NEAR_SAVE);
    });

    it('inside a charted hazard’s buffer it is an ordinary red near stretch, and refuses', () => {
        const r = read(charts(...banks(B0, B1), channel), line, { hazardMask: [true] });
        expect(r.near.length).toBeGreaterThan(0);
        expect(r.near.every((s) => s.channelEdge !== true && nearSpanBlocks(s))).toBe(true);
        expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
    });

    it('within 5 m of the bank it is no channel edge: an ordinary near stretch, red unless a tide clears the bank', () => {
        // The fix-up review's probe: a line 1 m off a bank drying 3 m inside
        // the dredged channel, under a 0.5 m tide ceiling, was an amber
        // channel edge, saveable and planned. Serene Summer's beam is 4.9 m.
        const north: Band = { x0: B0, y0: ROW12 + D_LAT, x1: B1, y1: ROW12 + 3 * D_LAT, d1: -3, d2: 0 };
        const hug: [number, number][] = [
            [W + 0.005, ROW12 + D_LAT - 1 * M_LAT],
            [W + 0.025, ROW12 + D_LAT - 1 * M_LAT],
        ];
        for (const opts of [{ tideCeilings: ceiling(0.5) }, {}]) {
            const r = read(charts(north, channel), hug, opts);
            expect(r.caution).toEqual([false]);
            forEachCellOnSegment(r.grid, hug[0], hug[1], (idx) => expect(r.grid.preferred[idx]).toBe(1));
            const close = r.near.filter((x) => x.near!.clearanceM < CHANNEL_EDGE_FLOOR_M);
            expect(close.length).toBeGreaterThan(0);
            expect(Math.min(...close.map((x) => x.near!.clearanceM))).toBeCloseTo(1, 1);
            for (const x of close) {
                expect(x.channelEdge).toBeUndefined();
                expect(nearSpanBlocks(x)).toBe(true);
            }
            // Its approach, 5 m off and more, is still a channel edge.
            for (const x of r.near.filter((y) => y.near!.clearanceM >= CHANNEL_EDGE_FLOOR_M))
                expect(x.channelEdge).toBe(true);
            expect(r.drawn.some(([st]) => st === 'danger')).toBe(true);
            expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
        }
    });

    it('open water between the same banks (no channel) keeps its red near stretch', () => {
        const r = read(charts(...banks(B0, B1)), line, { tideCeilings: ceiling(1) });
        expect(r.near.length).toBeGreaterThan(0);
        expect(r.near.every((s) => s.channelEdge !== true)).toBe(true);
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
        expect(r.save).toEqual({ eligible: false, reason: NEAR_SAVE });
    });
});

describe('3. a band that holds no cell centre is found by its own extent', () => {
    // A 10 m × 40 m strip drying 1 m with no cell centre in it, ~5.5 m from
    // the chord a stair's run would be pulled to, and 62 m from the stair.
    const LAT = -21.4;
    const LON0 = 151.3;
    const KY = 110_540;
    const KXS = 111_320 * Math.cos((LAT * Math.PI) / 180);
    const lonLat = (xM: number, yM: number): [number, number] => [LON0 + xM / KXS, LAT + yM / KY];
    const poly = (ring: [number, number][], props: Record<string, unknown>): Feature => ({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    });
    const DEEP = poly([lonLat(-4000, -4000), lonLat(4000, -4000), lonLat(4000, 4000), lonLat(-4000, 4000)], {
        acronym: 'DEPARE',
        DRVAL1: 15,
        DRVAL2: 20,
    });
    const SBBOX = [...lonLat(-2500, -2500), ...lonLat(2500, 2500)] as [number, number, number, number];
    const g0 = buildNavGrid({ DEPARE: fc(DEEP) } as InshoreLayers, SBBOX, 50, DRAFT, SAFETY, 30);
    const start = { x: Math.floor(g0.width / 2) - 8, y: Math.floor(g0.height / 2) + 4 };
    const cellPt = (u: number, v: number): [number, number] => [
        g0.minLon + (start.x + 0.5 + u) * g0.dLon,
        g0.minLat + (start.y + 0.5 + v) * g0.dLat,
    ];
    const strip = poly([cellPt(2.6, -1.45), cellPt(3.4, -1.45), cellPt(3.4, -1.25), cellPt(2.6, -1.25)], {
        acronym: 'DEPARE',
        DRVAL1: -1,
        DRVAL2: 0,
    });
    const layers = { DEPARE: fc(DEEP, strip) } as InshoreLayers;
    const g = buildNavGrid(layers, SBBOX, 50, DRAFT, SAFETY, 30);
    /** A connector's cell chain: east 4, then south-east 2. */
    const stair: [number, number][] = [];
    {
        let { x, y } = start;
        stair.push(gridToLatLon(g, x, y));
        for (const m of 'eeeedd') {
            x += 1;
            if (m === 'd') y -= 1;
            stair.push(gridToLatLon(g, x, y));
        }
    }
    const chord: [number, number][] = [stair[0], stair[stair.length - 1]];
    const clearance = (p: readonly [number, number][]): number => {
        let best = Infinity;
        for (let i = 0; i + 1 < p.length; i++)
            best = Math.min(
                best,
                segmentGeometryDistanceM(
                    p[i],
                    p[i + 1],
                    strip.geometry as Parameters<typeof segmentGeometryDistanceM>[2],
                    KXS,
                    KY,
                ),
            );
        return best;
    };
    const reader = () =>
        lineExposureReader({
            layers,
            grid: g,
            draftM: DRAFT,
            safetyM: SAFETY,
            obstructionBufferM: 30,
            strictUncharted: false,
        });

    it('the precondition: no cell reads it, the stair keeps 62 m, the chord passes ~5.5 m off', () => {
        let differ = 0;
        for (let i = 0; i < g.cells.length; i++) if (!Object.is(g.cells[i], g0.cells[i])) differ++;
        expect(differ).toBe(0);
        expect(clearance(stair)).toBeGreaterThan(60);
        expect(clearance(chord)).toBeGreaterThan(4);
        expect(clearance(chord)).toBeLessThan(8);
    });

    it('nearShallowBand measures it (it found nothing: no shallow cell near)', () => {
        const r = nearShallowBand({
            grid: g,
            depthBands: chartAreaIndexFor(layers).depth,
            floorM: FLOOR,
            cliffClearanceM: 30,
            a: chord[0],
            b: chord[1],
        });
        expect(r.within).toHaveLength(1);
        expect(r.within[0].band.drval1).toBe(-1);
        expect(r.within[0].clearanceM).toBeCloseTo(clearance(chord), 1);
        expect(r.near).toMatchObject({ depthM: -1, requiredM: 30 });
        expect(r.unmeasured).toBe(false);
    });

    it("the string pull's chord reads it, and the pulled line keeps the strip's 30 m", () => {
        const read = reader();
        expect(read(chord[0], chord[1]).state & LINE_STATE.NEAR_SHALLOW).toBeTruthy();
        for (let i = 0; i + 1 < stair.length; i++)
            expect(read(stair[i], stair[i + 1]).state & LINE_STATE.NEAR_SHALLOW).toBeFalsy();
        const out = pullTaut(stair, {
            exposureOf: read,
            marks: chartMarkPoints(layers),
            corridorM: Math.SQRT2 * 50,
        });
        expect(clearance(out.polyline)).toBeGreaterThanOrEqual(30);
        expect(out.polyline.length).toBeGreaterThan(2);
    });
});

describe('6. a saved voyage-form plan keeps the near stretches, and says them again', () => {
    const spans: ChartedShallowSpan[] = [
        { startSeg: 0, startT: 0, endSeg: 0, endT: 0.1, minDepthM: 1.2 }, // water under the line: not this
        {
            startSeg: 0,
            startT: 0.2,
            endSeg: 0,
            endT: 0.3,
            minDepthM: 1,
            tideLiftable: true,
            // Routed with no tide loaded here (fix-up review): red, and kept so.
            tideUnknown: true,
            near: { clearanceM: 6, depthM: 1, requiredM: 10 },
        },
        {
            startSeg: 1,
            startT: 0.4,
            endSeg: 1,
            endT: 0.5,
            minDepthM: -3,
            near: { clearanceM: 4, depthM: -3, requiredM: 30 },
        },
        {
            startSeg: 1,
            startT: 0.6,
            endSeg: 1,
            endT: 0.7,
            minDepthM: 0,
            channelEdge: true,
            near: { clearanceM: 27.4, depthM: 0, requiredM: 30 },
        },
    ];
    const feature = inshoreRouteToGeoJSON(
        {
            polyline: [
                [153.2, -27.4],
                [153.21, -27.41],
                [153.22, -27.42],
            ],
            distanceNM: 1.6,
            cellsUsed: ['AU123'],
            elapsedMs: 20,
            chartedShallowSpans: spans,
        },
        { lat: -27.4, lon: 153.2 },
        { lat: -27.42, lon: 153.22 },
    );
    const live = inshoreRouteCaveats({ nearShallow: nearShallowSummary(spans) });

    it('the summary tells red, amber and channel edges apart', () => {
        expect(nearShallowSummary(spans)).toEqual({
            stretches: 2,
            clearanceM: 4,
            depthM: -3,
            requiredM: 30,
            red: 2,
            channel: { stretches: 1, clearanceM: 27.4, depthM: 0, requiredM: 30 },
        });
        expect(live).toEqual([
            'This route passes 4 m from water charted to dry 3.0 m — closer than the 30 m the router keeps off it (and on 1 more stretch). Check the chart there before you go.',
            "In the marked channel this route runs close to the edge of the channel's charted shallows: 27 m from water charted 0.0 m, inside the 30 m the router keeps off it elsewhere. Keep to the middle of the channel.",
        ]);
    });

    it('the saved route carries every near stretch, and the plan shown again says what the route said', () => {
        expect(feature.properties?.nearShallowSpans).toEqual(spans.filter((s) => s.near));
        expect(savedInshoreRouteCaveats({ routeGeoJSON: feature })).toEqual(live);
    });

    it('malformed stretches fall back to the saved summary; an older save with the summary alone still speaks', () => {
        const props = feature.properties as Record<string, unknown>;
        expect(
            savedInshoreRouteCaveats({
                routeGeoJSON: { properties: { ...props, nearShallowSpans: [{ startSeg: 'x' }] } },
            }),
        ).toEqual(live);
        const older = { ...props };
        delete older.nearShallowSpans;
        older.nearShallow = { stretches: 2, clearanceM: 4, depthM: -3, requiredM: 30 };
        expect(savedInshoreRouteCaveats({ routeGeoJSON: { properties: older } })).toEqual([live[0]]);
    });
});

describe('the words: a stretch cut into pieces is said once, and a marginal channel edge does not title the notes', () => {
    const piece = (
        seg: number,
        t0: number,
        t1: number,
        clearanceM: number,
        depthM: number,
        extra: Partial<ChartedShallowSpan> = {},
    ): ChartedShallowSpan => ({
        startSeg: seg,
        startT: t0,
        endSeg: seg,
        endT: t1,
        minDepthM: depthM,
        near: { clearanceM, depthM, requiredM: 30 },
        ...extra,
    });

    it("Rivergate's 7 channel-edge pieces are 2 places, and its 4 open-water pieces 2 stretches", () => {
        // The fix-up review: "(and on 6 more stretches)" for segs 26–27 and
        // seg 30 cut into 5 where the band beside it changes; "(and on 3 more
        // stretches)" for 3 contiguous pieces of seg 12 plus seg 16.
        const spans = [
            piece(12, 0.1, 0.2, 9, -2, { tideLiftable: true }),
            piece(12, 0.2, 0.35, 6.2, -2, { tideLiftable: true, tideUnknown: true }),
            piece(12, 0.35, 0.4, 12, -2, { tideLiftable: true, tideUnknown: true }),
            piece(16, 0.5, 0.6, 20, 0, { tideLiftable: true }),
            piece(26, 0.8, 1, 20, 0, { channelEdge: true }),
            piece(27, 0, 0.1, 15, 0, { channelEdge: true }),
            ...[0.1, 0.2, 0.3, 0.4, 0.5].map((t) => piece(30, t, t + 0.1, 17.3, -2.2, { channelEdge: true })),
        ];
        expect(nearShallowSummary(spans)).toEqual({
            stretches: 2,
            clearanceM: 6.2,
            depthM: -2,
            requiredM: 30,
            red: 1,
            channel: { stretches: 2, clearanceM: 15, depthM: 0, requiredM: 30 },
        });
        expect(inshoreRouteCaveats({ nearShallow: nearShallowSummary(spans) })).toEqual([
            'This route passes 6 m from water charted to dry 2.0 m — closer than the 30 m the router keeps off it (and on 1 more stretch). Check the chart there before you go.',
            "In the marked channel this route runs close to the edge of the channel's charted shallows: 15 m from water charted 0.0 m, inside the 30 m the router keeps off it elsewhere (and on 1 more stretch). Keep to the middle of the channel.",
        ]);
    });

    it('a channel edge 1.6 m short titles the notes only when nothing else is said; 15 m short, always', () => {
        const notice = (clearanceM: number, surveyUncheckedCells?: string[]) =>
            inshoreRouteNotice({
                stateMaskOk: true,
                nearShallow: nearShallowSummary([piece(25, 0.2, 0.3, clearanceM, 0, { channelEdge: true })]),
                ntmLockBanner: null,
                ...(surveyUncheckedCells ? { surveyUncheckedCells } : {}),
            });
        // Tangalooma, 28.4 m against the 30 m kept, in its own channel.
        expect(notice(28.4)?.title).toBe('Close to the channel edge');
        expect(notice(28.4, ['AU1'])?.title).toBe('Survey quality');
        expect(notice(28.4, ['AU1'])?.message).toMatch(/28 m from water charted 0\.0 m/);
        expect(notice(15, ['AU1'])?.title).toBe('Close to the channel edge');
    });
});
