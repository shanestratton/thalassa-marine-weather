/**
 * A shallow band's clearance on EVERY segment, over the stretch inside it, and
 * as a cost on the grid (the real-chart check, 2026-10-03).
 *
 * The saved test routes on the Pi's own cells found segments drawn green
 * inside a measured clearance: Shane's Cid Harbour route passed 4.3 m from
 * South Molle's reef drying 3.6 m, Coral Sea Marina → Daydream 24.6 m from
 * Daydream's, others 1.1–8.8 m from 2 m bands. The clearance rule (shallowRuns
 * nearShallowBand: 30 m from a band that dries, charts no depth or never
 * clears the keel, 10 m from one whose deep end does) only ran on a caution
 * segment the grid's cells alone made caution — a segment whose 50 m cells
 * read clean was never measured, on an engine route or a promoted Seaway one
 * — and nothing priced the cells beside a reef above open water, so A* and
 * the Seaway connectors ran along it. Now:
 *   • every segment is measured, and the stretch inside the clearance (only
 *     that) is drawn red — or amber where a tide clears the band itself
 *     (decision 10) — and blocks Save and Plan My Day;
 *   • the grid prices a ring round each shallow band (applyShallowClearanceRing),
 *     so A* and the connectors keep off where open water allows.
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
import { applyShallowClearanceRing, collectShallowRuns } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import { aStar } from '../../services/engine/aStar';
import { forEachCellOnSegment, haversineM } from '../../services/engine/geometry';
import { CAUTION } from '../../services/engine/constants';
import { CAUTION_WHY, type InshoreLayers, type NavGrid } from '../../services/engine/types';
import { inshoreRoutePieces, inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { routeRedStretches } from '../../components/map/routeRedReasons';
import { evaluateAutoroutingProposalSave } from '../../services/autoroutingProposalSave';
import { routeInshore } from '../../services/inshoreRouterEngine';
import { promotedSeawayRoute } from '../../services/InshoreRouter';
import { connectToTargets } from '../../services/seaway/connector';
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

/** 10–15 m water over the grid with one band let into it (a hole in the deep band). */
function chart(band: { x0: number; y0: number; x1: number; y1: number; d1: number; d2: number }): InshoreLayers {
    const props = (d1: number, d2: number) => ({ acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2, _scaleRank: RANK });
    const hole = box(band.x0, band.y0, band.x1, band.y1).reverse();
    return {
        DEPARE: fc(
            {
                type: 'Feature',
                properties: props(10, 15),
                geometry: { type: 'Polygon', coordinates: [box(...BBOX), hole] },
            },
            {
                type: 'Feature',
                properties: props(band.d1, band.d2),
                geometry: { type: 'Polygon', coordinates: [box(band.x0, band.y0, band.x1, band.y1)] },
            },
        ),
    } as InshoreLayers;
}

/** The band's south edge 1 m below the row 12 / 13 boundary: row 13's
 *  centres lie in it, row 12's do not — a line in row 12 touches clean cells. */
const EDGE = SOUTH + 13 * D_LAT - 1 * M_LAT;
const X0 = W + 0.01;
const X1 = W + 0.0136; // ~302 m wide
const REEF = { x0: X0, y0: EDGE, x1: X1, y1: EDGE + 0.0018, d1: -3, d2: 0 };
const SHOAL = { ...REEF, d1: 2, d2: 5 };

/** An east-going line `offM` south of the band's edge, past both its ends. */
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

function read(layers: InshoreLayers, line: [number, number][], highestM?: number) {
    const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
    const caution = cautionOf(grid, line);
    const out = collectShallowRuns({
        layers,
        grid,
        polyline: line,
        caution,
        draftM: DRAFT,
        safetyM: SAFETY,
        hazardMask: caution.map(() => false),
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
    const tide = highestM === undefined ? undefined : { depthM: out.tideDepthM, needM: FLOOR, highestM };
    const pieces = inshoreRoutePieces(line, states, [], out.chartedShallowSpans, tide);
    const lengthM = (cs: readonly (readonly [number, number])[]) =>
        cs.slice(1).reduce((m, p, i) => m + haversineM(cs[i][1], cs[i][0], p[1], p[0]), 0);
    const route = {
        provider: 'Thalassa',
        coordinates: line,
        engine: {
            stateMask: states,
            cautionMask: caution,
            canalMask: none,
            chartedShallowMask: out.chartedShallowMask,
            landPaintConflictMask: out.landPaintConflictMask,
            cautionWhy: out.cautionWhy,
            chartedShallowSpans: out.chartedShallowSpans,
            hardLandAwayM: 0,
        },
    } as unknown as AutoroutingTrialRoute;
    return {
        grid,
        caution,
        out,
        states,
        near: out.chartedShallowSpans.filter((s) => s.near),
        drawn: pieces.map((p) => [p.state, Math.round(lengthM(p.coordinates))] as const),
        words: routeRedStretches(
            line,
            pieces,
            { ...masks, chartedShallowSpans: out.chartedShallowSpans, tideNeedM: FLOOR },
            tide,
        ).map((s) => s.why),
        save: evaluateAutoroutingProposalSave(route, null, DRAFT, false),
    };
}

/** Metres along an east-going line at `lat` from its start to longitude `lon`. */
const alongM = (line: [number, number][], lon: number): number =>
    (lon - line[0][0]) * 111_320 * Math.cos((line[0][1] * Math.PI) / 180);

describe('a clean-grid segment 4 m from a reef that dries 3 m', () => {
    const layers = chart(REEF);
    const line = lineOff(4);
    const r = read(layers, line);
    const segM = alongM(line, line[1][0]);
    // The chord through the 30 m capsule round the reef's south-west and
    // south-east corners: √(30² − 4²) beyond each end of its 4 m side.
    const reach = Math.sqrt(30 * 30 - 4 * 4);

    it('the precondition: its 50 m cells read clean — never measured before', () => {
        expect(r.caution).toEqual([false]);
        expect(r.out.chartedShallowMask).toEqual([false]);
        expect(r.out.chartedShallowSpans.filter((s) => !s.near)).toEqual([]);
    });

    it('is red over exactly the stretch inside the 30 m clearance, and green either side', () => {
        expect(r.near).toHaveLength(1);
        const [s] = r.near;
        expect(s.startSeg).toBe(0);
        expect(s.startT * segM).toBeCloseTo(alongM(line, X0) - reach, 0);
        expect(s.endT * segM).toBeCloseTo(alongM(line, X1) + reach, 0);
        expect(s.minDepthM).toBe(-3);
        expect(s.near).toMatchObject({ depthM: -3, requiredM: 30 });
        expect(s.near!.clearanceM).toBeCloseTo(4, 2);
        expect(r.out.cautionNearShallow[0]).toMatchObject({ depthM: -3, requiredM: 30 });
        // The segment itself is not caution: only its stretch is drawn red.
        expect(r.states).toEqual(['green']);
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
        expect(r.drawn[1][1]).toBeGreaterThan(alongM(line, X1) - alongM(line, X0) + 2 * reach - 2);
        expect(r.drawn[1][1]).toBeLessThan(alongM(line, X1) - alongM(line, X0) + 2 * reach + 2);
        expect(r.words).toHaveLength(1);
        expect(r.words[0]).toMatch(/^passes 4 m from water charted to dry 3\.0 m — the router keeps 30 m off it/);
    });

    it('no tide the app knows clears a reef drying 3 m: still red at 2.5 m', () => {
        const t = read(layers, line, 2.5);
        expect(t.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
        expect(t.words[0]).toContain('the highest tide here (2.5 m) does not clear it');
    });

    it('is not saved', () => {
        expect(r.save).toEqual({
            eligible: false,
            reason: 'Part of this route passes too close to water charted shallower than this boat needs. It cannot be saved.',
        });
    });

    it('31 m off: clear — nothing drawn, and the reason is not this', () => {
        const far = read(layers, lineOff(31));
        expect(far.near).toEqual([]);
        expect(far.drawn.map(([st]) => st)).toEqual(['green']);
    });
});

describe('a 2–5 m shoal, whose deep end clears the keel, asks for 10 m', () => {
    const layers = chart(SHOAL);

    it('12 m off: fine', () => {
        const r = read(layers, lineOff(12));
        expect(r.caution).toEqual([false]);
        expect(r.near).toEqual([]);
        expect(r.drawn.map(([st]) => st)).toEqual(['green']);
    });

    it('8 m off: the stretch inside 10 m is drawn, saying how close', () => {
        const r = read(layers, lineOff(8));
        expect(r.caution).toEqual([false]);
        expect(r.near).toHaveLength(1);
        expect(r.near[0].near).toMatchObject({ depthM: 2, requiredM: 10 });
        expect(r.near[0].near!.clearanceM).toBeCloseTo(8, 2);
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
        expect(r.words[0]).toMatch(/^passes 8 m from water charted 2\.0 m — the router keeps 10 m off it/);
    });

    it('amber where a tide clears the shoal itself (decision 10), red where none does', () => {
        // 2 m + 0.9 m of tide = draft + UKC.
        expect(read(layers, lineOff(8), 1.0).drawn.map(([st]) => st)).toEqual(['green', 'tide', 'green']);
        expect(read(layers, lineOff(8), 0.5).drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
    });

    it('amber is a tide dependency the leg review cannot see: not saved either', () => {
        expect(read(layers, lineOff(8)).save.eligible).toBe(false);
    });
});

describe('a cells-only caution segment near a band: red over the stretch, not the whole segment', () => {
    // The real-chart check's F1: the Rivergate golden's 11.3 km bay chord went
    // red whole for one caution cell 3.7 m from a 2 m band. Here a 2–5 m
    // shoal ends 1 m short of the row 12 / 13 boundary: row 12's centres lie
    // in it (CAUTION), and a line 0.5 m north of it, still in row 12, touches
    // those cells without entering the shoal — 1.5 km long, 302 m of it beside
    // the shoal.
    const layers = chart({ ...SHOAL, y0: EDGE - 0.0018, y1: EDGE });
    const line: [number, number][] = [
        [W + 0.004, EDGE + 0.5 * M_LAT],
        [W + 0.02, EDGE + 0.5 * M_LAT],
    ];

    it('GRID_ONLY, with only the stretch inside 10 m drawn red', () => {
        const r = read(layers, line);
        expect(r.caution).toEqual([true]);
        expect(r.out.chartedShallowMask).toEqual([false]);
        // c0309771 / 7f230264: NEAR_SHALLOW, the whole 1.5 km segment red.
        expect(r.out.cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY]);
        expect(r.states).toEqual(['green']);
        expect(r.near).toHaveLength(1);
        expect(r.near[0].near!.clearanceM).toBeCloseTo(0.5, 2);
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
        const width = alongM(line, X1) - alongM(line, X0);
        expect(r.drawn[1][1]).toBeGreaterThan(width + 19);
        expect(r.drawn[1][1]).toBeLessThan(width + 21);
        expect(r.save.eligible).toBe(false);
    });
});

describe('the grid prices a ring round a reef: A* keeps 30 m off where open water allows', () => {
    const layers = chart(REEF);
    /** Metres from a point to the reef rectangle. */
    const offReefM = (lon: number, lat: number): number => {
        const dx = Math.max(X0 - lon, 0, lon - X1) * KX;
        const dy = Math.max(REEF.y0 - lat, 0, lat - REEF.y1) * 111_320;
        return Math.hypot(dx, dy);
    };
    const nearestCellPass = (grid: NavGrid, path: { x: number; y: number }[]): number =>
        Math.min(
            ...path.map((c) => offReefM(grid.minLon + (c.x + 0.5) * grid.dLon, grid.minLat + (c.y + 0.5) * grid.dLat)),
        );
    // Row 12, whose centres lie 24 m south of the reef: the straight way.
    const start = { x: 2, y: 12 };
    const end = { x: 32, y: 12 };

    it('without the ring the cheapest path runs along the reef 24 m off', () => {
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        const path = aStar(grid, start, end)!;
        expect(nearestCellPass(grid, path)).toBeLessThan(30);
    });

    it('with it, every cell of the path keeps 30 m', () => {
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        expect(applyShallowClearanceRing(grid, layers, FLOOR)).toBeGreaterThan(0);
        // The row beside the reef is ring (cliff) cells; a no-op the second time.
        const x = Math.floor((X0 + 0.001 - grid.minLon) / grid.dLon);
        expect(grid.shallowRing![12 * grid.width + x]).toBe(2);
        expect(grid.shallowRing![10 * grid.width + x]).toBe(0);
        expect(applyShallowClearanceRing(grid, layers, FLOOR)).toBe(0);
        const path = aStar(grid, start, end)!;
        expect(nearestCellPass(grid, path)).toBeGreaterThanOrEqual(30);
    });

    it('through the whole engine: the finished route keeps 30 m and draws nothing red', () => {
        const at = (x: number) => [grid0.minLon + (x + 0.5) * grid0.dLon, grid0.minLat + 12.5 * grid0.dLat];
        const grid0 = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        const [from, to] = [at(start.x), at(end.x)];
        const r = routeInshore(layers, {
            fromLat: from[1],
            fromLon: from[0],
            toLat: to[1],
            toLon: to[0],
            draftM: DRAFT,
            safetyM: SAFETY,
        });
        expect('polyline' in r).toBe(true);
        if (!('polyline' in r)) return;
        for (let i = 0; i + 1 < r.polyline.length; i++) {
            const [a, b] = [r.polyline[i], r.polyline[i + 1]];
            const n = Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / 2);
            for (let k = 0; k <= n; k++)
                expect(offReefM(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n)).toBeGreaterThanOrEqual(
                    30,
                );
        }
        expect((r.chartedShallowSpans ?? []).filter((s) => s.near)).toEqual([]);
    });
});

describe('a promoted Seaway route gets the same treatment', () => {
    const layers = chart(REEF);

    it('its clean-cell leg 4 m off the reef is drawn red over the close stretch', () => {
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        const line = lineOff(4);
        const r = promotedSeawayRoute(
            {
                polyline: line,
                channelSegMask: [false],
                cautionSegMask: [false],
                lengthM: alongM(line, line[1][0]),
                edgesUsed: [],
                gateCount: 0,
                gateCompliance: null,
                detourRatio: 1,
            },
            grid,
            layers,
            { draftM: DRAFT, safetyM: SAFETY },
            { cellsUsed: ['T'], elapsedMs: 1 },
        );
        expect(r.cautionMask).toEqual([false]);
        const near = (r.chartedShallowSpans ?? []).filter((s) => s.near);
        expect(near).toHaveLength(1);
        expect(near[0].near).toMatchObject({ depthM: -3, requiredM: 30 });
        expect(r.cautionNearShallow?.[0]).toMatchObject({ depthM: -3, requiredM: 30 });
    });

    it("its connectors' search keeps 30 m off the reef too", () => {
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        applyShallowClearanceRing(grid, layers, FLOOR);
        const cell = (x: number) => ({ lat: grid.minLat + 12.5 * grid.dLat, lon: grid.minLon + (x + 0.5) * grid.dLon });
        const res = connectToTargets(grid, cell(2), [{ id: 't', kind: 'portal', ...cell(32) }]);
        const path = res.results[0].path!;
        expect(res.results[0].reached).toBe(true);
        const off = path.map((c) => {
            const lon = grid.minLon + (c.x + 0.5) * grid.dLon;
            const lat = grid.minLat + (c.y + 0.5) * grid.dLat;
            return Math.hypot(
                Math.max(X0 - lon, 0, lon - X1) * KX,
                Math.max(REEF.y0 - lat, 0, lat - REEF.y1) * 111_320,
            );
        });
        expect(Math.min(...off)).toBeGreaterThanOrEqual(30);
    });
});

describe("the canal's red names its reason", () => {
    it('a canal segment the grid did not flag carries CANAL, and the notes say canal', () => {
        const layers = chart(REEF);
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        const line: [number, number][] = [
            [W + 0.002, SOUTH + 3 * D_LAT],
            [W + 0.006, SOUTH + 3 * D_LAT],
            [W + 0.009, SOUTH + 3 * D_LAT],
        ];
        const out = collectShallowRuns({
            layers,
            grid,
            polyline: line,
            caution: [false, false],
            draftM: DRAFT,
            safetyM: SAFETY,
            hazardMask: [false, false],
            canalMask: [true, false],
        });
        expect(out.cautionWhy).toEqual([CAUTION_WHY.CANAL, 0]);
        const masks = {
            polyline: line,
            cautionMask: [false, false],
            canalMask: [true, false],
            channelMask: [false, false],
            offshoreMask: [false, false],
            cautionWhy: out.cautionWhy,
        };
        const states = inshoreSegmentStates(masks)!;
        expect(states).toEqual(['danger', 'green']);
        const words = routeRedStretches(line, inshoreRoutePieces(line, states), masks).map((s) => s.why);
        expect(words).toEqual(['canal or marina basin: narrow water — keep to the charted channel']);
    });
});

// ── Fix-up review (2026-10-03) ───────────────────────────────────────────
type Band = { x0: number; y0: number; x1: number; y1: number; d1: number; d2: number; dredged?: boolean };

/** 10–15 m water over the grid with several bands let into it (holes), a
 *  `dredged` one as an S-57 DRGARE — what navGrid Pass 4 prefers. */
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

const CW = 50 / KX; // a cell's width in degrees of longitude
/** Row 12's south edge (the grid starts at SOUTH). */
const ROW12 = SOUTH + 12 * D_LAT;

describe('a marked channel between drying banks: the marks own the line (no new gate)', () => {
    // The fix-up review's S2: a 50 m dredged channel (5 m) between banks drying
    // 1.5 m, and a line down its middle, 25 m from each bank. The ring skips
    // channel water (the marks own the line), so the router keeps this line;
    // the clearance pass drew 1 km of it red and refused Save and Plan My Day,
    // where 7f48fe15 drew it as a channel and let it past those gates.
    const banks = (x0: number, x1: number): Band[] => [
        { x0, y0: ROW12 - 2 * D_LAT, x1, y1: ROW12, d1: -1.5, d2: 0 },
        { x0, y0: ROW12 + D_LAT, x1, y1: ROW12 + 3 * D_LAT, d1: -1.5, d2: 0 },
    ];
    const line: [number, number][] = [
        [W + 0.005, ROW12 + 0.5 * D_LAT],
        [W + 0.025, ROW12 + 0.5 * D_LAT],
    ];
    const B0 = W + 0.008;
    const B1 = W + 0.022;

    it('down a dredged channel: no clearance stretch, and nothing about it refuses Save', () => {
        const layers = charts(...banks(B0, B1), {
            x0: W + 0.004,
            y0: ROW12,
            x1: W + 0.026,
            y1: ROW12 + D_LAT,
            d1: 5,
            d2: 10,
            dredged: true,
        });
        const r = read(layers, line);
        expect(r.caution).toEqual([false]);
        // The precondition: the line's cells are the channel's (Pass 4).
        forEachCellOnSegment(r.grid, line[0], line[1], (idx) => expect(r.grid.preferred[idx]).toBe(1));
        expect(r.near).toEqual([]);
        expect(r.drawn.map(([st]) => st)).toEqual(['green']);
        expect(r.save.reason ?? '').not.toContain('too close');
    });

    it('where the dredged channel ends, the clearance stretch starts at the first cell off it', () => {
        // The channel's outline stops at W + 0.015: cell 25 (from W + 25 cells)
        // is the first whose centre is off it.
        const layers = charts(...banks(B0, B1), {
            x0: W + 0.004,
            y0: ROW12,
            x1: W + 0.015,
            y1: ROW12 + D_LAT,
            d1: 5,
            d2: 10,
            dredged: true,
        });
        const r = read(layers, line);
        expect(r.near).toHaveLength(1);
        const segM = alongM(line, line[1][0]);
        expect(r.near[0].startT * segM).toBeCloseTo(alongM(line, W + 25 * CW), 0);
        expect(r.near[0].near).toMatchObject({ depthM: -1.5, requiredM: 30 });
        expect(r.near[0].near!.clearanceM).toBeCloseTo(25, 1);
        expect(r.save.eligible).toBe(false);
    });

    it('open water between the same banks (no channel the marks own) keeps its red', () => {
        const r = read(charts(...banks(B0, B1)), line);
        expect(r.near).toHaveLength(1);
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
    });
});

describe('a band that holds no cell centre is measured and ringed too', () => {
    // The fix-up review: bands were found only through the 50 m cells whose
    // centres they own, so a drying patch or strip between the centres was
    // never measured (drawn green, saved) and never ringed (routed metres off).
    /** A 34 m patch drying 2 m centred on a cell corner: every centre is 25 m
     *  off the corner on both axes, outside it. */
    const CX = W + 20 * CW;
    const CY = SOUTH + 13 * D_LAT;
    const PATCH: Band = {
        x0: CX - 17 / KX,
        y0: CY - 17 * M_LAT,
        x1: CX + 17 / KX,
        y1: CY + 17 * M_LAT,
        d1: -2,
        d2: 0,
    };
    /** A 30 m × 500 m strip between row 12's centres (25 m up) and row 13's (75 m up). */
    const strip = (d1: number, d2: number): Band => ({
        x0: W + 0.008,
        y0: ROW12 + 30 * M_LAT,
        x1: W + 0.008 + 500 / KX,
        y1: ROW12 + 60 * M_LAT,
        d1,
        d2,
    });
    const east = (lat: number): [number, number][] => [
        [W + 0.004, lat],
        [W + 0.02, lat],
    ];

    it('a patch drying 2 m, 10 m off a clean-cell line: the stretch is drawn and Save refused', () => {
        const layers = charts(PATCH);
        const r = read(layers, east(PATCH.y0 - 10 * M_LAT));
        expect(r.caution).toEqual([false]);
        expect(r.near).toHaveLength(1);
        expect(r.near[0].near).toMatchObject({ depthM: -2, requiredM: 30 });
        expect(r.near[0].near!.clearanceM).toBeCloseTo(10, 1);
        expect(r.drawn.map(([st]) => st)).toEqual(['green', 'danger', 'green']);
        expect(r.save.eligible).toBe(false);
    });

    for (const [name, d1, d2] of [
        ['drying 2 m', -2, 0],
        ['0–2 m (never clears the keel)', 0, 2],
    ] as const) {
        it(`a 30 m strip ${name}, 10 m off a clean-cell line: drawn`, () => {
            const s = strip(d1, d2);
            const r = read(charts(s), east(s.y0 - 10 * M_LAT));
            expect(r.caution).toEqual([false]);
            expect(r.near).toHaveLength(1);
            expect(r.near[0].near).toMatchObject({ depthM: d1, requiredM: 30 });
            expect(r.near[0].near!.clearanceM).toBeCloseTo(10, 1);
        });
    }

    it('the ring covers the cells beside the patch and the strip', () => {
        const grid = buildNavGrid(charts(PATCH), BBOX, 50, DRAFT, SAFETY, 30);
        applyShallowClearanceRing(grid, charts(PATCH), FLOOR);
        // The four cells round the corner: centres 11.3 m off the patch.
        for (const [x, y] of [
            [19, 12],
            [20, 12],
            [19, 13],
            [20, 13],
        ])
            expect(grid.shallowRing![y * grid.width + x]).toBe(2);
        const s = strip(-2, 0);
        const layers = charts(s);
        const g2 = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        applyShallowClearanceRing(g2, layers, FLOOR);
        const x = Math.floor((s.x0 + 0.002 - g2.minLon) / g2.dLon);
        // Row 12 (centres 5 m south of it) and row 13 (15 m north): ring;
        // row 11 (55 m south): not.
        expect(g2.shallowRing![12 * g2.width + x]).toBe(2);
        expect(g2.shallowRing![13 * g2.width + x]).toBe(2);
        expect(g2.shallowRing![11 * g2.width + x]).toBe(0);
    });

    it('so A* keeps 30 m off the strip', () => {
        const s = strip(-2, 0);
        const layers = charts(s);
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        applyShallowClearanceRing(grid, layers, FLOOR);
        const path = aStar(grid, { x: 2, y: 12 }, { x: 40, y: 12 })!;
        const off = path.map((c) => {
            const lon = grid.minLon + (c.x + 0.5) * grid.dLon;
            const lat = grid.minLat + (c.y + 0.5) * grid.dLat;
            return Math.hypot(Math.max(s.x0 - lon, 0, lon - s.x1) * KX, Math.max(s.y0 - lat, 0, lat - s.y1) * 111_320);
        });
        expect(Math.min(...off)).toBeGreaterThanOrEqual(30);
    });

    it('a coarse band a finer survey charts deep at its nearest edge is not measured', () => {
        // A coarse chart's 0–2 m patch under a finer survey's 10 m: the finer
        // survey owns the water there (the grid's finest-survey rule).
        const fine = {
            ...PATCH,
            x0: PATCH.x0 - 5 / KX,
            x1: PATCH.x1 + 5 / KX,
            y0: PATCH.y0 - 5 * M_LAT,
            y1: PATCH.y1 + 5 * M_LAT,
        };
        const base = charts(PATCH);
        const layers = {
            ...base,
            DEPARE: fc(
                ...base.DEPARE!.features.map((f) =>
                    f.properties?.DRVAL1 === -2
                        ? { ...f, properties: { ...f.properties, DRVAL1: 0, DRVAL2: 2, _scaleRank: RANK - 1000 } }
                        : f,
                ),
                {
                    type: 'Feature',
                    properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15, _scaleRank: RANK + 1000 },
                    geometry: { type: 'Polygon', coordinates: [box(fine.x0, fine.y0, fine.x1, fine.y1)] },
                },
            ),
        } as InshoreLayers;
        const r = read(layers, east(PATCH.y0 - 10 * M_LAT));
        expect(r.near).toEqual([]);
        // …nor ringed: the cells round it are open water's.
        applyShallowClearanceRing(r.grid, layers, FLOOR);
        for (const [x, y] of [
            [19, 12],
            [20, 12],
            [19, 13],
            [20, 13],
        ])
            expect(r.grid.shallowRing![y * r.grid.width + x]).toBe(0);
    });
});
