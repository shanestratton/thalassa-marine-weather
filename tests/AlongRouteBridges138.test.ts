import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { Geometry } from 'geojson';
const m = vi.hoisted(() => ({ cells: [] as EncCell[], version: 1, raw: vi.fn(), package: vi.fn(), release: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({ getVersion: () => m.version, displayCellsForBBox: () => m.cells }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: m.raw }));
vi.mock('../services/enc/noaaPackageWindow', () => ({ loadNoaaPackageCohort: m.package }));
import { readAlongRouteBridges } from '../services/enc/readAlongRouteBridges';
import { prepareAlongRoute, projectAlongPlaces } from '../services/routing/alongRoutePlaces';
import { bridgeReferencePoint } from '../services/routing/alongRouteBridgeGeometry';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const geometry = () =>
    prepareAlongRoute([
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.02 },
    ]);
const cell = (extra: Partial<EncCell> = {}): EncCell => ({
    id: 'US5CA1LK',
    sourceHO: 'US',
    edition: 1,
    bbox: [-1, -1, 1, 1],
    issued: '2026-10-16',
    importedAt: '2026-10-17',
    geojsonPath: 'fixture-only',
    hazardCount: 1,
    ...extra,
});
const blob = (): EncConversionResult => ({
    cellId: 'US5CA1LK',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    bbox: [-1, -1, 1, 1],
    extractorSchema: 3,
    verticalDatum: 17,
    layers: {
        BRIDGE: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0.01, 1],
                            [0.01, -0.1],
                        ],
                    },
                    properties: {
                        LNAM: '0001000000000001',
                        OBJNAM: 'Fictional opening bridge',
                        CATBRG: 3,
                        VERCLR: 100,
                    },
                },
            ],
        },
    },
});
beforeEach(() => {
    setAuthIdentityScope(null);
    vi.clearAllMocks();
    m.cells = [cell()];
    m.version = 1;
    m.raw.mockResolvedValue(blob());
    m.package.mockImplementation(async () => ({ blobs: new Map(), release: m.release }));
});
describe('RAM-only complete installed bridge cohorts', () => {
    it('keeps a long span crossing the route even when its centroid and vertices are far outside the corridor', async () => {
        const result = await readAlongRouteBridges(geometry(), () => {});
        expect(result.records[0]).toMatchObject({
            kind: 'bridge',
            lon: expect.closeTo(0.01, 5),
            aboardOnly: false,
        });
        expect(Math.abs(result.records[0].lat)).toBe(0);
        expect(result.records[0].note).toContain('Closed/fixed clearance unknown');
        expect(result.records[0].note).toContain('no verified operating schedule');
        expect(result.records[0].note).not.toContain('100.0');
        expect(m.raw).toHaveBeenCalledWith('US5CA1LK', false);
        expect(m.release).toHaveBeenCalledTimes(1);
    });
    it('uses actual licence ownership rather than a US source label to keep protected summaries aboard', async () => {
        m.cells = [cell({ licence: 'protected' })];
        const result = await readAlongRouteBridges(geometry(), () => {});
        expect(result.records[0]).toMatchObject({ aboardOnly: true, sourceUrl: null });
    });
    it('copies primitive summaries while the package lease is live, releases it once and retains no raw references', async () => {
        const source = blob();
        m.cells = [
            cell({
                noaaPackage: { owner: 'fixture-owner', manifestSha256: 'a'.repeat(64), path: 'fixture-only-manifest' },
            }),
        ];
        const view = new Map([['US5CA1LK', source]]);
        m.package.mockResolvedValue({
            blobs: view,
            release: () => {
                m.release();
                view.clear();
            },
        });
        const result = await readAlongRouteBridges(geometry(), () => {});
        source.layers.BRIDGE!.features[0].properties!.OBJNAM = 'Changed after lease';
        expect(result.records[0].name).toBe('Fictional opening bridge');
        expect(view.size).toBe(0);
        expect(m.release).toHaveBeenCalledTimes(1);
    });
    it('refuses the whole bridge inventory on a missing layer or package failure, preserving the existing caps', async () => {
        m.cells = [cell(), cell({ id: 'US5CA2LK' })];
        m.raw.mockResolvedValueOnce(blob()).mockResolvedValueOnce({ ...blob(), layers: {} });
        const result = await readAlongRouteBridges(geometry(), () => {});
        expect(result.records).toEqual([]);
        expect(result.complete).toBe(false);
        expect(m.release).toHaveBeenCalledTimes(1);
        m.cells = Array.from({ length: 15 }, (_, i) => cell({ id: 'US' + i }));
        m.raw.mockClear();
        expect((await readAlongRouteBridges(geometry(), () => {})).note).toContain('existing cell cap');
        expect(m.raw).not.toHaveBeenCalled();
    });
    it('fences a changed chart revision or account even when a caller supplies a no-op guard', async () => {
        m.raw.mockImplementationOnce(async () => {
            m.version++;
            return blob();
        });
        expect((await readAlongRouteBridges(geometry(), () => {})).records).toEqual([]);
        m.raw.mockImplementationOnce(async () => {
            setAuthIdentityScope('fictional-other-owner');
            return blob();
        });
        expect((await readAlongRouteBridges(geometry(), () => {})).records).toEqual([]);
        expect(m.release).toHaveBeenCalledTimes(2);
    });
    it('does not infer a connecting span between disconnected MultiPoint members', async () => {
        const source: Geometry = {
            type: 'MultiPoint',
            coordinates: [
                [0.01, 0.2],
                [0.01, -0.2],
            ],
        };
        const point = bridgeReferencePoint(source, geometry(), { comparisons: 0 }, () => {});
        const result = await projectAlongPlaces(
            geometry(),
            [
                {
                    id: 'disconnected',
                    name: 'Fictional disconnected points',
                    kind: 'bridge',
                    source: 'fixture',
                    sourceAt: null,
                    sourceUrl: null,
                    aboardOnly: true,
                    note: '',
                    ...point,
                },
            ],
            { departureMs: null, speedKts: null },
            new AbortController().signal,
            () => {},
        );
        expect(result.rows).toEqual([]);
    });
    it('keeps a missing installed-window footprint explicit and refuses oversized window requests before any read', async () => {
        m.cells = [];
        const missing = await readAlongRouteBridges(geometry(), () => {});
        expect(missing.complete).toBe(false);
        expect(missing.note).toContain('no installed charts');
        const route = geometry();
        route.bounds = Array.from({ length: 33 }, () => [0, 0, 1, 1]);
        m.package.mockClear();
        expect((await readAlongRouteBridges(route, () => {})).note).toContain('32 local windows');
        expect(m.package).not.toHaveBeenCalled();
    });
});
