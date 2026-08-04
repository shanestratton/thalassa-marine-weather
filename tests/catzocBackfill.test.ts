import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * CATZOC backfill.
 *
 * CATZOC is derived once, at import. Cells imported before that step existed
 * keep `catzocRange: undefined` forever, so the attribution chip reports
 * "no CATZOC" on charts whose stored M_QUAL actually declares a zone of
 * confidence — and the Pi re-sync can't fix it, because it skips cells whose
 * cellId + edition + sizeBytes are unchanged.
 *
 * Measured on OC-61-051031 (AU ed.16): four M_QUAL polygons, all CATZOC 6.
 * "ZOC U — unassessed" and "no CATZOC" are different claims to a navigator,
 * so the difference has to survive.
 */

const h = vi.hoisted(() => ({
    listCells: vi.fn(),
    putCell: vi.fn(),
    loadCellGeoJSON: vi.fn(),
}));

vi.mock('../services/enc/EncCellMetadata', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    listCells: h.listCells,
    putCell: h.putCell,
}));
vi.mock('../services/enc/EncCellStore', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    loadCellGeoJSON: h.loadCellGeoJSON,
}));

import { backfillCatzocRanges } from '../services/enc/EncHazardService';

/** An M_QUAL polygon carrying a CATZOC value, as the extractor emits it. */
function mqualBlob(catzocValues: number[]): Record<string, unknown> {
    return {
        cellId: 'OC-61-051031',
        layers: {
            M_QUAL: {
                type: 'FeatureCollection',
                features: catzocValues.map((v) => ({
                    type: 'Feature',
                    properties: { acronym: 'M_QUAL', CATZOC: v },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [153.0, -27.5],
                                [153.1, -27.5],
                                [153.1, -27.4],
                                [153.0, -27.4],
                                [153.0, -27.5],
                            ],
                        ],
                    },
                })),
            },
        },
    };
}

const cell = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'OC-61-051031',
    sourceHO: 'AU',
    edition: 16,
    bbox: [153, -27.5, 153.1, -27.4],
    geojsonPath: 'enc/OC-61-051031.json',
    hazardCount: 10,
    ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('backfillCatzocRanges', () => {
    it('derives the range from stored M_QUAL when it was never computed', async () => {
        h.listCells.mockReturnValue([cell({ catzocRange: undefined })]);
        h.loadCellGeoJSON.mockResolvedValue(mqualBlob([6, 6, 6, 6]));

        expect(await backfillCatzocRanges()).toBe(1);
        expect(h.putCell).toHaveBeenCalledWith(expect.objectContaining({ catzocRange: [6, 6] }));
    });

    it('keeps best..worst across mixed zones', async () => {
        h.listCells.mockReturnValue([cell({ catzocRange: undefined })]);
        h.loadCellGeoJSON.mockResolvedValue(mqualBlob([3, 6, 4]));

        await backfillCatzocRanges();
        expect(h.putCell).toHaveBeenCalledWith(expect.objectContaining({ catzocRange: [3, 6] }));
    });

    it('records null when the cell genuinely has no M_QUAL, so it is not re-read', async () => {
        h.listCells.mockReturnValue([cell({ catzocRange: undefined })]);
        h.loadCellGeoJSON.mockResolvedValue({ cellId: 'OC-61-051031', layers: {} });

        expect(await backfillCatzocRanges()).toBe(1);
        expect(h.putCell).toHaveBeenCalledWith(expect.objectContaining({ catzocRange: null }));
    });

    it('leaves already-computed cells alone — including a computed null', async () => {
        h.listCells.mockReturnValue([cell({ catzocRange: null }), cell({ id: 'X', catzocRange: [1, 2] })]);

        expect(await backfillCatzocRanges()).toBe(0);
        expect(h.loadCellGeoJSON).not.toHaveBeenCalled();
        expect(h.putCell).not.toHaveBeenCalled();
    });

    it('never triggers a network pull for a missing blob', async () => {
        h.listCells.mockReturnValue([cell({ catzocRange: undefined })]);
        h.loadCellGeoJSON.mockResolvedValue(null);

        expect(await backfillCatzocRanges()).toBe(0);
        // second arg false = local only
        expect(h.loadCellGeoJSON).toHaveBeenCalledWith('OC-61-051031', false);
        expect(h.putCell).not.toHaveBeenCalled();
    });

    it('survives a corrupt cell and carries on with the rest', async () => {
        h.listCells.mockReturnValue([
            cell({ catzocRange: undefined }),
            cell({ id: 'OC-61-051032', catzocRange: undefined }),
        ]);
        h.loadCellGeoJSON.mockRejectedValueOnce(new Error('blob unreadable')).mockResolvedValueOnce(mqualBlob([2]));

        expect(await backfillCatzocRanges()).toBe(1);
        expect(h.putCell).toHaveBeenCalledTimes(1);
    });

    it('respects the per-run cap so a big fleet is spread over launches', async () => {
        h.listCells.mockReturnValue(Array.from({ length: 5 }, (_, i) => cell({ id: `C${i}`, catzocRange: undefined })));
        h.loadCellGeoJSON.mockResolvedValue(mqualBlob([6]));

        expect(await backfillCatzocRanges(2)).toBe(2);
        expect(h.putCell).toHaveBeenCalledTimes(2);
    });
});
