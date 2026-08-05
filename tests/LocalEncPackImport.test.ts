import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCoverage: vi.fn(),
    importCell: vi.fn(),
    parseJsonOffThread: vi.fn(async (text: string) => JSON.parse(text) as unknown),
}));

vi.mock('../services/enc/EncHazardService', () => ({
    getCoverage: mocks.getCoverage,
    getDisplayCoverage: mocks.getCoverage,
    importCell: mocks.importCell,
}));

vi.mock('../services/enc/EncCellStore', () => ({
    parseJsonOffThread: mocks.parseJsonOffThread,
}));

import {
    importLocalEncPackFile,
    importLocalEncPackText,
    importLocalEncPackUrl,
    isSupportedLocalEncPackFilename,
    validateLocalEncPack,
    validateLocalEncPackUrl,
} from '../services/enc/localEncPackImport';
import type { EncConversionResult } from '../services/enc/types';

function validCell(overrides: Partial<EncConversionResult> = {}): EncConversionResult {
    return {
        cellId: 'VU5PORT1',
        sourceHO: 'VU',
        edition: 4,
        issued: '2026-07-01',
        bbox: [167, -17, 169, -15],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 10, DRVAL2: 20 },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [167.1, -16.9],
                                    [168.9, -16.9],
                                    [168.9, -15.1],
                                    [167.1, -16.9],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCoverage.mockReturnValue([]);
    mocks.importCell.mockImplementation(async (cell: EncConversionResult) => ({
        id: cell.cellId,
        sourceHO: cell.sourceHO,
        edition: cell.edition,
        issued: cell.issued,
        importedAt: '2026-08-05T00:00:00.000Z',
        bbox: cell.bbox,
        geojsonPath: `enc-cells/${cell.cellId}.geojson`,
        hazardCount: 1,
    }));
});

describe('Pi-independent local ENC pack validation', () => {
    it('accepts a bare converted cell or batch and normalises the office code', () => {
        expect(validateLocalEncPack({ ...validCell(), sourceHO: 'vu' }).cells[0].sourceHO).toBe('VU');
        expect(validateLocalEncPack({ ...validCell(), cellId: 'vu5port1' }).cells[0].cellId).toBe('VU5PORT1');
        expect(validateLocalEncPack({ cells: [validCell()], skipped: [] }).cells).toHaveLength(1);
    });

    it('fails closed on unknown layers, missing depth coverage, or geometry outside the declared bbox', () => {
        const unknown = validCell({
            layers: {
                ...validCell().layers,
                DANGER_THAT_APP_WOULD_DROP: { type: 'FeatureCollection', features: [] },
            } as EncConversionResult['layers'],
        });
        expect(() => validateLocalEncPack(unknown)).toThrow(/unsupported chart layer/i);

        expect(() =>
            validateLocalEncPack({
                ...validCell(),
                layers: { LIGHTS: { type: 'FeatureCollection', features: [] } },
            }),
        ).toThrow(/no DEPARE\/DRGARE depth-area coverage/i);

        expect(() => validateLocalEncPack({ ...validCell(), bbox: [167.5, -16.5, 168.5, -15.5] })).toThrow(
            /outside its declared bbox/i,
        );

        const openRing = validCell();
        const polygon = openRing.layers.DEPARE!.features[0].geometry as GeoJSON.Polygon;
        polygon.coordinates[0][polygon.coordinates[0].length - 1] = [167.2, -16.8];
        expect(() => validateLocalEncPack(openRing)).toThrow(/closed GeoJSON ring/i);
    });

    it('bounds recursive geometry validation before a hostile pack can exhaust the call stack', () => {
        let geometry: GeoJSON.Geometry = validCell().layers.DEPARE!.features[0].geometry!;
        for (let depth = 0; depth < 34; depth += 1) {
            geometry = { type: 'GeometryCollection', geometries: [geometry] };
        }
        const nested = validCell();
        nested.layers.DEPARE!.features[0] = {
            ...nested.layers.DEPARE!.features[0],
            geometry,
        };

        expect(() => validateLocalEncPack(nested)).toThrow(/geometry nesting exceeds 32 levels/i);
    });

    it('recognises only converted pack filenames and explains raw/encrypted chart rejection', async () => {
        expect(isSupportedLocalEncPackFilename('Vanuatu.thalassaenc')).toBe(true);
        expect(isSupportedLocalEncPackFilename('Vanuatu.json')).toBe(true);
        expect(isSupportedLocalEncPackFilename('VU5PORT1.000')).toBe(false);

        await expect(importLocalEncPackFile(new File(['raw'], 'VU5PORT1.000'))).rejects.toThrow(
            /cannot decode S-57.*S-63.*o-charts/i,
        );
        expect(mocks.parseJsonOffThread).not.toHaveBeenCalled();
        expect(mocks.importCell).not.toHaveBeenCalled();
    });

    it('validates every cell before writing and refuses edition rollback', async () => {
        const invalidSecond = { ...validCell(), cellId: 'VU5PORT2', layers: {} };
        await expect(importLocalEncPackText(JSON.stringify({ cells: [validCell(), invalidSecond] }))).rejects.toThrow(
            /no DEPARE\/DRGARE/i,
        );
        expect(mocks.importCell).not.toHaveBeenCalled();

        mocks.getCoverage.mockReturnValue([{ id: 'VU5PORT1', edition: 5, usage: 'reference' }]);
        await expect(importLocalEncPackText(JSON.stringify(validCell({ edition: 4 })))).rejects.toThrow(
            /older than installed edition 5/i,
        );
        expect(mocks.importCell).not.toHaveBeenCalled();
    });

    it('never lets an unsigned pack replace trusted navigation coverage', async () => {
        mocks.getCoverage.mockReturnValue([{ id: 'vu5port1', edition: 3, usage: 'navigation' }]);

        await expect(importLocalEncPackText(JSON.stringify(validCell({ edition: 5 })))).rejects.toThrow(
            /unsigned reference pack cannot replace.*trusted chart was kept/i,
        );
        expect(mocks.importCell).not.toHaveBeenCalled();
    });

    it('imports a valid converted file locally and reports progress', async () => {
        const progress = vi.fn();
        const result = await importLocalEncPackFile(
            new File([JSON.stringify({ cells: [validCell()] })], 'Vanuatu.thalassaenc'),
            progress,
        );

        expect(result.cells.map((cell) => cell.id)).toEqual(['VU5PORT1']);
        expect(mocks.importCell).toHaveBeenCalledWith(expect.objectContaining({ cellId: 'VU5PORT1' }), {
            usage: 'reference',
        });
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'done', progress: 1 }));
    });
});

describe('Pi-independent ENC pack URL import', () => {
    it('requires credential-free HTTPS', () => {
        expect(() => validateLocalEncPackUrl('http://charts.example/pack.json')).toThrow(/must use HTTPS/i);
        expect(() => validateLocalEncPackUrl('https://user:secret@charts.example/pack.json')).toThrow(
            /must not contain embedded credentials/i,
        );
        expect(validateLocalEncPackUrl('https://charts.example/pack.json').hostname).toBe('charts.example');
    });

    it('downloads a direct HTTPS JSON pack and imports it without a Pi', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ cells: [validCell()] }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        );

        const result = await importLocalEncPackUrl('https://charts.example/Vanuatu.thalassaenc');
        expect(result.cells).toHaveLength(1);
        expect(fetch).toHaveBeenCalledWith(
            expect.objectContaining({ protocol: 'https:' }),
            expect.objectContaining({ credentials: 'omit', cache: 'no-store', redirect: 'error' }),
        );
        expect(mocks.importCell).toHaveBeenCalledWith(expect.objectContaining({ cellId: 'VU5PORT1' }), {
            usage: 'reference',
        });
        vi.unstubAllGlobals();
    });
});
