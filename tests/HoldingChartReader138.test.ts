import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { Feature, Polygon } from 'geojson';
const m = vi.hoisted(() => ({ cells: [] as EncCell[], version: 1, raw: vi.fn(), package: vi.fn(), release: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => m.cells, getVersion: () => m.version }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: m.raw }));
vi.mock('../services/enc/noaaPackageWindow', () => ({ loadNoaaPackageCohort: m.package }));
import { readHoldingChart, HOLDING_REQUIRED_CLASSES } from '../services/enc/readHoldingChart';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const area = (properties: Record<string, unknown>): Feature<Polygon> => ({
    type: 'Feature',
    properties,
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
});
const cell = (): EncCell => ({
    id: 'US5CA1LK',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    importedAt: '2026-10-17',
    bbox: [-1, -1, 1, 1],
    geojsonPath: 'fixture',
    hazardCount: 0,
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
    layers: {
        ...Object.fromEntries(HOLDING_REQUIRED_CLASSES.map((c) => [c, { type: 'FeatureCollection', features: [] }])),
        DEPARE: { type: 'FeatureCollection', features: [area({ DRVAL1: 5 })] },
        SBDARE: { type: 'FeatureCollection', features: [area({ NATSUR: 4 })] },
        M_QUAL: { type: 'FeatureCollection', features: [area({ CATZOC: 2 })] },
    },
});
const read = (signal = new AbortController().signal) =>
    readHoldingChart({ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }, 100, { signal, assertCurrent: () => {} });
describe('real complete leased holding chart reader', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.version = 1;
        setAuthIdentityScope('holding-owner');
        m.cells = [cell()];
        m.raw.mockResolvedValue(blob());
        m.package.mockResolvedValue({ blobs: new Map(), release: m.release });
    });
    it('reads original full polygons and explicit empty hazard classes, without inventing permission or epoch', async () => {
        const r = await read();
        expect(r).toMatchObject({
            completeCircleAndApproach: true,
            minimumChartedDepthM: 5,
            datumId: 'LAT',
            datumEpoch: '',
            bottom: 'charted',
            hazards: 'clear',
            permission: 'unknown',
            aboardOnly: true,
            bottomIsPointSample: false,
        });
        expect(m.raw).toHaveBeenCalledWith(cell().id, false);
        expect(m.release).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(r)).not.toContain('coordinates');
    });
    it('holds a rock on the incoming leg outside the holding circle', async () => {
        const b = blob();
        b.layers.UWTROC!.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0.008, 0] },
            properties: { VALSOU: 20 },
        });
        m.raw.mockResolvedValue(b);
        expect((await read()).hazards).toBe('blocked');
    });
    it.each(['missing', 'point', 'hole', 'poor', 'quality', 'unknown-depth'] as const)(
        'does not promote %s coverage',
        async (kind) => {
            const b = blob();
            if (kind === 'missing') delete b.layers.WRECKS;
            if (kind === 'point')
                b.layers.SBDARE!.features = [
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { NATSUR: 4 } },
                ];
            if (kind === 'hole')
                (b.layers.SBDARE!.features[0].geometry as Polygon).coordinates.push([
                    [0.001, 0.001],
                    [0.002, 0.001],
                    [0.002, 0.002],
                    [0.001, 0.002],
                    [0.001, 0.001],
                ]);
            if (kind === 'poor') b.layers.SBDARE!.features[0].properties = { NATSUR: 14 };
            if (kind === 'quality') b.layers.M_QUAL!.features[0].properties = { CATZOC: 6 };
            if (kind === 'unknown-depth') b.layers.DEPARE!.features.push(area({}));
            m.raw.mockResolvedValue(b);
            const r = await read();
            if (kind === 'poor') expect(r.bottom).toBe('poor');
            else if (kind === 'unknown-depth') expect(r.minimumChartedDepthM).toBeNull();
            else expect(r.completeCircleAndApproach).toBe(false);
            expect(r.permission).toBe('unknown');
        },
    );
    it('reads original restrictions and overhead structures without applying tide or opening credit', async () => {
        const b = blob();
        b.layers.RESARE!.features = [area({ RESTRN: '7' })];
        b.layers.BRIDGE!.features = [area({ VERCCL: 100 })];
        m.raw.mockResolvedValue(b);
        expect(await read()).toMatchObject({ hazards: 'blocked', permission: 'prohibited' });
        const a=blob();a.layers.ACHARE!.features=[area({RESTRN:7})];m.raw.mockResolvedValue(a);
        expect((await read()).permission).toBe('prohibited');
    });
    it('rejects stale revisions and always releases a package after retirement or malformed geometry', async () => {
        m.raw.mockResolvedValue({ ...blob(), updateNumber: 1 });
        expect((await read()).completeCircleAndApproach).toBe(false);
        m.raw.mockImplementation(async () => {
            m.version++;
            return blob();
        });
        await expect(read()).rejects.toMatchObject({ name: 'AbortError' });
        expect(m.release).toHaveBeenCalledTimes(2);
        m.raw.mockResolvedValue({
            ...blob(),
            layers: {
                ...blob().layers,
                SBDARE: {
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [NaN, 0] },
                            properties: { NATSUR: 4 },
                        },
                    ],
                },
            },
        });
        expect((await read()).completeCircleAndApproach).toBe(false);
        expect(m.release).toHaveBeenCalledTimes(3);
    });
    it('uses a complete package cohort and holds a partial/read-failed cohort', async () => {
        m.cells = [
            { ...cell(), noaaPackage: { owner: 'holding-owner', manifestSha256: 'a'.repeat(64), path: 'fixture' } },
        ];
        m.package.mockResolvedValue({ blobs: new Map([[cell().id, blob()]]), release: m.release });
        expect((await read()).completeCircleAndApproach).toBe(true);
        expect(m.raw).not.toHaveBeenCalled();
        m.package.mockResolvedValue({ blobs: new Map(), release: m.release });
        expect((await read()).hazards).toBe('unknown');
        expect(m.release).toHaveBeenCalledTimes(2);
    });
    it('releases a late cohort after cancellation while a raw chart read is pending', async () => {
        let resolve!: (b: EncConversionResult) => void;
        m.raw.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const controller = new AbortController(),
            pending = read(controller.signal);
        const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(m.raw).toHaveBeenCalled());
        controller.abort();
        resolve(blob());
        await refused;
        expect(m.release).toHaveBeenCalledTimes(1);
    });
});
