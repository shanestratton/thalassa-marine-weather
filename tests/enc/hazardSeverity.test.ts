/**
 * hazardSeverity — the cross-cell hazard merge the router trusts to avoid
 * grounding. The bug this fixes: the old merge kept the FIRST covering
 * cell's hazard, and cells resolve in a nondeterministic pool order, so a
 * point covered by overlapping coarse+fine cells could report the milder
 * of two hazards, order-dependent. The tests that matter are the ones that
 * prove the merge is CONSERVATIVE (always the worst hazard) and
 * ORDER-INDEPENDENT.
 */
import { describe, it, expect } from 'vitest';

import { mergeHazardResults, HAZARD_TYPE_SEVERITY } from '../../services/enc/hazardSeverity';
import type { EncHazardResult, EncHazardType } from '../../services/enc/types';

const clear = (cellId?: string): EncHazardResult => ({ covered: true, hazard: false, minDepthM: null, cellId });
const uncovered: EncHazardResult = { covered: false, hazard: false, minDepthM: null };
const hazard = (hazardType: EncHazardType, minDepthM: number | null, cellId?: string): EncHazardResult => ({
    covered: true,
    hazard: true,
    minDepthM,
    hazardType,
    cellId,
});

describe('HAZARD_TYPE_SEVERITY', () => {
    it('ranks land > rock > wreck > obstruction > shallow > coast', () => {
        const { land, rock, wreck, obstruction, shallow, coast } = HAZARD_TYPE_SEVERITY;
        expect(land).toBeGreaterThan(rock);
        expect(rock).toBeGreaterThan(wreck);
        expect(wreck).toBeGreaterThan(obstruction);
        expect(obstruction).toBeGreaterThan(shallow);
        expect(shallow).toBeGreaterThan(coast);
    });
});

describe('mergeHazardResults — conservative + order-independent', () => {
    it('any hazard beats clear water (escalation), both directions', () => {
        expect(mergeHazardResults(hazard('shallow', 2), clear()).hazard).toBe(true);
        expect(mergeHazardResults(clear(), hazard('shallow', 2)).hazard).toBe(true);
    });

    it('the WORSE hazard TYPE wins, regardless of depth', () => {
        // A rock with unknown depth outranks a very-shallow depth area —
        // matches the within-cell queryPoint ordering.
        const worst = mergeHazardResults(hazard('shallow', 0.1), hazard('rock', null));
        expect(worst.hazardType).toBe('rock');
    });

    it('within the same type, the SHALLOWER hazard wins', () => {
        const worst = mergeHazardResults(hazard('shallow', 5), hazard('shallow', 0.5));
        expect(worst.minDepthM).toBe(0.5);
    });

    it('an UNKNOWN (null) depth is the worst — router assumes shallowest', () => {
        const worst = mergeHazardResults(hazard('shallow', 0.5), hazard('shallow', null));
        expect(worst.minDepthM).toBeNull();
    });

    it('a covered result beats uncovered; uncovered ∘ uncovered stays uncovered', () => {
        expect(mergeHazardResults(uncovered, clear('X')).covered).toBe(true);
        expect(mergeHazardResults(uncovered, uncovered).covered).toBe(false);
    });

    it('is COMMUTATIVE — merge(a,b) === merge(b,a) for every pair', () => {
        const set = [
            uncovered,
            clear('A'),
            clear('B'),
            hazard('shallow', 5, 'C'),
            hazard('shallow', 1, 'D'),
            hazard('rock', null, 'E'),
            hazard('land', null, 'F'),
        ];
        for (const a of set) {
            for (const b of set) {
                expect(mergeHazardResults(a, b)).toEqual(mergeHazardResults(b, a));
            }
        }
    });

    it('is ORDER-INDEPENDENT under a fold — the exact bug the audit caught', () => {
        // Same point covered by four cells; the reduce result must not
        // depend on the (nondeterministic) resolution order.
        const cells = [
            clear('coarse'),
            hazard('shallow', 3, 'mid'),
            hazard('rock', null, 'fine'),
            hazard('shallow', 0.4, 'harbour'),
        ];
        const fold = (list: EncHazardResult[]) => list.reduce(mergeHazardResults, uncovered);
        const forward = fold(cells);
        const reversed = fold([...cells].reverse());
        const shuffled = fold([cells[2], cells[0], cells[3], cells[1]]);
        expect(forward).toEqual(reversed);
        expect(forward).toEqual(shuffled);
        // …and it surfaces the WORST hazard (rock outranks both shallows).
        expect(forward.hazardType).toBe('rock');
    });

    it('clear-water provenance is a DETERMINISTIC tiebreak, not order-dependent', () => {
        expect(mergeHazardResults(clear('A'), clear('B')).cellId).toBe('B');
        expect(mergeHazardResults(clear('B'), clear('A')).cellId).toBe('B');
    });
});
