/**
 * vesselUnits — the feet→metres draft authority (services/units.ts).
 *
 * settings.vessel.draft is stored in FEET (OnboardingWizard converts
 * m→ft on save). Every routing/depth consumer works in metres; before
 * vesselDraftMetres() existed, several call sites fed raw feet into
 * metre-typed fields and depth avoidance ran ~3.3× too conservative
 * (ROUTING_COLLAB ship-blocker #2). These tests pin the conversion and
 * the fallback contract, plus a regression through the real depth
 * classifier the voyage-form depth summary uses.
 */

import { describe, it, expect } from 'vitest';
import { FEET_PER_METRE, vesselDraftMetres } from '../services/units';
import { GebcoDepthService } from '../services/GebcoDepthService';

describe('vesselDraftMetres', () => {
    it('converts the FEET-stored draft to metres (Tayana 7.87 ft → 2.40 m)', () => {
        expect(vesselDraftMetres({ draft: 7.87 })).toBeCloseTo(2.4, 2);
    });

    it('converts the default-vessel 5.9 ft fallback profile to ~1.8 m', () => {
        // utils/defaultVessel.ts stores 1.8 m as 5.9 ft on purpose
        expect(vesselDraftMetres({ draft: 5.9 })).toBeCloseTo(1.8, 1);
    });

    it('falls back to 2.5 m for zero draft', () => {
        expect(vesselDraftMetres({ draft: 0 })).toBe(2.5);
    });

    it('falls back for undefined draft and missing vessel', () => {
        expect(vesselDraftMetres({})).toBe(2.5);
        expect(vesselDraftMetres(undefined)).toBe(2.5);
        expect(vesselDraftMetres(null)).toBe(2.5);
    });

    it('falls back for non-finite drafts', () => {
        expect(vesselDraftMetres({ draft: NaN })).toBe(2.5);
        expect(vesselDraftMetres({ draft: Infinity })).toBe(2.5);
        expect(vesselDraftMetres({ draft: -3 })).toBe(2.5);
    });

    it('honours a caller-supplied fallback', () => {
        expect(vesselDraftMetres(undefined, 1.5)).toBe(1.5);
        expect(vesselDraftMetres({ draft: 0 }, 1.5)).toBe(1.5);
    });

    it('exports the canonical feet-per-metre factor', () => {
        expect(FEET_PER_METRE).toBeCloseTo(3.28084, 5);
        // round-trips with the OnboardingWizard save path: m → ft → m
        expect((2.4 * FEET_PER_METRE) / FEET_PER_METRE).toBeCloseTo(2.4, 10);
    });
});

describe('regression — depth classification with converted vs raw-feet draft', () => {
    // GebcoDepthService.classifyDepth is the real consumer behind
    // enhanceRouteWithDepth (useVoyageForm step 3 depth summary) and the
    // isochrone depth penalties. A 10 m sounding for a 7.87 ft (2.4 m)
    // draft is plainly safe (10 > 3 × 2.4); the pre-fix raw-feet bug
    // made the same sounding read as danger (10 ≤ 1.5 × 7.87).
    const TAYANA_FT = 7.87;

    it('classifies a 10 m sounding as safe at the converted draft', () => {
        const draftM = vesselDraftMetres({ draft: TAYANA_FT });
        expect(GebcoDepthService.classifyDepth(-10, draftM)).toBe('safe');
        expect(GebcoDepthService.depthCostPenalty(-10, draftM)).toBe(1.0);
    });

    it('demonstrates the old raw-feet bug would have flagged it danger', () => {
        // Documents WHY the conversion matters — raw feet in a metres
        // field turns safe water near-impassable (10× cost penalty).
        expect(GebcoDepthService.classifyDepth(-10, TAYANA_FT)).toBe('danger');
        expect(GebcoDepthService.depthCostPenalty(-10, TAYANA_FT)).toBe(10.0);
    });
});
