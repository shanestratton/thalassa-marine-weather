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
