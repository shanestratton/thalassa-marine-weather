import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Sync 12 charts from Pi" that never reached 0 (measured 2026-10-01).
 *
 * The twelve were two kinds of chart a sync can never add:
 *  - five Pi cells with no DEPARE/DRGARE depth areas, which the phone's pack
 *    validator rightly refuses — downloaded and refused on every sync;
 *  - seven legacy Pi index rows with no contentSha256, keyed id@edition@size,
 *    where the Pi's size is the byte length of ITS file and the phone's the
 *    byte length of the cell it re-serialised. They can never be equal, so the
 *    charts read as missing forever and were downloaded on every sync.
 *
 * The data here is synthetic. The sizes model the real mismatch: the Pi's row
 * is larger than what the phone stores, by the wrapper and the fields the
 * phone drops.
 */

type Layers = Record<string, { type: 'FeatureCollection'; features: unknown[] }>;
interface PiRow {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    installedAt: string;
    source: 'pi-decrypt';
    contentSha256?: string;
}

const square = (bbox: [number, number, number, number]) => {
    const [w, s, e, n] = bbox;
    return {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    };
};
const BBOX: [number, number, number, number] = [153.0, -27.5, 153.3, -27.2];
const withDepthAreas = (bbox: [number, number, number, number] = BBOX): Layers => ({
    DEPARE: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { DRVAL1: 2, DRVAL2: 10 }, geometry: square(bbox) }],
    },
});
const landOnly = (bbox: [number, number, number, number] = BBOX): Layers => ({
    LNDARE: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: square(bbox) }] },
});

const h = vi.hoisted(() => ({
    rows: [] as unknown[],
    bodies: new Map<string, string>(),
    fetched: [] as string[],
    held: [] as Record<string, unknown>[],
    importCell: vi.fn(),
}));

vi.mock('../services/piTls', () => ({
    piRequest: async (options: { url: string }) => {
        if (options.url.endsWith('/api/enc/installed'))
            return { status: 200, headers: {}, data: JSON.stringify({ cells: h.rows }), peerSpki: '' };
        const m = /\/api\/enc\/installed\/([^/]+)\/data$/.exec(options.url);
        if (m) {
            const id = decodeURIComponent(m[1]);
            h.fetched.push(id);
            return { status: 200, headers: {}, data: h.bodies.get(id)!, peerSpki: '' };
        }
        throw new Error(`unexpected URL ${options.url}`);
    },
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => true,
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: () => true, baseUrl: 'https://pi.local:3001' },
}));
vi.mock('../services/enc/EncHazardService', () => ({
    importCell: h.importCell,
    getCoverage: () => h.held,
}));

import { syncEncFromPi } from '../services/EncImportService';
import { planPiCellSync } from '../services/enc/piSyncPlan';
import * as vault from '../services/enc/boatCellVault';
import { clearAllCellMetadata } from '../services/enc/EncCellMetadata';
import { isProtectedChart } from '../services/enc/chartLicence';

/** Serve a Pi row and its body; the row's size is the Pi's file, as on the Pi. */
function servePi(
    cellId: string,
    edition: number,
    layers: Layers,
    options: { sha?: boolean; extraPiBytes?: number } = {},
): PiRow {
    const bbox = BBOX;
    // A genuine S-57 name carries its producer code; o-charts ids do not.
    const sourceHO = /^[A-Z]{2}\d/.test(cellId) ? cellId.slice(0, 2) : 'AU';
    const cell = { cellId, sourceHO, edition, issued: '2026-09-01', bbox, layers, stats: { pad: 'x' } };
    const body = JSON.stringify({ cells: [cell] });
    h.bodies.set(cellId, body);
    const row: PiRow = {
        cellId,
        sourceHO,
        edition,
        issued: '2026-09-01',
        bbox,
        featureCount: 1,
        sizeBytes: Buffer.byteLength(body) + (options.extraPiBytes ?? 0),
        installedAt: '2026-09-30T00:00:00.000Z',
        source: 'pi-decrypt',
        ...(options.sha ? { contentSha256: createHash('sha256').update(body).digest('hex') } : {}),
    };
    h.rows = [...h.rows.filter((r) => (r as PiRow).cellId !== cellId), row];
    return row;
}

/** What the phone's import records — its OWN byte count, never the Pi's. */
function wireImport(): void {
    h.importCell.mockImplementation(
        async (
            cell: { cellId: string; edition: number },
            opts: { contentSha256?: string; piSizeBytes?: number; licence?: 'open' | 'protected' },
        ) => {
            const stored = {
                id: cell.cellId,
                edition: cell.edition,
                sizeBytes: Buffer.byteLength(JSON.stringify(cell)),
                contentSha256: opts.contentSha256,
                ...(opts.piSizeBytes !== undefined ? { piSizeBytes: opts.piSizeBytes } : {}),
            };
            h.held = [...h.held.filter((c) => c.id !== cell.cellId), stored];
            // As the real import does since 127-C-c: a licensed cell's bytes go
            // to the in-memory vault, an open one's to disk.
            if (isProtectedChart({ id: cell.cellId, licence: opts.licence }))
                vault.put(cell.cellId, JSON.stringify(cell));
            return stored;
        },
    );
}

describe('Pi chart sync count — never offers a sync that cannot add anything', () => {
    beforeEach(() => {
        localStorage.clear();
        vault.clear();
        clearAllCellMetadata();
        h.rows = [];
        h.bodies.clear();
        h.fetched = [];
        h.held = [];
        h.importCell.mockReset();
        wireImport();
    });

    it('a legacy Pi row (no contentSha256) is held after one pull, not re-downloaded forever', async () => {
        servePi('FR466870', 6, withDepthAreas());
        await syncEncFromPi();
        expect(h.fetched).toEqual(['FR466870']);
        // The phone's own byte count differs from the Pi's row: that mismatch
        // is the bug. The Pi's size rides along to match on.
        const pulled = h.held[0];
        expect(pulled.sizeBytes).not.toBe((h.rows[0] as PiRow).sizeBytes);
        expect(pulled.piSizeBytes).toBe((h.rows[0] as PiRow).sizeBytes);

        h.fetched = [];
        await syncEncFromPi();
        expect(h.fetched, 'an unchanged legacy chart was downloaded again').toEqual([]);
    });

    it('a chart refused for having no depth areas is not downloaded again at the same revision', async () => {
        servePi('OC-61-031514', 2, landOnly(), { sha: true });
        const first = await syncEncFromPi();
        expect(h.fetched).toEqual(['OC-61-031514']);
        expect(first.skipped.map((s) => s.error)).toEqual([
            'OC-61-031514: no DEPARE/DRGARE depth-area coverage; the pack cannot verify water depths.',
        ]);

        h.fetched = [];
        await syncEncFromPi();
        expect(h.fetched, 'the same refused bytes were downloaded again').toEqual([]);
    });

    it('offers a corrected re-issue of a refused chart again, and forgets the refusal once it imports', async () => {
        servePi('OC-33-A94074', 1, landOnly(), { sha: true });
        await syncEncFromPi();
        expect(planPiCellSync(h.rows as PiRow[], h.held as never).withoutDepthAreas).toHaveLength(1);

        // Same id and edition, corrected bytes — a new content identity.
        servePi('OC-33-A94074', 1, withDepthAreas(), { sha: true });
        expect(planPiCellSync(h.rows as PiRow[], h.held as never).pending).toHaveLength(1);
        h.fetched = [];
        const summary = await syncEncFromPi();
        expect(h.fetched).toEqual(['OC-33-A94074']);
        expect(summary.skipped).toEqual([]);
        const plan = planPiCellSync(h.rows as PiRow[], h.held as never);
        expect(plan.pending).toEqual([]);
        expect(plan.withoutDepthAreas).toEqual([]);
    });

    it('reaches 0 after one sync with five refused charts and seven legacy rows', async () => {
        const refused = ['OC-61-031514', 'OC-61-360864', 'OC-33-A94074', 'OC-33-B94074', 'OC-33-C94074'];
        const legacy = [
            'US5GA22M',
            'OC-61-0P0525',
            'OC-61-1P4525',
            'OC-61-1P8625',
            'OC-61-2P4525',
            'FR466870',
            'GB501494',
        ];
        for (const id of refused) servePi(id, 1, landOnly(), { sha: true });
        // The Pi's recorded size need not even match its own file (GB501494's
        // row is 6 bytes short of the file on the real Pi): the phone keeps
        // whatever the row said.
        for (const [i, id] of legacy.entries()) servePi(id, 3, withDepthAreas(), { extraPiBytes: i % 2 ? -6 : 0 });
        servePi('OC-61-10ENB5', 17, withDepthAreas(), { sha: true });

        expect(planPiCellSync(h.rows as PiRow[], h.held as never).pending).toHaveLength(13);
        await syncEncFromPi();
        const plan = planPiCellSync(h.rows as PiRow[], h.held as never);
        expect(plan.pending.map((c) => c.cellId)).toEqual([]);
        expect(plan.withoutDepthAreas.map((c) => c.cellId).sort()).toEqual([...refused].sort());

        h.fetched = [];
        await syncEncFromPi();
        expect(h.fetched).toEqual([]);
    });

    it('reports a requested refused chart with its refusal instead of downloading it again', async () => {
        servePi('OC-61-360864', 2, landOnly(), { sha: true });
        await syncEncFromPi();
        h.fetched = [];
        const summary = await syncEncFromPi(undefined, { cellIds: ['OC-61-360864'] });
        expect(h.fetched).toEqual([]);
        expect(summary.skipped).toEqual([
            {
                filename: 'OC-61-360864',
                error: 'OC-61-360864: no DEPARE/DRGARE depth-area coverage; the pack cannot verify water depths.',
            },
        ]);
    });

    it('still re-pulls a legacy chart the Pi re-extracted (same id and edition, new size)', async () => {
        servePi('GB501494', 11, withDepthAreas());
        await syncEncFromPi();
        // The Pi re-extracts: same id, same edition, different bytes.
        servePi('GB501494', 11, { ...withDepthAreas(), ...landOnly() });
        h.fetched = [];
        await syncEncFromPi();
        expect(h.fetched).toEqual(['GB501494']);
    });

    it('a copy pulled before the Pi size was recorded is pulled once more, then held', async () => {
        const row = servePi('OC-61-1P8625', 0, withDepthAreas());
        // As every pre-2026-10-01 phone holds it: its own byte count only.
        h.held = [{ id: 'OC-61-1P8625', edition: 0, sizeBytes: row.sizeBytes - 691 }];
        expect(planPiCellSync(h.rows as PiRow[], h.held as never).pending).toHaveLength(1);
        await syncEncFromPi();
        expect(h.fetched).toEqual(['OC-61-1P8625']);
        expect(planPiCellSync(h.rows as PiRow[], h.held as never).pending).toEqual([]);
    });
});
