/**
 * Phase 12/13 — the ARBITRATION CORPUS (masterplan §3, collab replies
 * 21/22). Runs every corpus passage through the real engine, shadows it
 * with the Seaway Graph, and tabulates graph-vs-baseline so the Phase 13
 * promotion gate decides on NUMBERS, not vibes.
 *
 * Corpus = the two real-chart golden corridors + the DOG-LEG channel —
 * the fixture B's review called the highest-value gap: a bent channel
 * where the direct A* line legally cuts the corner through deep water
 * while the gate sequence goes around. On-axis fixtures pin composition;
 * this one pins routing DIFFERENCE, which is what arbitration judges.
 *
 * Baseline file: tests/fixtures/seaway-arbitration-baseline.json
 * Regenerate:    REGEN_ARBITRATION_BASELINE=1 npx vitest run tests/seawayArbitration.corpus.test.ts
 *
 * Assertions here are INVARIANTS (report exists, ratios sane, dog-leg
 * difference is real); the exact numbers live in the baseline so engine
 * churn shows up as a reviewed diff, not a silent drift.
 *
 * Exclusive lon-region: 164.0x (B's shadow fixtures hold 163.x).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, FeatureCollection } from 'geojson';
import { routeInshore, type RouteRequest, type RouteResult } from '../services/inshoreRouterEngine';
import { shadowCompare, type SeawayShadowReport } from '../services/seaway/seawayRouter';
import { loadFixture, assembleLayers } from './helpers/corridorFixture';

const BASELINE_PATH = join(__dirname, 'fixtures', 'seaway-arbitration-baseline.json');
const REGEN = process.env.REGEN_ARBITRATION_BASELINE === '1';

// ── Synthetic chart helpers (seawayShadow.test.ts conventions) ──────

function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}

function fc(...features: Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

/** Numbered lateral pair perpendicular to the channel axis. `axis` is
 *  the direction of buoyage: 'E' puts port north of the line, 'N' puts
 *  port west — IALA A, returning from sea. */
function gatePair(lon: number, lat: number, halfDeg: number, axis: 'E' | 'N', key: string, gateIdx: number): Feature[] {
    const portCoord: [number, number] = axis === 'E' ? [lon, lat + halfDeg] : [lon - halfDeg, lat];
    const stbdCoord: [number, number] = axis === 'E' ? [lon, lat - halfDeg] : [lon + halfDeg, lat];
    return [
        {
            type: 'Feature',
            properties: { CATLAM: 1, OBJNAM: `${key}${gateIdx * 2 + 1}` },
            geometry: { type: 'Point', coordinates: portCoord },
        },
        {
            type: 'Feature',
            properties: { CATLAM: 2, OBJNAM: `${key}${gateIdx * 2 + 2}` },
            geometry: { type: 'Point', coordinates: stbdCoord },
        },
    ];
}

const isResult = (r: ReturnType<typeof routeInshore>): r is RouteResult => 'polyline' in r;

// ── The dog-leg channel (lon 164.05–164.30) ─────────────────────────
//
// Leg 1 runs east along lat -27.2 (4 gates), then the channel turns
// ~90° and runs north (4 gates) — one continuously-numbered channel
// ('D1'…'D16') so the extractor chains it through the bend. Water is
// uniformly deep everywhere, so the engine's direct line is free to cut
// the corner diagonally; the graph must go around via the gates.

const DOG_LAT = -27.2;
const M_PER_LAT = 110_540;
const mPerLon = 111_320 * Math.cos((DOG_LAT * Math.PI) / 180);
const GATE_STEP_M = 500;
const LEG1_LONS = Array.from({ length: 4 }, (_, k) => 164.13 + (k * GATE_STEP_M) / mPerLon);
const BEND_LON = 164.13 + (4 * GATE_STEP_M) / mPerLon;
const LEG2_LATS = Array.from({ length: 4 }, (_, k) => DOG_LAT + ((k + 1) * GATE_STEP_M) / M_PER_LAT);

function dogLegCase(): CorpusCase {
    const layers = {
        DEPARE: fc(rect(164.05, -27.28, 164.3, -27.1, { DRVAL1: 12, DRVAL2: 20 })),
        BOYLAT: fc(
            ...LEG1_LONS.flatMap((lon, k) => gatePair(lon, DOG_LAT, 0.0009, 'E', 'D', k)),
            ...LEG2_LATS.flatMap((lat, k) => gatePair(BEND_LON, lat, 0.0009 * (mPerLon / M_PER_LAT), 'N', 'D', 4 + k)),
        ),
    };
    const req: RouteRequest = {
        fromLat: DOG_LAT,
        fromLon: 164.11,
        toLat: DOG_LAT + (5 * GATE_STEP_M) / M_PER_LAT,
        toLon: BEND_LON,
        draftM: 2.0,
        safetyM: 0.5,
        resolutionM: 50,
    };
    return { name: 'dog-leg-channel', layers, req };
}

// ── Corpus assembly ─────────────────────────────────────────────────

interface CorpusCase {
    name: string;

    layers: any;
    req: RouteRequest;
}

function goldenCase(file: string): CorpusCase {
    const fx = loadFixture(file);
    return { name: file.replace('.corridor.json.gz', ''), layers: assembleLayers(fx), req: fx.request };
}

interface ArbitrationRow {
    name: string;
    directNM: number;
    shadow:
        | { kind: 'no-marks' }
        | { kind: 'fail'; reason: string }
        | {
              kind: 'graph';
              graphNM: number;
              detourRatio: number;
              pctOnGraph: number;
              gateCount: number;
              channelGatesTotal: number;
              gateCompliance: number | null;
              entryNodeId: string;
              exitNodeId: string;
          };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function arbitrate(c: CorpusCase): { row: ArbitrationRow; direct: RouteResult; report: SeawayShadowReport | null } {
    const direct = routeInshore(c.layers, c.req);
    expect(isResult(direct), `${c.name}: engine must route (corpus precondition)`).toBe(true);
    if (!isResult(direct)) throw new Error('unreachable');

    const report = shadowCompare(c.layers, c.req, direct);
    let shadow: ArbitrationRow['shadow'];
    if (report === null) {
        shadow = { kind: 'no-marks' };
    } else if (!report.graph) {
        shadow = { kind: 'fail', reason: report.reason ?? 'unknown' };
    } else {
        const g = report.graph;
        shadow = {
            kind: 'graph',
            graphNM: r2(g.lengthM / 1852),
            detourRatio: r3(g.detourRatio),
            pctOnGraph: r3(g.pctOnGraph),
            gateCount: g.gateCount,
            channelGatesTotal: g.channelGatesTotal,
            gateCompliance: g.gateCompliance === null ? null : r3(g.gateCompliance),
            entryNodeId: g.entryNodeId,
            exitNodeId: g.exitNodeId,
        };
    }
    return { row: { name: c.name, directNM: r2(direct.distanceNM), shadow }, direct, report };
}

describe('seaway arbitration corpus — graph vs Stage II baseline', () => {
    const cases: CorpusCase[] = [
        goldenCase('newport-rivergate.corridor.json.gz'),
        goldenCase('newport-tangalooma.corridor.json.gz'),
        // Fresh live capture (tools/capture-corridor-fixture.mjs, collab
        // reply 22/31): the SAME Newport→Rivergate passage but WITH its
        // real lateral marks (BOYLAT 36 + BCNLAT 314). The goldens above
        // predate mark emission and shadow as 'no-marks'; this is the
        // real-chart corridor the Phase 13 promotion gate runs against.
        goldenCase('newport-rivergate-marks.corridor.json.gz'),
        dogLegCase(),
    ];
    const rows: ArbitrationRow[] = [];
    const byName: Record<string, { row: ArbitrationRow; direct: RouteResult; report: SeawayShadowReport | null }> = {};

    it('every corpus passage produces a row — a report, or a reasoned skip, never a silent drop', () => {
        for (const c of cases) {
            const out = arbitrate(c);
            rows.push(out.row);
            byName[c.name] = out;
        }
        expect(rows.length).toBe(cases.length);

        // Tabulate for the Phase 13 promotion read (visible in CI output).
        const table = rows
            .map((r) =>
                r.shadow.kind === 'graph'
                    ? `${r.name}: direct ${r.directNM} NM | graph ${r.shadow.graphNM} NM (detour ${r.shadow.detourRatio}, onGraph ${r.shadow.pctOnGraph}, gates ${r.shadow.gateCount}/${r.shadow.channelGatesTotal}, compliance ${r.shadow.gateCompliance})`
                    : `${r.name}: direct ${r.directNM} NM | shadow ${r.shadow.kind === 'fail' ? r.shadow.reason : 'no lateral marks'}`,
            )
            .join('\n');
        console.warn(`\nARBITRATION CORPUS\n${table}\n`);
    }, 180_000); // real engine on 4 corridors; coverage instrumentation is substantially slower

    it('graph rows respect sanity bounds (ratios, fractions, §3 detour cap context)', () => {
        for (const r of rows) {
            if (r.shadow.kind !== 'graph') continue;
            expect(r.shadow.detourRatio, `${r.name} detourRatio`).toBeGreaterThan(0.5);
            expect(r.shadow.pctOnGraph, `${r.name} pctOnGraph`).toBeGreaterThanOrEqual(0);
            expect(r.shadow.pctOnGraph, `${r.name} pctOnGraph`).toBeLessThanOrEqual(1);
            if (r.shadow.gateCompliance !== null) {
                expect(r.shadow.gateCompliance, `${r.name} compliance`).toBeGreaterThanOrEqual(0);
                expect(r.shadow.gateCompliance, `${r.name} compliance`).toBeLessThanOrEqual(1);
            }
        }
    });

    it('dog-leg: the graph route exists, goes AROUND the bend, and genuinely differs from the corner-cutting direct line', () => {
        const dog = byName['dog-leg-channel'];
        expect(dog.report, 'dog-leg must produce a report (marks exist)').not.toBeNull();
        expect(dog.report?.graph, `dog-leg graph route (reason: ${dog.report?.reason ?? 'none'})`).toBeTruthy();
        const g = dog.report!.graph!;

        // Around-the-bend: the graph threads most of the 8-gate sequence.
        expect(g.gateCount).toBeGreaterThanOrEqual(6);

        // Genuine difference: corner-cut direct is the hypotenuse, the
        // graph rides both legs — the graph must be measurably longer
        // than the direct line, and still inside the §3 detour cap.
        expect(g.detourRatio).toBeGreaterThan(1.05);
        expect(g.detourRatio).toBeLessThanOrEqual(1.35);
    });

    it('real-marks corridor: it SHADOWS (marks present, never a silent no-marks drop) with a reasoned outcome', () => {
        const real = byName['newport-rivergate-marks'];
        // The whole point of the fresh capture: unlike the goldens this
        // corridor carries real lateral marks, so shadowCompare MUST
        // engage — a report, never null.
        expect(real.report, 'real-marks corridor must produce a report (marks exist)').not.toBeNull();
        // Real gates were discovered (not an empty graph).
        expect(real.report!.gatesTotal, 'real-marks gatesTotal').toBeGreaterThan(0);
        // Outcome is either a graph route OR a reasoned fail — both are
        // legitimate arbitration signals; the baseline pins which. As of
        // capture the Brisbane River corridor returns 'no-compliant-path'
        // (graph finds entry/exit/path through ~98 gates but the Phase-13
        // cross-line validator rejects every resolve round) — that is the
        // promotion-blocking signal this fixture exists to surface, NOT a
        // fixture defect. If a future engine change flips it to a graph
        // route, re-pin and celebrate.
        expect(real.row.shadow.kind === 'graph' || real.row.shadow.kind === 'fail').toBe(true);
    });

    it('matches the pinned arbitration baseline (REGEN_ARBITRATION_BASELINE=1 to re-pin)', () => {
        if (REGEN) {
            writeFileSync(BASELINE_PATH, JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
            console.warn(`[arbitration] baseline regenerated → ${BASELINE_PATH}`);
            return;
        }
        // RE-PIN directNM (2026-09-30, Phase 2a rounds 1 and 2; every shadow
        // outcome unchanged), each measured in its own process:
        //   • newport-rivergate 22.61 → 22.47 (round 1): Pass 4 and the Pass
        //     5b lead brush no longer paint 5 m, and owner decision 1 decides
        //     the land paint (reverting all three: 22.61 again).
        //   • newport-tangalooma 18.38 → 19.38 (round 1, the same three,
        //     jointly — see the golden's re-pin) → 19.48 (round 2, owner
        //     decision 7: the route runs on to the pin in decision-1 water).
        //   • newport-rivergate-marks 19.21 → 18.33 (round 1: the two rescue
        //     removals and decision 1; reverting them gives 19.26 — the last
        //     0.05 NM, by round 2's own ablation, is round 1's DRGARE depth
        //     pass and Pass-1 protection reset, which read a dredged area's
        //     own DRVAL1 and drop a coarser band's protection under a finer
        //     claim; reverting those too gives 19.21) → 27.88
        //     (round 2, owner decision 7, symmetric at both ends): this
        //     capture has no OSM overlay, so the Newport pin sits in charted
        //     decision-1 water and the Rivergate pin in the river's charted
        //     water. The route now leaves and arrives through that charted
        //     water — 5.9 km and 9.4 km 'needs tide' tails, the nearest water
        //     deep enough for a 2.4 m keel through it — instead of relaxing
        //     1.6 km of charted land across the Newport peninsula (audit
        //     1590 → 71 m). Production merges the OSM overlay, where both
        //     pins are OSM water and nothing changes (the chartLeads goldens).
        // RE-PIN directNM again (2026-09-30, Phase 2a round-2 fix-up; every
        // shadow outcome unchanged; each measured in its own process):
        //   • newport-rivergate 22.47 → 23.22 and newport-tangalooma 19.48 →
        //     19.91 → 20.35: see the goldens' re-pins (a charted shallow S-57
        //     band stands against the capture's later GMRT deep bands; the
        //     Tangalooma tail avoids 0 m decision-1 water).
        //   • newport-rivergate-marks 27.88 → 17.85: owner decision 2 — the
        //     Newport pin's water is the harbour cell's 0–2 m canal band under
        //     every cell's land paint, which is no charted pin now (decision-1
        //     water qualifies only when its finest band is deep enough), so
        //     this permissive run departs as in round 1, relaxing the charted
        //     peninsula (audit 1729 m; the strict production policy refuses
        //     it, tests/inshoreRouter.chartLeads). Reverting that rule alone:
        //     21.48 NM. The Rivergate end keeps its decision-7 tail through
        //     the river's deep-finest decision-1 water — 9.5 → 11.3 km with
        //     depth-weighted tail steps and decision 2 (never through its 0 m
        //     cells), labelled for the coarser land paint (finest survey 5 m).
        // RE-PIN directNM (round-3 review fix-up, 2026-09-30; every shadow
        // outcome unchanged; regenerated, and each golden measured in its own
        // process): newport-rivergate 23.22 → 23.24, newport-tangalooma
        // 20.35 → 20.36 — OSM water no longer outranks the chart's own S-57
        // bands nor beats land paint over a drying band (navGrid Pass 1/2;
        // see the goldens' re-pins). newport-rivergate-marks and dog-leg:
        // unchanged.
        // RE-PIN directNM (D12 fix-up, 2026-10-03; owner decision 12, Shane:
        // "Trust the detailed chart"; every shadow outcome unchanged;
        // regenerated, each golden measured in its own process):
        //   • newport-rivergate 23.24 → 23.23 and newport-tangalooma 20.36 →
        //     20.18: the overview cells' land paint over the finer cells'
        //     never-drying water is no 'charts disagree' caution (see the
        //     goldens' re-pins; Tangalooma's decision-1 tail is gone).
        //   • newport-rivergate-marks 17.85 → 22.75: this chart-only,
        //     permissive capture still relaxes the charted Newport peninsula
        //     (decision 2; audit 1,729 → 1,486 m), but past it the overview's
        //     land over the harbour cells' bands no longer prices the bay as
        //     40× caution, so it leaves by another way and 'charts disagree'
        //     goes 15,815 → 3,979 m. Its shadow stays fail / no-compliant-path
        //     (the first D12 build turned it into a degenerate 'graph' row —
        //     entry = exit node BC#0/h19, 1 of 5 gates, 0 % on the graph — which
        //     is no success, and is gone with drying bands keeping their land).
        // RE-PIN directNM (round 2 item a, any-angle string pulling,
        // 2026-10-03; every shadow outcome unchanged; regenerated, each golden
        // measured in its own process): engine/stringPull pulls the four-tier
        // route's grid stairs taut where a chord is at least as safe, and
        // threads a lateral gate crossed close by a mark through its centre.
        //   • newport-rivergate 23.23 → 23.22, newport-tangalooma 20.18 →
        //     20.16, newport-rivergate-marks 22.75 → 22.74: shorter by the
        //     stairs (red never longer; see the goldens' re-pins).
        //   • dog-leg-channel 2.58 → 2.55: the engine route, which cuts the
        //     corner across uniformly deep water as this case is built to,
        //     loses its one bend (3 → 2 points): a straight line with no mark
        //     between it and the bend. Its graph route is 3.39 NM as before,
        //     so its detourRatio against the shorter engine line reads 1.314 →
        //     1.328.
        const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { rows: ArbitrationRow[] };
        expect(rows).toEqual(baseline.rows);
    });
});
