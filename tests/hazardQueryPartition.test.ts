/**
 * queryHazards phase-1/2 partition (burn-down seam tests): ENC-covered
 * points use the ENC result, uncovered points fall to GEBCO, a draft-cleared
 * SOUNDING-ONLY result is demoted to GEBCO (a lone sounding certifies
 * nothing), and a GEBCO outage degrades to loud source:'none' — never a
 * silent clear, never a throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { EncHazardResult } from '../services/enc/types';

const encQueryHazards = vi.fn<(pts: { lat: number; lon: number }[]) => Promise<EncHazardResult[]>>();
const gebcoQueryDepths = vi.fn();

vi.mock('../services/enc/EncHazardService', () => ({
    queryHazards: (pts: { lat: number; lon: number }[]) => encQueryHazards(pts),
    querySegmentHazards: async () => [],
    querySegmentCautions: async () => [],
    hasAnyCells: () => true,
    hasCoverageFor: () => true,
    preloadForBBox: async () => undefined,
}));

vi.mock('../services/GebcoDepthService', () => ({
    GebcoDepthService: {
        queryDepths: (pts: unknown) => gebcoQueryDepths(pts),
        depthCostPenalty: () => 1,
        classifyDepth: () => 'safe',
    },
}));

import { queryHazards, encToHazardResult } from '../services/HazardQueryService';

const P = [{ lat: -27.4, lon: 153.1 }];

describe('queryHazards phase-1/2 partition', () => {
    beforeEach(() => {
        encQueryHazards.mockReset();
        gebcoQueryDepths.mockReset();
    });

    it('an ENC-covered hazard answers from ENC — GEBCO is never called', async () => {
        encQueryHazards.mockResolvedValue([
            { covered: true, hazard: true, hazardType: 'rock', minDepthM: null, cellId: 'A' },
        ]);
        const out = await queryHazards(P, { vesselDraftM: 2 });
        expect(out[0]).toMatchObject({ isHazard: true, source: 'enc', hazardType: 'rock' });
        expect(gebcoQueryDepths).not.toHaveBeenCalled();
    });

    it('an UNCOVERED point falls to GEBCO', async () => {
        encQueryHazards.mockResolvedValue([{ covered: false, hazard: false, minDepthM: null }]);
        gebcoQueryDepths.mockResolvedValue([{ lat: P[0].lat, lon: P[0].lon, depth_m: -30 }]);
        const out = await queryHazards(P, { vesselDraftM: 2 });
        expect(out[0]).toMatchObject({ isHazard: false, source: 'gebco', depth_m: -30 });
    });

    it('a draft-CLEARED sounding-only result is DEMOTED to GEBCO (no false ENC-clear)', async () => {
        // A lone 12 m sounding near the point: hazard evidence, not coverage.
        // 2 m draft clears it → must NOT read "ENC-verified clear"; GEBCO
        // gets the final say (here: a 2 m bank the sounding knew nothing of).
        encQueryHazards.mockResolvedValue([
            { covered: true, hazard: true, hazardType: 'shallow', minDepthM: 12, cellId: 'A', soundingOnly: true },
        ]);
        gebcoQueryDepths.mockResolvedValue([{ lat: P[0].lat, lon: P[0].lon, depth_m: -2 }]);
        const out = await queryHazards(P, { vesselDraftM: 2 });
        expect(gebcoQueryDepths).toHaveBeenCalled();
        expect(out[0]).toMatchObject({ isHazard: true, source: 'gebco' }); // the 2 m bank flags
    });

    it('a sounding-only result that ENDANGERS the vessel stays an ENC hazard', async () => {
        encQueryHazards.mockResolvedValue([
            { covered: true, hazard: true, hazardType: 'shallow', minDepthM: 1.2, cellId: 'A', soundingOnly: true },
        ]);
        const out = await queryHazards(P, { vesselDraftM: 2 });
        expect(out[0]).toMatchObject({ isHazard: true, source: 'enc' });
        expect(gebcoQueryDepths).not.toHaveBeenCalled();
    });

    it('a GEBCO OUTAGE degrades to loud source:none — never a throw, never a silent clear', async () => {
        encQueryHazards.mockResolvedValue([{ covered: false, hazard: false, minDepthM: null }]);
        gebcoQueryDepths.mockRejectedValue(new Error('edge down'));
        const out = await queryHazards(P, { vesselDraftM: 2 });
        expect(out[0]).toMatchObject({ isHazard: false, source: 'none', depth_m: null });
    });

    it('GEBCO tide credit is CLAMPED (LAT/MSL datum guard): no positive tide on gebco depths', async () => {
        encQueryHazards.mockResolvedValue([{ covered: false, hazard: false, minDepthM: null }]);
        // -3.2 m at MSL with a 2 m draft (threshold -3.5): crediting +2 m of
        // LAT tide would read -5.2 (clear); the guard keeps it -3.2 → hazard.
        gebcoQueryDepths.mockResolvedValue([{ lat: P[0].lat, lon: P[0].lon, depth_m: -3.2 }]);
        const out = await queryHazards(P, { vesselDraftM: 2, tideOffsetM: 2 });
        expect(out[0]).toMatchObject({ isHazard: true, source: 'gebco', depth_m: -3.2 });
    });
});

describe('encToHazardResult — tide-constrained clearances (audit #4)', () => {
    const pt = { lat: -27.4, lon: 153.1 };
    const shallowBand = (minDepthM: number): EncHazardResult => ({
        hazard: true,
        hazardType: 'shallow',
        minDepthM,
        covered: true,
        cellId: 'OC-61-10ENB5',
    });

    it('a band cleared ONLY by tide credit is flagged tideConstrained', () => {
        // 2 m at datum, 2.5 m threshold (draft ~2 m): hazard at datum,
        // clears with +1.5 m of predicted tide.
        const r = encToHazardResult(pt, shallowBand(2), -2.5, 1.5);
        expect(r.isHazard).toBe(false);
        expect(r.tideConstrained).toBe(true);
    });

    it('a band clear even at chart datum carries NO flag', () => {
        const r = encToHazardResult(pt, shallowBand(6), -2.5, 1.5);
        expect(r.isHazard).toBe(false);
        expect(r.tideConstrained).toBeUndefined();
    });

    it('a band still hazardous WITH the tide stays a hazard, unflagged', () => {
        const r = encToHazardResult(pt, shallowBand(0.5), -2.5, 1.0);
        expect(r.isHazard).toBe(true);
        expect(r.tideConstrained).toBeUndefined();
    });

    it('zero or negative tide never flags (no credit was given)', () => {
        expect(encToHazardResult(pt, shallowBand(6), -2.5, 0).tideConstrained).toBeUndefined();
        expect(encToHazardResult(pt, shallowBand(6), -2.5, -0.4).tideConstrained).toBeUndefined();
    });

    it('solid hazards (rock/wreck) are never tide-cleared or flagged', () => {
        const rock: EncHazardResult = { hazard: true, hazardType: 'rock', minDepthM: null, covered: true, cellId: 'X' };
        const r = encToHazardResult(pt, rock, -2.5, 3.0);
        expect(r.isHazard).toBe(true);
        expect(r.tideConstrained).toBeUndefined();
    });
});
