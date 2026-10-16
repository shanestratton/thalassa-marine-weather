import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const m = vi.hoisted(() => ({ cells: [] as EncCell[], version: 1, raw: vi.fn(), package: vi.fn(), release: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => m.cells, getVersion: () => m.version }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: m.raw }));
vi.mock('../services/enc/noaaPackageWindow', () => ({ loadNoaaPackageCohort: m.package }));
import { readPassageTideContext } from '../services/enc/readPassageTideContext';
import { prepareAlongRoute } from '../services/routing/alongRoutePlaces';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const route = () =>
    prepareAlongRoute([
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.02 },
    ]);
const point = { lat: 0, lon: 0.01 };
const cell = (): EncCell => ({
    id: 'US5CA1LK',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    importedAt: '2026-10-17',
    bbox: [-1, -1, 1, 1],
    geojsonPath: 'fixture',
    hazardCount: 1,
    licence: 'protected',
});
const blob = (): EncConversionResult => ({
    cellId: 'US5CA1LK',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    bbox: [-1, -1, 1, 1],
    extractorSchema: 3,
    soundingDatum: 23,
    verticalDatum: 17,
    layers: {
        M_SDAT: { type: 'FeatureCollection', features: [] },
        DEPARE: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [-1, -1],
                                [1, -1],
                                [1, 1],
                                [-1, 1],
                                [-1, -1],
                            ],
                        ],
                    },
                    properties: { DRVAL1: 5 },
                },
            ],
        },
        SBDARE: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                    properties: { NATSUR: 4 },
                },
            ],
        },
        WEDKLP: { type: 'FeatureCollection', features: [] },
        BRIDGE: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0.01, -0.001],
                            [0.01, 0.001],
                        ],
                    },
                    properties: { OBJNAM: 'PRIVATE TEST BRIDGE', CATBRG: 3, VERCCL: 15, VERCOP: 30 },
                },
            ],
        },
    },
});
describe('actual leased passage tide chart disclosures', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope('chart-review-owner');
        m.version = 1;
        m.cells = [cell()];
        m.raw.mockResolvedValue(blob());
        m.package.mockResolvedValue({ blobs: new Map(), release: m.release });
    });
    it('copies actual sounding/height planes and primitive clearances but never invents epochs or holding coverage', async () => {
        const result = await readPassageTideContext(point, route(), () => {});
        expect(result).toMatchObject({
            aboardOnly: true,
            completeInventory: true,
            soundingDatum: 'LAT',
            soundingDatumEpoch: null,
            pointDepthM: 5,
            holdingPointSample: true,
        });
        expect(result.bridges[0]).toMatchObject({
            name: 'PRIVATE TEST BRIDGE',
            closedClearanceM: 15,
            openClearanceM: 30,
            heightDatum: 'S-57 VDAT 17',
            heightDatumEpoch: null,
            opening: true,
            aboardOnly: true,
        });
        expect(result.notes.join(' ')).toContain('does not prove the complete holding circle');
        expect(m.raw).toHaveBeenCalledWith('US5CA1LK', false);
        expect(m.release).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain('coordinates');
        expect(JSON.stringify(result)).not.toContain('NATSUR');
    });
    it('releases a package lease before summaries survive and refuses partial/missing layer completeness', async () => {
        const source = blob(),
            view = new Map([[source.cellId, source]]);
        m.cells = [
            {
                ...cell(),
                noaaPackage: { owner: 'fixture-owner', manifestSha256: 'a'.repeat(64), path: 'fixture-manifest' },
            },
        ];
        m.package.mockResolvedValue({
            blobs: view,
            release: () => {
                m.release();
                view.clear();
            },
        });
        const result = await readPassageTideContext(point, route(), () => {});
        source.layers.BRIDGE!.features[0].properties!.OBJNAM = 'changed';
        expect(result.bridges[0].name).toBe('PRIVATE TEST BRIDGE');
        expect(view.size).toBe(0);
        expect(m.release).toHaveBeenCalledTimes(1);
        m.cells = [cell()];
        const incomplete = blob();
        delete incomplete.layers.SBDARE;
        m.raw.mockResolvedValue(incomplete);
        m.package.mockResolvedValue({ blobs: new Map(), release: m.release });
        expect((await readPassageTideContext(point, route(), () => {})).completeInventory).toBe(false);
    });
    it('keeps a mixed/unknown datum cohort and a covering unknown depth unknown', async () => {
        m.cells = [cell(), { ...cell(), id: 'US5CA2LK' }];
        m.raw
            .mockResolvedValueOnce(blob())
            .mockResolvedValueOnce({ ...blob(), cellId: 'US5CA2LK', soundingDatum: undefined });
        expect((await readPassageTideContext(point, route(), () => {})).soundingDatum).toBeNull();
        const source = blob();
        source.layers.DEPARE!.features.push({ ...source.layers.DEPARE!.features[0], properties: {} });
        m.cells = [cell()];
        m.raw.mockResolvedValue(source);
        expect((await readPassageTideContext(point, route(), () => {})).pointDepthM).toBeNull();
        const nonArea = blob();
        nonArea.layers.DEPARE!.features[0].geometry = { type: 'Point', coordinates: [point.lon, point.lat] };
        m.raw.mockResolvedValue(nonArea);
        const refused = await readPassageTideContext(point, route(), () => {});
        expect(refused.pointDepthM).toBeNull();
        expect(refused.completeInventory).toBe(false);
        expect(refused.notes.join(' ')).toContain('non-area geometry');
    });
    it('enforces complete cohort and vertex bounds, and aborts on actual owner/revision changes', async () => {
        m.cells = Array.from({ length: 15 }, (_, i) => ({ ...cell(), id: `US${i}` }));
        expect((await readPassageTideContext(point, route(), () => {})).completeInventory).toBe(false);
        expect(m.raw).not.toHaveBeenCalled();
        m.cells = [cell()];
        const huge = blob();
        huge.layers.BRIDGE!.features[0].geometry = {
            type: 'LineString',
            coordinates: Array.from({ length: 65537 }, () => [0, 0]),
        };
        m.raw.mockResolvedValue(huge);
        expect((await readPassageTideContext(point, route(), () => {})).notes.join()).toContain('vertex');
        expect(m.release).toHaveBeenCalledTimes(1);
        m.raw.mockImplementationOnce(async () => {
            m.version++;
            return blob();
        });
        await expect(readPassageTideContext(point, route(), () => {})).rejects.toThrow('revision changed');
        expect(m.release).toHaveBeenCalledTimes(2);
        m.raw.mockImplementationOnce(async () => {
            setAuthIdentityScope('other-owner');
            return blob();
        });
        await expect(readPassageTideContext(point, route(), () => {})).rejects.toThrow('owner');
        expect(m.release).toHaveBeenCalledTimes(3);
    });
});
