/**
 * LOCAL — the lead-graph shadow's corpus table (Phase 3, 2026-10-01).
 *
 * Runs each committed corridor fixture through the real engine, then the
 * lead-graph search (services/seaway/leadGraphSearch) on that route's own
 * cached grid, and prints one row per passage: lead coverage, length, the
 * worst leg's detour, and whether Phase 3b would promote it — and if not,
 * why. Phase 3b promotes only when this table shows zero land, decision-11
 * and wrong-side regressions with every leg within the 1.35 cap.
 *
 * The fixtures are the committed ones the goldens use (tests/fixtures/
 * *.corridor.json.gz); this file adds no chart data. The lead graph is
 * compiled from the fixture's own NAVLNE / RECTRC (a fixture captured
 * without them reads 'no-usable-leads').
 *
 * Heavy (the real engine on four corridors), so it runs only on request:
 *   LEAD_SHADOW_CORPUS=1 NODE_OPTIONS=--max-old-space-size=4096 \
 *     npx vitest run --maxWorkers=1 tests/repro/leadShadow.corpus.local.test.ts
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteResult } from '../../services/inshoreRouterEngine';
import { compileLeadGraph, LEAD_UKC_M, type LeadCompilerLayers } from '../../services/routing/leadCompiler';
import { routeCachedGrid } from '../../services/seaway/seawayRouter';
import { leadPromotionVerdict, leadShadowSummary, searchLeadGraph } from '../../services/seaway/leadGraphSearch';
import { compileSeawayGraph } from '../../services/seaway/graphCompiler';
import { splitMarkFeatures, type PointFeatureLike } from '../../services/seaway/markSplit';
import { seawayGraphSafetyFault, seawayPromotionBlockReason } from '../../services/InshoreRouter';
import { assembleLayers, loadFixture } from '../helpers/corridorFixture';
import { REAL_AU_CHART_FIXTURES_RETIRED } from '../helpers/retiredChartFixtures';

const RUN = process.env.LEAD_SHADOW_CORPUS === '1';
const AIR_DRAFT_M = 18; // Serene Summer

const CORPUS = [
    'newport-rivergate-marks.corridor.json.gz',
    'newport-tangalooma.corridor.json.gz',
    'newport-shane.corridor.json.gz',
    'moreton-bay-tier2.corridor.json.gz',
];

describe.skipIf(!RUN || REAL_AU_CHART_FIXTURES_RETIRED)(
    'lead-graph shadow corpus (local) (real AU chart fixture retired; port: 127-C-a)',
    () => {
        it('produces a reasoned row for every corridor', { timeout: 600_000 }, () => {
            const rows: string[] = [];
            for (const file of CORPUS) {
                const fx = loadFixture(file);
                const layers = assembleLayers(fx);
                const req = fx.request;
                const direct = routeInshore(layers, req);
                expect('polyline' in direct, `${file}: the engine must route`).toBe(true);
                const result = direct as RouteResult;
                const grid = routeCachedGrid(layers, req, result);
                const graph = compileLeadGraph(fx.cells as unknown as LeadCompilerLayers, req.draftM, {}, LEAD_UKC_M, {
                    airDraftM: AIR_DRAFT_M,
                });
                const report = searchLeadGraph({
                    grid,
                    graph,
                    origin: { lat: req.fromLat, lon: req.fromLon },
                    destination: { lat: req.toLat, lon: req.toLon },
                    direct: result,
                });
                const marks = [
                    ...((layers as { BOYLAT?: { features: unknown[] } }).BOYLAT?.features ?? []),
                    ...((layers as { BCNLAT?: { features: unknown[] } }).BCNLAT?.features ?? []),
                ] as PointFeatureLike[];
                const { chartFeatures, unnumberedMarks } = splitMarkFeatures(marks);
                const gates =
                    chartFeatures.length + unnumberedMarks.length > 0
                        ? compileSeawayGraph({ chartFeatures, unnumberedMarks }).graph.gates
                        : [];
                const verdict = leadPromotionVerdict(report, result, layers, {
                    checks: {
                        blockReason: (r) => seawayPromotionBlockReason(r as never),
                        safetyFault: (polyline, l, r, strict, noTide) =>
                            seawayGraphSafetyFault(polyline, l, r as never, strict, noTide),
                    },
                    needM: req.draftM + (req.safetyM ?? 0.5),
                    ...(grid ? { grid } : {}),
                    gates,
                });
                // Invariants only: the numbers are telemetry for the Phase 3b read.
                if (report.route) {
                    expect(report.route.polyline.length).toBeGreaterThanOrEqual(2);
                    expect(report.route.leadCoverage).toBeGreaterThanOrEqual(0);
                    expect(report.route.leadCoverage).toBeLessThanOrEqual(1);
                    expect(report.route.channelSegMask).toHaveLength(report.route.polyline.length - 1);
                } else expect(report.reason).toBeDefined();
                rows.push(
                    `${file.replace('.corridor.json.gz', '')}: engine ${result.distanceNM.toFixed(2)} NM | lead graph ${graph.edges.length} edges | ${leadShadowSummary(report, verdict)}`,
                );
            }
            process.stdout.write(`\nLEAD SHADOW CORPUS\n${rows.join('\n')}\n`);
            expect(rows).toHaveLength(CORPUS.length);
        });
    },
);
