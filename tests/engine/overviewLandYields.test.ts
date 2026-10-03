/**
 * Owner decision 12 (Shane, 2026-10-02, "Trust the detailed chart").
 *
 * Wherever a chart of usage band 3 or finer (1:350,000 or finer) charts a
 * depth area (DEPARE / DRGARE) that never dries, land paint from OVERVIEW and
 * GENERAL cells (bands 1–2, e.g. 1:3,500,000 and 1:1,500,000) is no dispute:
 * no decision-1 'charts disagree' caution, and the route is coloured by the
 * detailed chart's own depth. Field case, Cid Harbour (2026-10-02): the
 * 1:3,500,000 AU130120 paints the harbour land, the 1:1,500,000 AU230140
 * charts 0–30 m and the 1:90,000 AU421148 charts 10–15 m — the leg was red,
 * "Danger reported", and Save was blocked.
 *
 * What stays:
 *   • decision 1 between two DETAILED charts (the Brisbane River: the
 *     1:90,000 coastline over the 1:12,000 harbour survey) — 'charts
 *     disagree', red;
 *   • a detailed chart's own land over coarser water (a small island the
 *     overview leaves out) — land;
 *   • land over a detailed band that DRIES (Claude's call, fix-up 2026-10-03:
 *     ignored there, it turned charted drying banks under the overview's land
 *     into routable caution that the lead clip read as water — the Brisbane
 *     River mouth's −2.2 m bank and 8 km of compiled leads), over one that
 *     charts no depth, land of unknown scale, and decision 1 between overview
 *     and general cells alone.
 *
 * One rule (services/enc/scaleShadow overviewLandYields) for the grid
 * (navGrid Pass 2), the shallow-run sampler and the tracer that read it, the
 * lead land clip, the land audits, the D11 proof's land test and the satellite
 * check's chart evidence. Synthetic water off an invented coast — no chart
 * data.
 */
import type { Feature, FeatureCollection, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import { buildNavGrid } from '../../services/engine/navGrid';
import { CAUTION } from '../../services/engine/constants';
import { CAUTION_WHY, type InshoreLayers, type NavGrid } from '../../services/engine/types';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { auditUnvouchedHardLand, hardLandAtPoint } from '../../services/engine/safetyAudit';
import {
    backstopVerdict,
    BACKSTOP_MIN_VOUCH_BAND,
    chartLandVerdict,
    landPaintStanding,
    type BandClaim,
} from '../../services/engine/chartWaterEvidence';
import {
    cellFinenessRank,
    DETAILED_CHART_MIN_BAND,
    isDetailedChartRank,
    landRankKey,
    overviewLandYields,
} from '../../services/enc/scaleShadow';
import { buildChartAreaIndex, depthAlongLine } from '../../services/routing/leadLandClip';
import { dangerWithoutChartedDepth, inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { tracerContextFromLayers, validateTrace } from '../../services/routeTracer';

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

/** The router's own ranks, from each cell's compilation scale. */
const rankOf = (nativeScale: number): number => cellFinenessRank({ nativeScale })!;
const OVERVIEW = rankOf(3_500_000); // band 1 — AU130120
const GENERAL = rankOf(1_500_000); // band 2 — AU230140
const COASTAL = rankOf(350_000); // band 3 — the finest scale decision 12 trusts' coarsest
const APPROACH = rankOf(90_000); // band 4 — AU421148
const HARBOUR = rankOf(12_000); // band 5 — a harbour survey

// ── The grid, one probe cell ────────────────────────────────────────────────

// A 2 km square of land paint over bands of the same extent; the probe cell
// is its middle, clear of every edge and the Pass 6 land skin.
const BBOX: [number, number, number, number] = [169.99, -41.02, 170.03, -40.98];
const LAND = (rank?: number) => rect(170.0, -41.01, 170.02, -40.99, rank === undefined ? {} : { _scaleRank: rank });
const BAND = (DRVAL1: unknown, rank: number | undefined, DRVAL2: unknown = 15) =>
    rect(169.998, -41.012, 170.022, -40.988, {
        acronym: 'DEPARE',
        DRVAL1,
        DRVAL2,
        ...(rank === undefined ? {} : { _scaleRank: rank }),
    });

function build(layers: InshoreLayers): NavGrid {
    // 2.4 m draft + 0.5 m: 10 m is deep, 1 m shallow.
    return buildNavGrid(layers, BBOX, 50, 2.4, 0.5, 60);
}
function probe(g: NavGrid) {
    const x = Math.floor((170.01 - g.minLon) / g.dLon);
    const y = Math.floor((-41.0 - g.minLat) / g.dLat);
    const i = y * g.width + x;
    const v = g.cells[i];
    return {
        land: g.landBlocked?.[i] === 1,
        blocked: Number.isNaN(v),
        caution: v === CAUTION,
        depthM: v > 0 ? v : null,
        wetConflict: g.wetConflict?.[i] === 1,
        shallowDepthM: g.shallowDepthM?.[i],
    };
}
const LAND_CELL = { land: true, blocked: true, caution: false, wetConflict: false };
const CONFLICT_CELL = { land: false, blocked: false, caution: true, wetConflict: true };

describe('decision 12 — the shared rule (scaleShadow)', () => {
    it('a detailed chart is usage band 3 or finer, the line the satellite check uses too', () => {
        expect(DETAILED_CHART_MIN_BAND).toBe(3);
        expect(BACKSTOP_MIN_VOUCH_BAND).toBe(DETAILED_CHART_MIN_BAND);
        expect(isDetailedChartRank(COASTAL)).toBe(true);
        expect(isDetailedChartRank(rankOf(350_001))).toBe(false);
        expect(isDetailedChartRank(cellFinenessRank({ sourceCellId: 'AU3SYN01' }))).toBe(true);
        expect(isDetailedChartRank(cellFinenessRank({ sourceCellId: 'AU2SYN01' }))).toBe(false);
        expect(isDetailedChartRank(null)).toBe(false);
    });

    it('only overview and general land yields, only to detailed bands that never dry', () => {
        for (const land of [OVERVIEW, GENERAL, landRankKey(2000)])
            for (const band of [COASTAL, APPROACH, HARBOUR]) expect(overviewLandYields(band, true, land)).toBe(true);
        // A detailed chart's own land never yields: decision 1 decides.
        expect(overviewLandYields(HARBOUR, true, APPROACH)).toBe(false);
        expect(overviewLandYields(HARBOUR, true, COASTAL)).toBe(false);
        expect(overviewLandYields(HARBOUR, true, landRankKey(3000))).toBe(false);
        // Drying or undepthed, small-scale, unranked or unknown: never.
        expect(overviewLandYields(APPROACH, false, OVERVIEW)).toBe(false);
        expect(overviewLandYields(GENERAL, true, OVERVIEW)).toBe(false);
        expect(overviewLandYields(null, true, OVERVIEW)).toBe(false);
        expect(overviewLandYields(APPROACH, true, null)).toBe(false);
    });
});

describe('decision 12 — the grid (navGrid Pass 2)', () => {
    it('overview land over a detailed 10–15 m band: the detailed chart’s water, not a conflict', () => {
        // The Cid Harbour stack: 1:3.5M land, 1:1.5M 0–30 m, 1:90k 10–15 m.
        const g = probe(build({ LNDARE: fc(LAND(OVERVIEW)), DEPARE: fc(BAND(0, GENERAL, 30), BAND(10, APPROACH)) }));
        expect(g).toMatchObject({
            land: false,
            blocked: false,
            caution: false,
            wetConflict: false,
            depthM: 10,
        });
    });

    it('general land over the coarsest detailed band (1:350,000) yields too', () => {
        const g = probe(build({ LNDARE: fc(LAND(GENERAL)), DEPARE: fc(BAND(10, COASTAL)) }));
        expect(g).toMatchObject({ land: false, caution: false, wetConflict: false, depthM: 10 });
    });

    it('the detailed chart’s depth decides: a shallow band stays shallow caution — never land, never a conflict', () => {
        const shallow = probe(build({ LNDARE: fc(LAND(OVERVIEW)), DEPARE: fc(BAND(1, APPROACH, 2)) }));
        expect(shallow).toMatchObject({
            land: false,
            caution: true,
            wetConflict: false,
            shallowDepthM: 1,
        });
        const awash = probe(build({ LNDARE: fc(LAND(OVERVIEW)), DEPARE: fc(BAND(0, APPROACH, 2)) }));
        expect(awash).toMatchObject({ land: false, caution: true, wetConflict: false, shallowDepthM: 0 });
    });

    // Fix-up (2026-10-03, Claude's call): the first build let a DRYING
    // detailed band count. The overview's land over the Brisbane River mouth's
    // charted −2.2..0 bank became routable caution, a charted lead over it
    // counted as 'on water', and the production-shape Rivergate route crossed
    // 1,116 m of drying ground (HEAD 30 m). Decision 1 never lets a drying
    // band beat land paint; decision 12 does not either.
    it('a detailed DRYING band keeps the overview’s land paint: land, as decision 1 has it', () => {
        expect(probe(build({ LNDARE: fc(LAND(OVERVIEW)), DEPARE: fc(BAND(-1, APPROACH, 1)) }))).toMatchObject(
            LAND_CELL,
        );
        expect(probe(build({ LNDARE: fc(LAND(GENERAL)), DEPARE: fc(BAND(-2.2, HARBOUR, 0)) }))).toMatchObject(
            LAND_CELL,
        );
    });

    // Fix-up (2026-10-03): decision-1 water was protected from the coastline
    // strip and the Pass-6 land skin; decision 12 takes the dispute away, not
    // that standing. Without it the Newport canal mouth's charted 0 m cells
    // beside the band-4 land were skinned shut, and the corridor goldens
    // crossed charted land (Rivergate 48.8 m, Tangalooma 1.6 km).
    it('a shallow detailed band under ignored overview land is not sealed by the land skin beside detailed land', () => {
        // The overview's land over all of it, the detailed 0–2 m band, and
        // the detailed chart's own land east of the probe.
        const g = build({
            LNDARE: fc(LAND(OVERVIEW), rect(170.0112, -41.01, 170.02, -40.99, { _scaleRank: APPROACH })),
            DEPARE: fc(BAND(0, APPROACH, 2)),
        });
        const y = Math.floor((-41.0 - g.minLat) / g.dLat);
        const row = (x: number) => y * g.width + x;
        // The first cell whose centre is in the detailed land, and the one
        // west of it — the cell the 1-cell land skin would seal.
        const land = Math.ceil((170.0112 - g.minLon) / g.dLon - 0.5);
        expect(g.landBlocked?.[row(land)]).toBe(1);
        const x = land - 1;
        expect(Number.isNaN(g.cells[row(x)])).toBe(false);
        expect(g.cells[row(x)]).toBe(CAUTION);
        expect(g.wetConflict?.[row(x)] ?? 0).toBe(0);
        // The overview's land over it was ignored (decision 12), not upheld.
        expect(g.landBlocked?.[row(x)] ?? 0).toBe(0);
    });

    it('two detailed charts disagreeing keep decision 1’s caution (the Brisbane River case)', () => {
        // The 1:90,000 coastline over the 1:12,000 harbour survey's 5 m.
        const g = probe(build({ LNDARE: fc(LAND(APPROACH)), DEPARE: fc(BAND(5, HARBOUR)) }));
        expect(g).toMatchObject(CONFLICT_CELL);
        // …and with the overview's land over them as well.
        const both = probe(build({ LNDARE: fc(LAND(OVERVIEW), LAND(APPROACH)), DEPARE: fc(BAND(5, HARBOUR)) }));
        expect(both).toMatchObject(CONFLICT_CELL);
    });

    it.each([
        ['a detailed chart’s land over general water (a small island)', [LAND(COASTAL)], [BAND(10, GENERAL, 30)]],
        ['a detailed chart’s land over its own band', [LAND(APPROACH)], [BAND(10, APPROACH)]],
        ['overview + detailed land over a detailed band', [LAND(OVERVIEW), LAND(APPROACH)], [BAND(10, APPROACH)]],
        ['overview land over a detailed band with no DRVAL1', [LAND(OVERVIEW)], [BAND(undefined, APPROACH)]],
        [
            'overview land over a detailed band tied with a drying one',
            [LAND(OVERVIEW)],
            [BAND(10, APPROACH), BAND(-1, APPROACH, 1)],
        ],
        [
            'overview land over a detailed band tied with an undepthed one',
            [LAND(OVERVIEW)],
            [BAND(10, APPROACH), BAND(undefined, APPROACH)],
        ],
        ['unranked land beside the overview’s', [LAND(OVERVIEW), LAND()], [BAND(10, APPROACH)]],
        ['overview land over an unranked band', [LAND(OVERVIEW)], [BAND(10, undefined)]],
    ] as [string, Feature[], Feature[]][])('%s: the land stands', (_name, land, bands) => {
        expect(probe(build({ LNDARE: fc(...land), DEPARE: fc(...bands) }))).toMatchObject(LAND_CELL);
    });

    it('between overview and general cells alone decision 1 is unchanged: caution, never clean water', () => {
        const g = probe(build({ LNDARE: fc(LAND(OVERVIEW)), DEPARE: fc(BAND(10, GENERAL, 30)) }));
        expect(g).toMatchObject(CONFLICT_CELL);
    });

    it('a detailed dredged area (DRGARE) counts as a depth area', () => {
        const dredged = rect(169.998, -41.012, 170.022, -40.988, {
            acronym: 'DRGARE',
            DRVAL1: 6,
            _scaleRank: HARBOUR,
        });
        const g = probe(build({ LNDARE: fc(LAND(OVERVIEW)), DRGARE: fc(dredged) }));
        expect(g).toMatchObject({ land: false, caution: false, wetConflict: false, depthM: 6 });
    });
});

describe('decision 12 — point rules: audits, the D11 proof, the satellite check', () => {
    const claim = (rank: number | null, DRVAL1: number | null): BandClaim => ({
        rank,
        neverDries: DRVAL1 !== null && DRVAL1 >= 0,
    });

    it('chartLandVerdict / landPaintStanding', () => {
        expect(landPaintStanding([claim(APPROACH, 10)], [OVERVIEW, GENERAL])).toEqual([]);
        expect(chartLandVerdict([claim(APPROACH, 10)], [OVERVIEW])).toBe('open');
        expect(chartLandVerdict([claim(APPROACH, 0)], [OVERVIEW])).toBe('open');
        expect(chartLandVerdict([claim(APPROACH, -1)], [OVERVIEW])).toBe('land');
        expect(chartLandVerdict([claim(APPROACH, 10), claim(APPROACH, -1)], [OVERVIEW])).toBe('land');
        expect(chartLandVerdict([claim(APPROACH, null)], [OVERVIEW])).toBe('land');
        expect(chartLandVerdict([claim(HARBOUR, 5)], [APPROACH])).toBe('conflict');
        expect(chartLandVerdict([claim(HARBOUR, 5)], [OVERVIEW, APPROACH])).toBe('conflict');
        expect(chartLandVerdict([claim(GENERAL, 10)], [COASTAL])).toBe('land');
        expect(chartLandVerdict([claim(APPROACH, 10)], [OVERVIEW, null])).toBe('land');
        expect(chartLandVerdict([claim(GENERAL, 10)], [OVERVIEW])).toBe('conflict');
        expect(chartLandVerdict([claim(APPROACH, 10)], [])).toBe('open');
    });

    it('hardLandAtPoint (pins, and the D11 proof’s land test): detailed water under overview land is not land; a drying bank is', () => {
        const at = (land: Feature[], bands: Feature[]) =>
            hardLandAtPoint({ LNDARE: fc(...land), DEPARE: fc(...bands) } as InshoreLayers)(170.01, -41.0);
        expect(at([LAND(OVERVIEW)], [BAND(-1, APPROACH, 1)])).toBe(true);
        expect(at([LAND(OVERVIEW)], [BAND(1, APPROACH, 2)])).toBe(false);
        expect(at([LAND(OVERVIEW)], [BAND(10, APPROACH)])).toBe(false);
        expect(at([LAND(OVERVIEW)], [BAND(undefined, APPROACH)])).toBe(true);
        expect(at([LAND(COASTAL)], [BAND(10, GENERAL, 30)])).toBe(true);
        expect(at([LAND(APPROACH)], [BAND(-1, HARBOUR, 1)])).toBe(true);
    });

    it('the satellite check’s chart evidence reads the same', () => {
        expect(backstopVerdict(false, [claim(APPROACH, 10)], [OVERVIEW])).toBe('water');
        expect(backstopVerdict(false, [claim(APPROACH, -1)], [OVERVIEW])).toBe('land');
        expect(backstopVerdict(false, [claim(GENERAL, 10)], [OVERVIEW])).toBe('uncharted-land');
        expect(backstopVerdict(false, [claim(GENERAL, 10)], [COASTAL])).toBe('land');
    });
});

describe('decision 12 — the lead land clip', () => {
    const line: Position[] = [
        [169.999, -41.0],
        [170.021, -41.0],
    ];
    it('a lead over overview land on a detailed band is on water at the band’s depth, not land paint', () => {
        const index = buildChartAreaIndex({
            LNDARE: fc(LAND(OVERVIEW)),
            DEPARE: fc(BAND(0, GENERAL, 30), BAND(10, APPROACH)),
        });
        const d = depthAlongLine(index, line);
        expect(d.landM).toBe(0);
        expect(d.landConflictM).toBe(0);
        expect(d.minDepthM).toBe(10);
    });
    it('a lead over overview land on a detailed DRYING band stays on land paint (clipped, as at HEAD)', () => {
        const index = buildChartAreaIndex({
            LNDARE: fc(LAND(OVERVIEW)),
            DEPARE: fc(BAND(-2.2, APPROACH, 0)),
        });
        const d = depthAlongLine(index, line);
        expect(d.landM).toBeGreaterThan(1000);
        expect(d.landConflictM).toBe(0);
    });
    it('two detailed charts disagreeing: still land paint a finer survey beats (needs tide)', () => {
        const index = buildChartAreaIndex({ LNDARE: fc(LAND(APPROACH)), DEPARE: fc(BAND(5, HARBOUR)) });
        const d = depthAlongLine(index, line);
        expect(d.landM).toBe(0);
        expect(d.landConflictM).toBeGreaterThan(1000);
    });
});

// ── The engine, end to end ──────────────────────────────────────────────────

/** A north–south strip any east–west route must cross, wider than the grid. */
const STRIP = (props: Record<string, unknown>) => rect(170.015, -41.3, 170.025, -40.7, props);
const SEA = (props: Record<string, unknown>) => rect(169.9, -41.3, 170.14, -40.7, { acronym: 'DEPARE', ...props });
const req = (extra: Partial<RouteRequest> = {}): RouteRequest => ({
    fromLat: -41.0,
    fromLon: 170.0,
    toLat: -41.0,
    toLon: 170.04,
    draftM: 2.4,
    safetyM: 0.5,
    resolutionM: 50,
    ...extra,
});
const ok = (r: ReturnType<typeof routeInshore>): RouteResult => {
    if (!('polyline' in r)) throw new Error(`no route: ${JSON.stringify(r)}`);
    return r;
};

describe('decision 12 — a route through the overview’s land paint over a detailed chart’s water', () => {
    // Cid Harbour, invented: the overview paints a strip of land across the
    // way, the general cell charts 0–30 m, the detailed chart 10–15 m.
    const layers: InshoreLayers = {
        LNDARE: fc(STRIP({ acronym: 'LNDARE', _scaleRank: OVERVIEW })),
        DEPARE: fc(
            SEA({ DRVAL1: 0, DRVAL2: 30, _scaleRank: GENERAL }),
            SEA({ DRVAL1: 10, DRVAL2: 15, _scaleRank: APPROACH }),
        ),
    } as InshoreLayers;
    const r = ok(routeInshore(layers, req()));

    it('nothing red the whole way: no caution, no charts-disagree', () => {
        expect(r.cautionMask?.some(Boolean)).toBe(false);
        expect(r.landPaintConflictMask?.some(Boolean) ?? false).toBe(false);
        expect((r.cautionWhy ?? []).some((w) => (w & CAUTION_WHY.DISAGREE) !== 0)).toBe(false);
        const states = inshoreSegmentStates(r);
        expect(states).not.toBeNull();
        // Nothing red (a one-segment line in open water may draw as the
        // deep tier's channel yellow; the colour that matters is no red).
        expect(states!.filter((s) => s === 'danger')).toEqual([]);
    });

    it('is saveable: no red without charted depth, no land, and the leg review finds 10 m and no danger', () => {
        expect(
            dangerWithoutChartedDepth({
                stateMask: inshoreSegmentStates(r),
                canalMask: r.canalMask,
                chartedShallowMask: r.chartedShallowMask,
                landPaintConflictMask: r.landPaintConflictMask,
                shallowRuns: r.shallowRuns,
            }),
        ).toEqual([]);
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        // Auto's review (the leg checker that said "Danger reported").
        const points = r.polyline.map(([lon, lat]) => ({ lat, lon }));
        const ctx = tracerContextFromLayers(layers, [], [169.99, -41.01, 170.05, -40.99], 2.4);
        const verdicts = validateTrace(points, ctx);
        for (const v of verdicts) {
            expect(v.grade).not.toBe('danger');
            expect(v.needsTide).toBe(false);
            expect(v.issues.map((i) => i.message)).not.toContain('depth data conflicts here — treat as unproven');
            expect(v.minDepthM).toBe(10);
        }
        // The stop-gap note is gone (item f, 2026-10-03). The leg review said
        // "overview chart shows land here; detailed chart charts water" while
        // the map still drew the overview's land under this green line; the
        // chart layer now draws the detailed chart's water over it
        // (tests/enc/scaleOrderedDrawing: wherever decision 12 ignores
        // overview land, the detailed water's draw band is above it), so a
        // clear leg says nothing about land that is not on the map.
        const notes = verdicts.flatMap((v) => v.issues).filter((i) => /overview chart/i.test(i.message));
        expect(notes).toEqual([]);
    });
});

describe('decision 12 — what stays', () => {
    it('two detailed charts disagreeing across the way: the crossing stays red, “charts disagree”', () => {
        const layers: InshoreLayers = {
            LNDARE: fc(STRIP({ acronym: 'LNDARE', _scaleRank: APPROACH })),
            DEPARE: fc(SEA({ DRVAL1: 10, DRVAL2: 15, _scaleRank: HARBOUR })),
        } as InshoreLayers;
        const r = ok(routeInshore(layers, req()));
        expect(r.cautionMask?.some(Boolean)).toBe(true);
        expect((r.cautionWhy ?? []).some((w) => (w & CAUTION_WHY.DISAGREE) !== 0)).toBe(true);
        expect(r.landPaintConflictMask?.some(Boolean)).toBe(true);
    });

    it('a detailed chart’s island over general water is land: the route goes round it', () => {
        // A 330 m × 330 m island only the 1:350,000 chart carries, in the
        // general cell's 10–30 m, right on the straight line.
        const island = rect(170.018, -41.0015, 170.022, -40.9985, { acronym: 'LNDARE', _scaleRank: COASTAL });
        const layers: InshoreLayers = {
            LNDARE: fc(island),
            DEPARE: fc(SEA({ DRVAL1: 10, DRVAL2: 30, _scaleRank: GENERAL })),
        } as InshoreLayers;
        const r = ok(routeInshore(layers, req()));
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        expect(hardLandAtPoint(layers)(170.02, -41.0)).toBe(true);
    });

    it('the overview’s land over a detailed chart’s water, with the detailed chart’s island in it (Armit Island)', () => {
        const island = rect(170.018, -41.0015, 170.022, -40.9985, { acronym: 'LNDARE', _scaleRank: APPROACH });
        const layers: InshoreLayers = {
            LNDARE: fc(STRIP({ acronym: 'LNDARE', _scaleRank: OVERVIEW }), island),
            DEPARE: fc(
                SEA({ DRVAL1: 0, DRVAL2: 30, _scaleRank: GENERAL }),
                SEA({ DRVAL1: 10, DRVAL2: 15, _scaleRank: APPROACH }),
            ),
        } as InshoreLayers;
        const r = ok(routeInshore(layers, req()));
        // The island is land; the water round it is the detailed chart's.
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        expect(hardLandAtPoint(layers)(170.02, -41.0)).toBe(true);
        expect(r.landPaintConflictMask?.some(Boolean) ?? false).toBe(false);
        expect((r.cautionWhy ?? []).some((w) => (w & CAUTION_WHY.DISAGREE) !== 0)).toBe(false);
    });
});
