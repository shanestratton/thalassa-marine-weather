/**
 * HazardQueryService.encToHazardResult — the ENC→unified adapter the
 * router trusts. These lock in the DEPTH-SIGN convention, which had a
 * fail-dangerous bug: a DRYING bank (negative S-57 DRVAL1 = height ABOVE
 * datum) was run through -Math.abs(), modelling it as shoal WATER and
 * clearing it at high tide. The fix flips the sign only (-x), so drying
 * ground maps to a POSITIVE above-surface value that stays a hazard.
 */
import { describe, it, expect } from 'vitest';

import { encToHazardResult, hazardDepthForDraft, regionalGebcoDatumDeltaM } from '../services/HazardQueryService';
import type { EncHazardResult } from '../services/enc/types';

const pt = { lat: -27.4, lon: 153.1 };

/** A shallow depth-area hazard with a given S-57 DRVAL1 (positive = below
 *  datum, negative = drying height above datum). */
const depare = (drval1: number | null): EncHazardResult => ({
    covered: true,
    hazard: true,
    hazardType: 'shallow',
    minDepthM: drval1,
    cellId: 'AU5TEST',
    catzoc: null,
});

describe('encToHazardResult depth-sign convention', () => {
    const threshold = hazardDepthForDraft(2.0); // -3.5 m

    it('a normal 5 m-deep area maps to -5 m (water below surface)', () => {
        const r = encToHazardResult(pt, depare(5), threshold, 0);
        expect(r.depth_m).toBe(-5);
    });

    it('DRYING BANK: a bank drying 0.5 m ABOVE datum maps to +0.5 m, not -0.5 m', () => {
        // The old -Math.abs() produced -0.5 (half a metre of WATER). Correct
        // is +0.5 (half a metre of drying LAND above the surface at datum).
        const r = encToHazardResult(pt, depare(-0.5), threshold, 0);
        expect(r.depth_m).toBe(0.5);
        expect(r.isHazard).toBe(true); // dry ground at datum is always a hazard
    });

    it('DRYING BANK stays a hazard at a modest high tide (the fail-dangerous case)', () => {
        // Bank dries 1.0 m above datum → +1.0. At +2.5 m tide there is only
        // 1.5 m of water — still inside the -3.5 m (2 m draft) danger zone.
        // The OLD bug modelled it as -1.0 → +2.5 tide → -3.5 m → CLEARED.
        const r = encToHazardResult(pt, depare(-1.0), threshold, 2.5);
        expect(r.depth_m).toBe(-1.5); // +1.0 above datum, minus 2.5 m of tide
        expect(r.isHazard).toBe(true);
    });

    it('DRYING BANK finally clears when the tide genuinely floats a 2 m-draft vessel', () => {
        // Same bank (+1.0), but +5 m tide → 4 m of water, deeper than the
        // -3.5 m threshold → navigable. Sign fix keeps this honest too.
        const r = encToHazardResult(pt, depare(-1.0), threshold, 5);
        expect(r.depth_m).toBe(-4);
        expect(r.isHazard).toBe(false);
    });

    it('a solid hazard (rock, no depth) stays a hazard regardless of tide', () => {
        const rock: EncHazardResult = { covered: true, hazard: true, hazardType: 'rock', minDepthM: null };
        const r = encToHazardResult(pt, rock, threshold, 5);
        expect(r.isHazard).toBe(true);
    });
});

describe('regionalGebcoDatumDeltaM — big-tide MSL→LAT floor without a departure time (re-audit A)', () => {
    it('the big-tide central coast (Broad Sound / Hay Point) raises the delta above the Moreton floor', () => {
        expect(regionalGebcoDatumDeltaM([149.2, -22.3, 149.6, -21.6])).toBe(4.5);
    });
    it('Moreton Bay and un-tabled coast keep the 1.3 m default', () => {
        expect(regionalGebcoDatumDeltaM([153.0, -27.5, 153.3, -27.0])).toBe(1.3); // Moreton
        expect(regionalGebcoDatumDeltaM([115.0, -32.0, 116.0, -31.0])).toBe(1.3); // WA — not in the QLD table
    });
    it('a bbox straddling two regions takes the WORST (most conservative) delta', () => {
        // Overlaps both Whitsundays (3.0) and Broad Sound (4.5) → 4.5.
        expect(regionalGebcoDatumDeltaM([148.8, -22.0, 149.3, -20.0])).toBe(4.5);
    });
    it('never returns below the Moreton floor', () => {
        expect(regionalGebcoDatumDeltaM([0, -1, 1, 0])).toBeGreaterThanOrEqual(1.3);
    });
});
