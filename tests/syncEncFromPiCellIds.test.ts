import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Auto-sync pulls the 20 cells nearest the current fix. That is right for
 * charts where the boat IS and wrong for charts where it is GOING: the Nouméa
 * approach cell sits ~1400 km from Moreton Bay and sorts 150th of 342 on the
 * Pi, so proximity alone would never fetch it, and the only alternative was an
 * uncapped sync of every missing cell.
 *
 * `cellIds` is the targeted path — it must beat BOTH the proximity sort and
 * the cap, or the passage-planning case stays broken.
 */

const PI_CELLS = [
    { cellId: 'OC-61-051031', edition: 1, bbox: [153.0, -27.5, 153.3, -27.0], sizeBytes: 100 },
    { cellId: 'OC-61-051032', edition: 1, bbox: [153.1, -27.4, 153.4, -26.9], sizeBytes: 100 },
    { cellId: 'FR466870', edition: 6, bbox: [166.2, -22.65, 166.64, -22.06], sizeBytes: 200 },
];

const h = vi.hoisted(() => ({
    get: vi.fn(),
    isAvailable: vi.fn(() => true),
    importCell: vi.fn(async (cell: { cellId: string }) => ({ id: cell.cellId, edition: 1 })),
    getCoverage: vi.fn(() => [] as { id: string; edition: number; sizeBytes?: number }[]),
}));

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: h.get } }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: h.isAvailable, baseUrl: 'http://pi.local:3001' },
}));
vi.mock('../services/enc/EncHazardService', () => ({
    importCell: h.importCell,
    getCoverage: h.getCoverage,
}));

import { syncEncFromPi } from '../services/EncImportService';

/** Serve the installed-cell list, then per-cell data for any cell requested. */
function wireHttp(): void {
    h.get.mockImplementation(async ({ url }: { url: string }) => {
        if (url.endsWith('/api/enc/installed')) {
            return { status: 200, data: { cells: PI_CELLS } };
        }
        const m = /\/api\/enc\/installed\/([^/]+)\/data$/.exec(url);
        if (m) {
            const cellId = decodeURIComponent(m[1]);
            return { status: 200, data: { cells: [{ cellId, edition: 1, layers: {}, bbox: [0, 0, 0, 0] }] } };
        }
        throw new Error(`unexpected URL ${url}`);
    });
}

/** Cell ids actually fetched, in order. */
function fetchedCellIds(): string[] {
    return h.get.mock.calls
        .map(([arg]: [{ url: string }]) => /\/api\/enc\/installed\/([^/]+)\/data$/.exec(arg.url)?.[1])
        .filter((v): v is string => Boolean(v))
        .map((v) => decodeURIComponent(v));
}

describe('syncEncFromPi — explicit cellIds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.getCoverage.mockReturnValue([]);
        wireHttp();
    });

    it('pulls only the requested cell', async () => {
        await syncEncFromPi(undefined, { cellIds: ['FR466870'] });
        expect(fetchedCellIds()).toEqual(['FR466870']);
    });

    it('beats a proximity centre that would sort the cell last', async () => {
        // Moreton Bay — FR466870 is the farthest of the three.
        await syncEncFromPi(undefined, {
            cellIds: ['FR466870'],
            priorityCenter: { lat: -27.21, lon: 153.1 },
        });
        expect(fetchedCellIds()).toEqual(['FR466870']);
    });

    it('beats a cap smaller than the cellrank', async () => {
        await syncEncFromPi(undefined, {
            cellIds: ['FR466870'],
            priorityCenter: { lat: -27.21, lon: 153.1 },
            maxCells: 1,
        });
        expect(fetchedCellIds()).toEqual(['FR466870']);
    });

    it('is case-insensitive on the requested id', async () => {
        await syncEncFromPi(undefined, { cellIds: ['fr466870'] });
        expect(fetchedCellIds()).toEqual(['FR466870']);
    });

    it('still skips a cell the device already holds at the same edition and size', async () => {
        h.getCoverage.mockReturnValue([{ id: 'FR466870', edition: 6, sizeBytes: 200 }]);
        await syncEncFromPi(undefined, { cellIds: ['FR466870'] });
        expect(fetchedCellIds()).toEqual([]);
    });

    it('leaves proximity ordering intact when no cellIds are given', async () => {
        await syncEncFromPi(undefined, { priorityCenter: { lat: -27.21, lon: 153.1 }, maxCells: 2 });
        const ids = fetchedCellIds();
        expect(ids).toHaveLength(2);
        expect(ids).not.toContain('FR466870');
    });
});
