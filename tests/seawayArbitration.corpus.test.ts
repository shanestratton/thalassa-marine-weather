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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    });

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

    it('matches the pinned arbitration baseline (REGEN_ARBITRATION_BASELINE=1 to re-pin)', () => {
        if (REGEN) {
            writeFileSync(BASELINE_PATH, JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
            console.warn(`[arbitration] baseline regenerated → ${BASELINE_PATH}`);
            return;
        }
        const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { rows: ArbitrationRow[] };
        expect(rows).toEqual(baseline.rows);
    });
});
