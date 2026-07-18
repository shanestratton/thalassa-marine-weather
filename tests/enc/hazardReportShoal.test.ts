/**
 * Off-track shoal awareness (cycle-6 re-audit #1, safety): an isolated shoal
 * spot-sounding or shoal DEPARE edge just off the planned track — reachable on
 * a wide tack or drift, beyond the 150 m on-track guard — must reach the
 * proximity briefing. Drives findHazardsAlongRoute against a real EncSpatialIndex.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Geometry } from 'geojson';

vi.mock('../../services/enc/EncHazardService', () => ({ getIndexForCell: vi.fn() }));
vi.mock('../../services/enc/EncCellMetadata', () => ({ cellsForBBox: vi.fn(), getCell: vi.fn() }));

import { findHazardsAlongRoute } from '../../services/enc/EncHazardReportService';
import { getIndexForCell } from '../../services/enc/EncHazardService';
import * as cellMeta from '../../services/enc/EncCellMetadata';
import { EncSpatialIndex } from '../../services/enc/EncSpatialIndex';
import type { EncHazard } from '../../services/enc/types';

const CELL = {
    id: 'AU5SHOAL',
    sourceHO: 'AU',
    bbox: [152.9, -27.6, 153.3, -27.2] as [number, number, number, number],
    edition: 1,
    issued: '2026-01-01',
};
const pt = (lon: number, lat: number): Geometry => ({ type: 'Point', coordinates: [lon, lat] });
// Straight E-W track at lat -27.400. 0.0027° ≈ 300 m; 0.0063° ≈ 700 m south.
const ROUTE = [
    { lat: -27.4, lon: 153.0 },
    { lat: -27.4, lon: 153.2 },
];
const DRAFT_KEEL = 4.1; // shoalDepthM for a 2.4 m draft

function indexWith(hazards: EncHazard[]): EncSpatialIndex {
    return new EncSpatialIndex('AU5SHOAL', hazards);
}

describe('findHazardsAlongRoute — off-track shoal surfacing (#1)', () => {
    beforeEach(() => {
        vi.mocked(cellMeta.cellsForBBox).mockReturnValue([CELL] as never);
    });

    it('a shoal SOUNDG ~300 m off track (within the drift band) is reported as a shallow patch', async () => {
        vi.mocked(getIndexForCell).mockResolvedValue(
            indexWith([{ layer: 'SOUNDG', geometry: pt(153.1, -27.4027), minDepthM: 1.2 }]),
        );
        const report = await findHazardsAlongRoute(ROUTE, { shoalDepthM: DRAFT_KEEL });
        const shoal = report.entries.find((e) => e.hazardType === 'shallow');
        expect(shoal).toBeDefined();
        expect(shoal!.minDepthM).toBe(1.2);
        expect(shoal!.distanceNm).toBeLessThan(0.3);
    });

    it('a DEEP SOUNDG (8 m) off track is NOT reported — draft-aware gate', async () => {
        vi.mocked(getIndexForCell).mockResolvedValue(
            indexWith([{ layer: 'SOUNDG', geometry: pt(153.1, -27.4027), minDepthM: 8 }]),
        );
        const report = await findHazardsAlongRoute(ROUTE, { shoalDepthM: DRAFT_KEEL });
        expect(report.entries.some((e) => e.hazardType === 'shallow')).toBe(false);
    });

    it('a shoal SOUNDG ~700 m off track (beyond the drift band) is NOT reported', async () => {
        vi.mocked(getIndexForCell).mockResolvedValue(
            indexWith([{ layer: 'SOUNDG', geometry: pt(153.1, -27.4063), minDepthM: 1.2 }]),
        );
        const report = await findHazardsAlongRoute(ROUTE, { shoalDepthM: DRAFT_KEEL, shoalBandNm: 0.3 });
        expect(report.entries.some((e) => e.hazardType === 'shallow')).toBe(false);
    });

    it('shoals are capped so they cannot evict a hard hazard (wreck stays)', async () => {
        const shoals: EncHazard[] = Array.from({ length: 20 }, (_, i) => ({
            layer: 'SOUNDG',
            geometry: pt(153.02 + i * 0.008, -27.4027),
            minDepthM: 1.0,
        }));
        shoals.push({ layer: 'WRECKS', geometry: pt(153.19, -27.401), minDepthM: null });
        vi.mocked(getIndexForCell).mockResolvedValue(indexWith(shoals));
        const report = await findHazardsAlongRoute(ROUTE, { shoalDepthM: DRAFT_KEEL, maxShoalEntries: 6 });
        expect(report.entries.filter((e) => e.hazardType === 'shallow').length).toBeLessThanOrEqual(6);
        expect(report.entries.some((e) => e.hazardType === 'wreck')).toBe(true);
    });
});
