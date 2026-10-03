import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: async () => ({ status: 599, data: null }) } }));
vi.mock('../services/piTls', () => ({
    piRequest: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => false,
}));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: async () => [], listCells: () => [] }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: async () => null }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: () => false, baseUrl: 'http://test.invalid' },
}));
vi.mock('../services/OsmRouteOverlayService', () => ({ getOsmRouteOverlay: async () => null }));

import { seawayGraphSafetyFault, seawayPromotionBlockReason } from '../services/InshoreRouter';
import { chartClearanceBars } from '../services/routing/overheadClearance';
import { CAUTION_WHY, type InshoreLayers, type ShallowRunInfo } from '../services/engine/types';
import type { Feature, FeatureCollection } from 'geojson';

describe('Seaway promotion guard', () => {
    it('keeps engine tier routes when a canal/marina red mask is present', () => {
        expect(seawayPromotionBlockReason({ canalMask: [false, true, false] })).toBe(
            'tier-1 canal/marina mask present',
        );
    });

    it('keeps engine tier routes when the Newport egress gate chain is present', () => {
        expect(
            seawayPromotionBlockReason({
                debug: { threeTier: 'egress-channel×4 → tier2:chain×4 | tier3:passthrough +canalsnap' },
            }),
        ).toBe('engine egress-channel gate chain present');
    });

    it('allows graph promotion for plain inshore routes without a protected tier contract', () => {
        expect(seawayPromotionBlockReason({ debug: { threeTier: 'tier3:passthrough' } })).toBeNull();
    });
});

// Fix-up for Phase 2a round 2 (2026-09-30): a promoted graph route skipped
// the engine's final checks and dropped decision 7's tail.
describe('Seaway promotion guard — decision 7 and the engine’s final checks', () => {
    const tail = (endpointTail?: 'origin' | 'destination'): ShallowRunInfo => ({
        startSeg: 3,
        endSeg: 4,
        lengthM: 655,
        minDepthM: 1,
        midLat: -27.2,
        midLon: 153.1,
        ...(endpointTail ? { endpointTail } : {}),
    });

    it('keeps the engine route when it ends in a charted needs-tide tail', () => {
        expect(seawayPromotionBlockReason({ shallowRuns: [tail('destination')] })).toMatch(/needs-tide tail/);
        expect(seawayPromotionBlockReason({ shallowRuns: [tail('origin')] })).toMatch(/needs-tide tail/);
        // An ordinary shallow run is no reason on its own.
        expect(seawayPromotionBlockReason({ shallowRuns: [tail()] })).toBeNull();
    });

    it('keeps the engine route when it reports a pin off the water', () => {
        expect(seawayPromotionBlockReason({ pinOffWater: { destination: 'drying' } })).toMatch(/off the water/);
        expect(seawayPromotionBlockReason({ pinOffWater: { origin: 'land' } })).toMatch(/off the water/);
    });

    const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
    const cable: Feature = {
        type: 'Feature',
        properties: { acronym: 'CBLOHD', VERCLR: 10, rcid: 11 },
        geometry: {
            type: 'LineString',
            coordinates: [
                [153.1, -27.21],
                [153.11, -27.2],
            ],
        },
    };
    const engine = {
        polyline: [
            [153.09, -27.2],
            [153.09, -27.19],
        ] as [number, number][],
        debug: { hardLandTotalM: 0 },
    };

    it('declines a graph route that passes under a structure this mast cannot clear', () => {
        const layers = { OBSTRN: fc(...chartClearanceBars({ CBLOHD: [cable] }, 18)) } as InshoreLayers;
        const under: [number, number][] = [
            [153.1, -27.2],
            [153.11, -27.21],
        ];
        expect(seawayGraphSafetyFault(under, layers, engine)).toMatch(/overhead cable/);
        const clear: [number, number][] = [
            [153.09, -27.2],
            [153.09, -27.19],
        ];
        expect(seawayGraphSafetyFault(clear, layers, engine)).toBeNull();
    });

    it('declines a graph route that crosses more charted land than the engine route', () => {
        const land: Feature = {
            type: 'Feature',
            properties: { acronym: 'LNDARE' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [153.1, -27.205],
                        [153.101, -27.205],
                        [153.101, -27.195],
                        [153.1, -27.195],
                        [153.1, -27.205],
                    ],
                ],
            },
        };
        const layers = { LNDARE: fc(land) } as InshoreLayers;
        const across: [number, number][] = [
            [153.095, -27.2],
            [153.105, -27.2],
        ];
        expect(seawayGraphSafetyFault(across, layers, engine)).toMatch(/charted land/);
        expect(seawayGraphSafetyFault(across, layers, { ...engine, debug: { hardLandTotalM: 200 } })).toBeNull();
    });
});

describe('polylineTouchesBbox — the caveat counts the charts the route crosses', () => {
    const box: [number, number, number, number] = [153.0, -27.1, 153.1, -27.0];
    it('a vertex inside, or a segment across, touches; a route beside it does not', async () => {
        const { polylineTouchesBbox } = await import('../services/InshoreRouter');
        expect(polylineTouchesBbox([[153.05, -27.05]], box)).toBe(true);
        expect(
            polylineTouchesBbox(
                [
                    [152.9, -27.05],
                    [153.2, -27.05],
                ],
                box,
            ),
        ).toBe(true);
        expect(
            polylineTouchesBbox(
                [
                    [152.9, -27.2],
                    [153.2, -27.15],
                ],
                box,
            ),
        ).toBe(false);
    });
});

// Round 3 (2026-09-30): a PROMOTED Seaway route carried no canalMask and no
// offshoreMask. The planner (components/map/inshoreRouteState
// inshoreSegmentStates) calls a route verified only with every colour mask, so
// with SEAWAY_ROUTER_ENABLED = true every promoted route was drawn as grey
// 'unverified' dashes that could not be saved, exported or shared. It now
// gets both masks by the engine's own rules (engine/tierPipeline
// routeTierMasks), and renders and saves like an engine route.
describe('a promoted Seaway route renders and saves like an engine route', () => {
    const rectF = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
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
    const lat = -26.2;
    const layers: InshoreLayers = {
        DEPARE: fc(rectF(153.0, lat - 0.05, 153.2, lat + 0.05, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 })),
        // An OSM canal centre-line the route's first leg rides.
        CANAL: fc({
            type: 'Feature',
            properties: { waterway: 'canal' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.02, lat],
                    [153.05, lat],
                ],
            },
        }),
    };
    const polyline: [number, number][] = [
        [153.02, lat],
        [153.05, lat],
        [153.1, lat],
        [153.15, lat],
    ];
    const graph = {
        polyline,
        channelSegMask: [false, true, false],
        cautionSegMask: [false, false, false],
        lengthM: 12_500,
        edgesUsed: ['e1'],
        gateCount: 2,
        gateCompliance: 1,
        detourRatio: 1.05,
    };

    it('the old promoted shape (no canal / offshore masks) is unverified — the bug', async () => {
        const { inshoreSegmentStates } = await import('../components/map/inshoreRouteState');
        expect(
            inshoreSegmentStates({
                polyline,
                cautionMask: graph.cautionSegMask,
                channelMask: graph.channelSegMask,
            }),
        ).toBeNull();
    });

    it('now carries both masks, verified: canal red on the canal leg, yellow channel, teal', async () => {
        const { buildNavGrid } = await import('../services/engine/navGrid');
        const { promotedSeawayRoute } = await import('../services/InshoreRouter');
        const { inshoreSegmentStates } = await import('../components/map/inshoreRouteState');
        const grid = buildNavGrid(layers, [152.98, lat - 0.06, 153.22, lat + 0.06], 50, 2.4, 0.5, 60);
        const r = promotedSeawayRoute(
            graph,
            grid,
            layers,
            { draftM: 2.4, safetyM: 0.5 },
            { cellsUsed: ['T'], elapsedMs: 1 },
        );
        expect(r.canalMask).toEqual([true, true, false]);
        expect(r.offshoreMask).toEqual([false, false, false]);
        expect(inshoreSegmentStates(r)).toEqual(['danger', 'channel', 'green']);
        // The canal's red names its reason (the real-chart check, 2026-10-03).
        expect(r.cautionWhy).toEqual([CAUTION_WHY.CANAL, CAUTION_WHY.CANAL, 0]);
        expect(r.surveyRuns).toEqual([]);
        expect(r.debug?.seaway?.edgesUsed).toEqual(['e1']);
    });

    it('a vertex off the ENC grid is offshore (tier 4), as the pipeline has it', async () => {
        const { buildNavGrid } = await import('../services/engine/navGrid');
        const { promotedSeawayRoute } = await import('../services/InshoreRouter');
        const grid = buildNavGrid(layers, [152.98, lat - 0.06, 153.12, lat + 0.06], 50, 2.4, 0.5, 60);
        const r = promotedSeawayRoute(
            graph,
            grid,
            layers,
            { draftM: 2.4, safetyM: 0.5 },
            { cellsUsed: ['T'], elapsedMs: 1 },
        );
        expect(r.offshoreMask).toEqual([false, false, true]);
    });
});

// Round-4 review (2026-09-30): the engine's final hazard audit turns a charted
// hazard's buffer into caution; a promoted route only passed the mask to the
// tide depth. MEASURED on a promoted graph line: a drying rock (UWTROC VALSOU
// -1) 15 m off the line, inside a 60 m-wide 1.5 m band. The segment's tide
// depth was null (hazard), yet the 59 m backstop stretch drew needs-tide
// amber at a 2.5 m highest tide (round 3: red), with no chip, its window
// worked from the band's 1.5 m, not the rock.
describe('a promoted Seaway route keeps a charted hazard’s red whatever the tide', () => {
    const rectF = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
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
    const lat = -26.2;
    const mPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
    const bandW = 60 / mPerLon;
    const x0 = 153.1;
    const layers: InshoreLayers = {
        DEPARE: fc(
            rectF(153.0, lat - 0.05, 153.2, lat + 0.05, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 }),
            rectF(x0, lat - 0.05, x0 + bandW, lat + 0.05, { acronym: 'DEPARE', DRVAL1: 1.5, DRVAL2: 5 }),
        ),
        UWTROC: fc({
            type: 'Feature',
            properties: { acronym: 'UWTROC', VALSOU: -1 },
            geometry: { type: 'Point', coordinates: [x0 + bandW / 2, lat + 15 / 110_540] },
        }),
    };
    const graph = {
        polyline: [
            [153.05, lat],
            [153.09, lat],
            [153.11, lat],
            [153.15, lat],
        ] as [number, number][],
        channelSegMask: [false, true, false],
        cautionSegMask: [false, false, false],
        lengthM: 10_000,
        edgesUsed: ['e1'],
        gateCount: 2,
        gateCompliance: 1,
        detourRatio: 1.05,
    };

    it('the rock’s buffer is caution, its tide depth null — red at any tide', async () => {
        const { buildNavGrid } = await import('../services/engine/navGrid');
        const { promotedSeawayRoute } = await import('../services/InshoreRouter');
        const { inshoreRoutePieces, inshoreSegmentStates, routeTideDepths } =
            await import('../components/map/inshoreRouteState');
        const grid = buildNavGrid(layers, [152.98, lat - 0.06, 153.22, lat + 0.06], 50, 2.4, 0.5, 60);
        const r = promotedSeawayRoute(
            graph,
            grid,
            layers,
            { draftM: 2.4, safetyM: 0.5 },
            { cellsUsed: ['T'], elapsedMs: 1 },
        );
        expect(r.cautionMask).toEqual([false, true, false]);
        expect(r.tideDepthM?.[1]).toBeNull();
        expect(r.tideNeedM).toBeCloseTo(2.9, 9);
        const states = inshoreSegmentStates(r)!;
        for (const highestM of [2.5, 6]) {
            const drawn = inshoreRoutePieces(r.polyline, states, r.surveyRuns, r.chartedShallowSpans ?? [], {
                depthM: routeTideDepths(r),
                needM: 2.9,
                highestM,
            });
            // Nothing across the band is amber: the rock is not the tide's to lift.
            expect(
                drawn.filter((p) => p.state === 'tide'),
                `highest ${highestM}`,
            ).toEqual([]);
            // Across the band (u 1.5–1.53): red.
            const uBand = 1 + (x0 + bandW / 2 - 153.09) / 0.02;
            expect(drawn.find((p) => p.u0 < uBand && p.u1 > uBand)?.state).toBe('danger');
        }
    });
});

// Round-3 review (2026-09-30): a promoted Seaway route drew strict-policy
// uncharted water as clean teal or yellow, and round 3 made such routes
// verified and saveable. The graph sampler reads red only from land or
// charted-shallow cells, and a no-evidence cell is UNKNOWN_OPEN (0); the
// engine's own caution and its >1 NM 'uncharted-corridor' refusal ran only
// inside routeInshore. The dog-leg channel (S-57 DEPARE, strict) with a 400 m
// strip no chart covers.
describe('a promoted Seaway route is held to the engine’s uncharted-water rules (strict)', () => {
    const rectF = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
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
    const LAT = -27.2;
    const M_PER_LAT = 110_540;
    const mPerLon = 111_320 * Math.cos((LAT * Math.PI) / 180);
    const STEP = 500;
    const LEG1 = Array.from({ length: 4 }, (_, k) => 165.13 + (k * STEP) / mPerLon);
    const BEND = 165.13 + (4 * STEP) / mPerLon;
    const LEG2 = Array.from({ length: 4 }, (_, k) => LAT + ((k + 1) * STEP) / M_PER_LAT);
    const pair = (lon: number, lat: number, half: number, axis: 'E' | 'N', k: number): Feature[] => [
        {
            type: 'Feature',
            properties: { CATLAM: 1, OBJNAM: `G${k * 2 + 1}` },
            geometry: { type: 'Point', coordinates: axis === 'E' ? [lon, lat + half] : [lon - half, lat] },
        },
        {
            type: 'Feature',
            properties: { CATLAM: 2, OBJNAM: `G${k * 2 + 2}` },
            geometry: { type: 'Point', coordinates: axis === 'E' ? [lon, lat - half] : [lon + half, lat] },
        },
    ];
    const marks = fc(
        ...LEG1.flatMap((lon, k) => pair(lon, LAT, 0.0009, 'E', k)),
        ...LEG2.flatMap((lat, k) => pair(BEND, lat, 0.0009 * (mPerLon / M_PER_LAT), 'N', 4 + k)),
    );
    const band = (x0: number, y0: number, x1: number, y1: number) =>
        rectF(x0, y0, x1, y1, { acronym: 'DEPARE', DRVAL1: 12, DRVAL2: 20 });
    /** S-57 water over the whole box except a strip [s0, s1] (lon) no chart covers. */
    const withGap = (s0: number, s1: number) => ({
        DEPARE: fc(band(165.05, -27.28, s0, -27.1), band(s1, -27.28, 165.3, -27.1)),
        BOYLAT: marks,
    });
    const req = {
        fromLat: LAT,
        fromLon: 165.11,
        toLat: LAT + (5 * STEP) / M_PER_LAT,
        toLon: BEND,
        draftM: 2.0,
        safetyM: 0.5,
        resolutionM: 50,
        unchartedPolicy: 'strict' as const,
    };

    it('a 400 m uncharted strip on the approach is caution on the promoted route, as on the engine’s', async () => {
        const { routeInshore } = await import('../services/inshoreRouterEngine');
        const { shadowCompare } = await import('../services/seaway/seawayRouter');
        const { promotedSeawayRoute } = await import('../services/InshoreRouter');
        const { inshoreSegmentStates } = await import('../components/map/inshoreRouteState');
        // The strip: 400 m of lon between the origin and the first gate.
        const s0 = 165.117;
        const s1 = s0 + 400 / mPerLon;
        const layers = withGap(s0, s1) as InshoreLayers;
        const engine = routeInshore(layers, req);
        if ('error' in engine) throw new Error(engine.error);
        const report = shadowCompare(layers, req, engine);
        const g = report?.graph;
        expect(g, report?.reason).toBeTruthy();
        const r = promotedSeawayRoute(g!, report!.grid, layers, req, { cellsUsed: ['T'], elapsedMs: 1 });
        const states = inshoreSegmentStates(r)!;
        expect(states).not.toBeNull();
        // Every segment that crosses the strip is red, never teal or yellow.
        const crosses = (i: number) => {
            const a = r.polyline[i][0];
            const b = r.polyline[i + 1][0];
            return Math.max(a, b) > s0 && Math.min(a, b) < s1;
        };
        const over = states.map((st, i) => (crosses(i) ? st : null)).filter((x) => x !== null);
        expect(over.length).toBeGreaterThan(0);
        expect(
            over.every((st) => st === 'danger'),
            JSON.stringify(states),
        ).toBe(true);
        // Without the strict policy nothing changes (permissive routes are
        // for fixtures and legacy callers).
        const lax = promotedSeawayRoute(
            g!,
            report!.grid,
            layers,
            { draftM: 2, safetyM: 0.5 },
            { cellsUsed: [], elapsedMs: 1 },
        );
        expect(lax.cautionMask).toEqual(g!.cautionSegMask);
    });

    it('declines a graph route with more uncharted water than the engine route', async () => {
        const { seawayGraphSafetyFault } = await import('../services/InshoreRouter');
        const { buildNavGrid } = await import('../services/engine/navGrid');
        // A strip on leg 2 only: the graph (around the bend) crosses it.
        const layers = {
            DEPARE: fc(band(165.05, -27.28, 165.3, LAT + 0.009), band(165.05, LAT + 0.0126, 165.3, -27.1)),
        } as InshoreLayers;
        const grid = buildNavGrid(layers, [165.0, -27.3, 165.35, -27.08], 50, 2, 0.5, 30);
        const engineLine: [number, number][] = [
            [165.11, LAT],
            [165.2, LAT],
        ];
        const graphLine: [number, number][] = [
            [165.11, LAT],
            [BEND, LAT],
            [BEND, LAT + 0.02],
        ];
        expect(
            seawayGraphSafetyFault(graphLine, layers, { polyline: engineLine, debug: { hardLandTotalM: 0 } }, { grid }),
        ).toMatch(/no chart vouches/);
        // Not strict: the old checks only.
        expect(
            seawayGraphSafetyFault(graphLine, layers, { polyline: engineLine, debug: { hardLandTotalM: 0 } }),
        ).toBeNull();
        // The engine route crossing the same strip: no more than it, passes.
        expect(
            seawayGraphSafetyFault(graphLine, layers, { polyline: graphLine, debug: { hardLandTotalM: 0 } }, { grid }),
        ).toBeNull();
    });
});
