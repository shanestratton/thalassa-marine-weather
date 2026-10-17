import './helpers/noPrivateRoutingAreas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsochroneNode } from '../services/isochrone/types';
const mocks = vi.hoisted(() => ({ queries: vi.fn(), setReport: vi.fn(), findReport: vi.fn() }));
vi.mock('../services/HazardQueryService', () => ({
    GEBCO_MSL_TO_LAT_PESSIMISM_M: 1.3,
    regionalGebcoDatumDeltaM: () => 1.3,
    hazardDepthForDraft: (draft: number = 2.5) => -(draft + 1),
    hasEncCoverageFor: () => true,
    preloadEncForBBox: async () => {},
    queryHazards: mocks.queries,
    querySegmentHazards: async (segments: unknown[]) =>
        segments.map(() => ({ isHazard: false, source: 'enc', depth_m: -40 })),
    querySegmentCautions: async (segments: unknown[]) => segments.map(() => []),
}));
vi.mock('../services/enc/EncHazardReportService', () => ({
    setLastReport: mocks.setReport,
    findHazardsAlongRoute: mocks.findReport,
}));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => [], getVersion: () => 0 }));
vi.mock('../services/enc/encIndexCache', () => ({ failedCellIds: () => [] }));
import { validateRouteSegments } from '../services/isochrone/landAvoidance';
const route: IsochroneNode[] = [0, 0.01].map((lon) => ({
    lat: 0,
    lon,
    timeHours: lon * 10,
    bearing: 90,
    speed: 6,
    tws: 15,
    twa: 90,
    distance: lon * 60,
    parentIndex: null,
}));
beforeEach(() => {
    vi.clearAllMocks();
    mocks.queries.mockImplementation(async (points: { lat: number; lon: number }[]) =>
        points.map((point) => ({ ...point, isHazard: false, depth_m: -40, source: 'enc', catzoc: 1 })),
    );
    mocks.findReport.mockResolvedValue({ cellsConsulted: 1, bufferNm: 1, entries: [], advisories: [] });
});
describe('comparison hazard reports stay private until accepted', () => {
    it('stages the exact chart report without replacing the active passage report', async () => {
        const staged = vi.fn(),
            outcome = vi.fn();
        await validateRouteSegments(route, {
            vesselDraftM: 2,
            publishReport: false,
            onHazardReport: staged,
            onVerificationOutcome: outcome,
            stillCurrent: () => true,
        });
        expect(outcome).toHaveBeenCalledWith({ status: 'verified' });
        expect(staged).toHaveBeenCalledWith(expect.objectContaining({ cellsConsulted: 1 }));
        expect(mocks.setReport).not.toHaveBeenCalled();
    });
    it('keeps a failed comparison from overwriting the primary report on the hazard-query error path', async () => {
        mocks.queries.mockRejectedValue(new Error('Fixture depth outage'));
        const staged = vi.fn(),
            outcome = vi.fn();
        await validateRouteSegments(route, {
            publishReport: false,
            onHazardReport: staged,
            onVerificationOutcome: outcome,
            stillCurrent: () => true,
        });
        expect(outcome).toHaveBeenCalledWith({ status: 'unverified', reason: 'chart/depth hazard query failed' });
        expect(staged).toHaveBeenCalledOnce();
        expect(mocks.setReport).not.toHaveBeenCalled();
    });
    it('does not stage a report which completes after cancellation', async () => {
        let current = true;
        const staged = vi.fn();
        mocks.findReport.mockImplementation(async () => {
            current = false;
            return { cellsConsulted: 1, bufferNm: 1, entries: [] };
        });
        await expect(
            validateRouteSegments(route, {
                publishReport: false,
                onHazardReport: staged,
                stillCurrent: () => current,
            }),
        ).rejects.toMatchObject({ code: 'exclusion-unavailable' });
        expect(staged).not.toHaveBeenCalled();
        expect(mocks.setReport).not.toHaveBeenCalled();
    });
    it('preserves ordinary primary-route report publication', async () => {
        await validateRouteSegments(route, { vesselDraftM: 2, stillCurrent: () => true });
        expect(mocks.setReport).toHaveBeenCalledOnce();
    });
});
