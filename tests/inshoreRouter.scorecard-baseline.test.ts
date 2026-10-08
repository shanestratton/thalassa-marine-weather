/**
 * Scorecard baseline — Masterplan Stage I, Phase 1.
 *
 * Runs the route-quality scorecard over both real-chart golden fixtures
 * and compares against the committed baseline
 * (tests/fixtures/scorecard-baseline.json). Every masterplan phase is
 * judged as a delta against these numbers.
 *
 * Regenerate (ONLY with explicit masterplan-phase justification in the
 * commit message):
 *
 *   REGEN_SCORECARD_BASELINE=1 NODE_OPTIONS="--max-old-space-size=8192" \
 *     npx vitest run tests/inshoreRouter.scorecard-baseline.test.ts
 *
 * The test then WRITES the baseline from live behaviour instead of
 * asserting, and the diff shows exactly what moved.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteResult } from '../services/inshoreRouterEngine';
import { loadFixture, assembleLayers } from './helpers/corridorFixture';
import { scoreRoute, type RouteScore } from './helpers/routeScorecard';

const BASELINE_PATH = join(__dirname, 'fixtures', 'scorecard-baseline.json');
const REGEN = process.env.REGEN_SCORECARD_BASELINE === '1';

interface BaselineEntry {
    distanceRatio: number;
    turnCount: number;
    cautionRuns: number;
    cautionTotalM: number;
    lengthM: number;
}
type Baseline = Record<string, BaselineEntry>;

function liveScore(fixtureName: string): BaselineEntry {
    const fx = loadFixture(fixtureName);
    const r = routeInshore(assembleLayers(fx), fx.request);
    if ('error' in r) throw new Error(`golden fixture failed to route: ${r.error}`);
    const score: RouteScore = scoreRoute({
        polyline: (r as RouteResult).polyline,
        from: { lat: fx.request.fromLat, lon: fx.request.fromLon },
        to: { lat: fx.request.toLat, lon: fx.request.toLon },
        cautionMask: (r as RouteResult).cautionMask,
    });
    return {
        distanceRatio: Number(score.distanceRatio.toFixed(4)),
        turnCount: score.turnCount,
        cautionRuns: score.cautionRunLengthsM.length,
        cautionTotalM: Math.round(score.cautionRunLengthsM.reduce((s, v) => s + v, 0)),
        lengthM: Math.round(score.lengthM),
    };
}

// RE-PIN (2026-09-30, Phase 2a rounds 1 and 2) — newport-tangalooma only,
// the two numbers that left their ±2% band (the rest still pass as pinned):
//   distanceRatio 1.2008 → 1.2728, lengthM 34041 → 36080 m.
//   • 34041 → 35886 m (round 1): Pass 4 and the Pass 5b lead brush no longer
//     paint 5 m over FAIRWY / DRGARE / leads, and owner decision 1 (fixture
//     ranked as production ranks it) decides where the overview's Moreton
//     Island land paint stands — jointly (reverting the rescues alone 36308 m,
//     decision 1 alone 33502 m, all three 34041 m again). The 34041 m route
//     crossed 862 m of charted land by today's audit.
//   • 35886 → 36080 m (round 2, owner decision 7): the pin sits in charted
//     decision-1 water and the route now runs on to it (a ~1.0 km 'needs
//     tide' tail) instead of stopping 429 m short.
// Measured alongside (not re-pinned, still inside their bounds): turnCount
// 21 → 16, caution 2946 → 3141 m over 7 → 3 runs.
//
// REGENERATED (2026-09-30, Phase 2a round-2 fix-up) with
// REGEN_SCORECARD_BASELINE=1 — the round-2 Tangalooma row had been
// hand-edited (live distance and length beside HEAD's turns and caution, a
// row that described no real route) and the bounds let a 44% turn regression
// pass. Every number is now one live route, each also measured in its own
// process (tests/inshoreRouter.golden.test.ts, same routes):
//   newport-rivergate  distanceRatio 1.7192 → 1.7895, lengthM 41316 → 43005,
//                      turns 13 → 13, caution 14303 m / 3 runs → 22082 m / 3.
//   newport-tangalooma distanceRatio 1.2728 → 1.3298, lengthM 36080 → 37697,
//                      turns 21 → 24, caution 2946 m / 7 runs → 13940 m / 3.
// Why they moved:
//   • both: a charted shallow S-57 band now stands against a later deep
//     band that is neither S-57 nor OSM-vouched — the captures' GMRT public
//     bathymetry (grade D) used to upgrade it to deep in one feature order
//     (navGrid Pass 1, the shallowest-wins fix). Rivergate 41618 → 43005 m;
//     Tangalooma 36872 → 37697 m.
//   • Tangalooma: the decision-7 tail may no longer run through decision-1
//     water whose finest band is 0 m (owner decision 2), and prefers deeper
//     water (tail step weight): 36080 → 36872 m, the tail 1036 m through 0 m
//     → 1906 m (finest survey 5 m, under the coarser chart's land paint).
//
// REGENERATED (round-3 review fix-up, 2026-09-30) with
// REGEN_SCORECARD_BASELINE=1; each route also measured in its own process
// (tests/inshoreRouter.golden.test.ts, same routes):
//   newport-rivergate  distanceRatio 1.7895 → 1.7909, lengthM 43005 → 43040,
//                      turns 13 → 16, caution 22082 m / 3 runs → 26520 m / 4.
//   newport-tangalooma distanceRatio 1.3298 → 1.3303, lengthM 37697 → 37710,
//                      turns 24 → 23, caution 13940 m / 3 runs → 15253 m / 3.
// Why they moved: the OSM overlay's water polygons (a synthetic 10 m) no
// longer outrank the chart's own S-57 bands, nor beat land paint over a band
// that dries (navGrid Pass 1/2). The Newport canal's 0–2 m band and the
// Brisbane River mouth's -2.2..0 m band are honest caution (or drying land)
// now: Rivergate crosses 30 m of charted drying ground instead of ~2.9 km,
// with 3 more turns threading the mouth; more of both routes is red.
//
// REGENERATED (package 125-06, 2026-10-09) with REGEN_SCORECARD_BASELINE=1.
// The committed rows had gone stale since (live at 5bc8d317: Rivergate
// 1.7883 / 42976 m / 11 turns / 18112 m caution over 3 runs; Tangalooma
// 1.3047 / 36984 m / 11 turns / 6662 m over 2 — its ratio 1.9% under the
// pin). The same-tide pull (engine/stringPull sameTideNoWorse: a turn that
// buys no tide is no turn; Shane, 2026-10-08) takes both out of the Newport
// entrance over the 2–5 m band charted 2.0 m on the line they are going,
// not north-east to 5 m water first:
//   newport-rivergate  distanceRatio 1.7883 → 1.7807, lengthM 42976 → 42794,
//                      turns 11 → 10, caution 18112 m / 3 runs → 18556 m / 3.
//   newport-tangalooma distanceRatio 1.3047 → 1.2761, lengthM 36984 → 36173,
//                      turns 11 → 11, caution 6662 m / 2 runs → 7542 m / 2.
// The caution added is that band's own water, never shallower than 2.0 m.
const FIXTURES = ['newport-rivergate.corridor.json.gz', 'newport-tangalooma.corridor.json.gz'];

describe('scorecard baseline (golden fixtures)', () => {
    if (REGEN) {
        it('REGENERATES the committed baseline from live behaviour', () => {
            const baseline: Baseline = {};
            for (const f of FIXTURES) baseline[f] = liveScore(f);
            writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');

            console.error(`[scorecard-baseline] regenerated → ${BASELINE_PATH}\n${JSON.stringify(baseline, null, 2)}`);
            expect(existsSync(BASELINE_PATH)).toBe(true);
        });
        return;
    }

    it('committed baseline exists (run with REGEN_SCORECARD_BASELINE=1 once to create)', () => {
        expect(existsSync(BASELINE_PATH), 'missing tests/fixtures/scorecard-baseline.json').toBe(true);
    });

    if (!existsSync(BASELINE_PATH)) return;
    const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

    for (const f of FIXTURES) {
        describe(f, () => {
            const live = liveScore(f);
            const base = baseline[f];

            it('has a baseline entry', () => {
                expect(base, `no baseline entry for ${f} — regenerate`).toBeTruthy();
            });
            if (!base) return;

            it(`distanceRatio within ±2% (baseline ${base.distanceRatio})`, () => {
                expect(live.distanceRatio).toBeGreaterThan(base.distanceRatio * 0.98);
                expect(live.distanceRatio).toBeLessThan(base.distanceRatio * 1.02);
            });

            it(`route length within ±2% (baseline ${base.lengthM} m)`, () => {
                expect(live.lengthM).toBeGreaterThan(base.lengthM * 0.98);
                expect(live.lengthM).toBeLessThan(base.lengthM * 1.02);
            });

            it(`turnCount ≤ baseline + 2 (baseline ${base.turnCount})`, () => {
                expect(live.turnCount).toBeLessThanOrEqual(base.turnCount + 2);
            });

            it(`caution total ≤ baseline + 25% (baseline ${base.cautionTotalM} m over ${base.cautionRuns} runs)`, () => {
                expect(live.cautionTotalM).toBeLessThanOrEqual(Math.ceil(base.cautionTotalM * 1.25));
            });
        });
    }
});
