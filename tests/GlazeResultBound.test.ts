/**
 * Every bound in clipDepareOverlap guarded an INPUT. None looked at the
 * result — and this file's own header had named the result as the next
 * suspect if round 2 still crashed. Round 2 still crashed (Lady Musgrave,
 * 53 renderer deaths), and turning the clip off stopped it.
 *
 * martinez can return far more geometry than it consumes: subtract a
 * fragmented reef coverage from a depth band and one polygon shatters into
 * hundreds of slivers. That result then (a) becomes the SUBJECT of the next
 * fine in the loop, so growth compounds, (b) accumulates into the returned
 * feature, and (c) is structured-cloned back to the main thread.
 */
import { describe, expect, it } from 'vitest';
import {
    GLAZE_MARTINEZ_VERTEX_CAP,
    GLAZE_RESULT_EXPANSION_FLOOR,
    GLAZE_RESULT_EXPANSION_LIMIT,
    GLAZE_RESULT_VERTEX_CAP,
    glazeResultOverBudget,
} from '../services/enc/clipDepareOverlap';

describe('glaze result bound', () => {
    it('passes an ordinary clip that stays near its input size', () => {
        // The overwhelming majority: a band minus a coverage, similar size.
        expect(glazeResultOverBudget(900, 1_000)).toBe(false);
        expect(glazeResultOverBudget(1_400, 1_000)).toBe(false);
    });

    it('rejects a result over the absolute ceiling even from a legal input', () => {
        // The input passed every existing gate — pairVerts under the martinez
        // cap — and still produced more geometry than we are willing to carry
        // forward, accumulate and clone. This is the case no input bound sees.
        expect(GLAZE_RESULT_VERTEX_CAP).toBeGreaterThan(GLAZE_MARTINEZ_VERTEX_CAP);
        expect(glazeResultOverBudget(GLAZE_RESULT_VERTEX_CAP + 1, GLAZE_MARTINEZ_VERTEX_CAP)).toBe(true);
    });

    it('rejects a shatter that never approaches the ceiling', () => {
        // A 1k-vertex pair returning 5k is a fragmenting reef fringe. Well
        // under the absolute cap, but compounding it across the fines in a
        // cell is exactly how the subject grows without any gate complaining.
        expect(glazeResultOverBudget(5_000, 1_000)).toBe(true);
    });

    it('does not punish small clips for legitimately adding vertices', () => {
        // A tiny subject cut by a detailed coverage genuinely multiplies its
        // vertex count. Below the floor that is normal, not pathological — an
        // expansion test without a floor degrades most of the real work.
        expect(glazeResultOverBudget(GLAZE_RESULT_EXPANSION_FLOOR - 1, 100)).toBe(false);
        expect(GLAZE_RESULT_EXPANSION_LIMIT).toBeGreaterThan(1);
    });

    it('keeps the previous coords and degrades, rather than dropping the feature', () => {
        // A capped result must take the same path an over-cap INPUT takes:
        // strip rects pushed, previous coords retained, loop continues. If it
        // returned null instead, an expanding pair would erase a depth band
        // from the chart — a safety regression dressed as a memory fix.
        const src = readSrc();
        const branch = src.slice(
            src.indexOf('if (glazeResultOverBudget('),
            src.indexOf('touched = true;', src.indexOf('if (glazeResultOverBudget(')),
        );
        expect(branch).toContain('pairsResultCapped++');
        expect(branch).toContain('degradeRects.push(...rects)');
        expect(branch).toContain('continue;');
        expect(branch).not.toContain('return null');
    });

    it('charges the job budget what the pair actually cost', () => {
        // The budget was charged pairVerts — the INPUT — so a run of
        // cheap-input/expensive-output pairs consumed a fraction of the
        // budget it actually spent.
        const src = readSrc();
        expect(src).toContain('budget.remaining -= Math.max(pairVerts, outVerts)');
        expect(src).toContain('budget.remaining -= outVerts;');
    });
});

function readSrc(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:fs').readFileSync('services/enc/clipDepareOverlap.ts', 'utf8');
}
