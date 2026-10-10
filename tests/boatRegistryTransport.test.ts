/**
 * Her licensed charts come over the boat's own Wi-Fi only, and the registry
 * says honestly where they are (127-C-c, the stage-3 review).
 *
 *  - A licensed pull is addressed to the Pi's LAN host at the moment it runs,
 *    never to the live base, which turns to the tailnet whenever a health
 *    check does: a pull queued behind the 3 slots, or an index read over the
 *    tailnet that lands after the LAN is back, must not reach 100.x.
 *  - A first ask over the tailnet does not stick for the session.
 *  - An index the Pi refuses leaves the words at 'away', not "Opening…".
 *  - Registration reads the registry once, not once per row.
 *
 * The real import, registry, vault and piCellSync run; the pinned transport,
 * the Pi cache, Filesystem and the settings store are stubbed. Fictional
 * OC-99-ZZ… ids and a NOAA-shaped US5ZZ… one, in a synthetic Pacific box.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LAN = 'https://192.168.4.30:3001';
const TAILNET = 'https://100.64.0.9:3001';

const h = vi.hoisted(() => ({
    rows: [] as unknown[],
    bodies: new Map<string, string>(),
    dataUrls: [] as string[],
    indexFetches: 0,
    indexStatus: 200,
    onIndex: null as null | (() => void),
    gate: null as Promise<void> | null,
    remote: false,
    reachable: true,
}));

vi.mock('../services/piTls', () => ({
    piRequest: async (options: { url: string }) => {
        if (options.url.endsWith('/api/enc/installed')) {
            h.indexFetches += 1;
            h.onIndex?.();
            if (h.indexStatus !== 200) return { status: h.indexStatus, headers: {}, data: '', peerSpki: '' };
            return { status: 200, headers: {}, data: JSON.stringify({ cells: h.rows }), peerSpki: '' };
        }
        const m = /\/api\/enc\/installed\/([^/]+)\/data$/.exec(options.url);
        if (m) {
            h.dataUrls.push(options.url);
            if (h.gate) await h.gate;
            return { status: 200, headers: {}, data: h.bodies.get(decodeURIComponent(m[1]))!, peerSpki: '' };
        }
        throw new Error(`unexpected URL ${options.url}`);
    },
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => true,
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => h.reachable,
        // As the real one: _useRemote && status.reachable.
        get viaRemoteAccess() {
            return h.remote && h.reachable;
        },
        // The live base follows the health check's ladder, as the real one does.
        get baseUrl() {
            return h.remote ? 'https://100.64.0.9:3001' : 'https://192.168.4.30:3001';
        },
        getLanBaseUrl: () => 'https://192.168.4.30:3001',
        ping: async () => ({ reachable: true }),
        onStatusChange: () => () => undefined,
    },
}));
// Paired with her (piCellSync's view). The signed-response check reads its own
// pairing from storage, which stays empty here: the bodies are unsigned.
vi.mock('../services/PiPairingService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/PiPairingService')>()),
    getPairing: () => ({ deviceId: 'pi-fixture', publicKeySpki: 'key', boatName: 'Moana Nui' }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: {}, updateSettings: vi.fn() }) },
}));
vi.mock('@capacitor/filesystem', () => {
    const op = () => async () => {
        throw new Error('no Filesystem in this test');
    };
    return {
        Directory: { Data: 'DATA', Library: 'LIBRARY', Documents: 'DOCUMENTS', Cache: 'CACHE' },
        Encoding: { UTF8: 'utf8' },
        Filesystem: {
            writeFile: op(),
            readFile: op(),
            stat: op(),
            mkdir: op(),
            rename: op(),
            deleteFile: op(),
            rmdir: op(),
            readdir: async () => ({ files: [] }),
            getUri: async (o: { path: string; directory: string }) => ({ uri: `${o.directory}/${o.path}` }),
        },
    };
});

import { registerFromPiIndex, syncEncFromPi } from '../services/EncImportService';
import * as meta from '../services/enc/EncCellMetadata';
import * as vault from '../services/enc/boatCellVault';
import {
    boatChartsAwayAtCastOff,
    boatChartsNow,
    boatRegistryState,
    boatRegistryWhy,
    downloadPiCell,
    ensureBoatRegistry,
    forgetBoatCharts,
} from '../services/enc/piCellSync';

function serve(id: string, sourceHO: string, i: number) {
    const lon = -149.6 + (i % 40) * 0.02;
    const lat = -17.6 + Math.floor(i / 40) * 0.02;
    const bbox: [number, number, number, number] = [lon, lat, lon + 0.02, lat + 0.02];
    const ring = [
        [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[1]],
        ],
    ];
    const body = JSON.stringify({
        cells: [
            {
                cellId: id,
                sourceHO,
                edition: 3,
                issued: '2026-09-01',
                bbox,
                layers: {
                    DEPARE: {
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: { DRVAL1: 8, DRVAL2: 15 },
                                geometry: { type: 'Polygon', coordinates: ring },
                            },
                        ],
                    },
                },
            },
        ],
    });
    h.bodies.set(id, body);
    return {
        cellId: id,
        sourceHO,
        edition: 3,
        issued: '2026-09-01',
        bbox,
        featureCount: 1,
        sizeBytes: Buffer.byteLength(body) + 41,
        installedAt: '2026-09-30T00:00:00.000Z',
        source: sourceHO === 'US' ? 'url' : 'pi-decrypt',
        contentSha256: createHash('sha256').update(body).digest('hex'),
    };
}
const licensed = (n: number) =>
    Array.from({ length: n }, (_, i) => serve(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'ZZ', i));
const CENTRE = { lat: -17.59, lon: -149.59 };

beforeEach(async () => {
    forgetBoatCharts();
    localStorage.clear();
    meta.clearAllCellMetadata();
    vault.clear();
    Object.assign(h, { rows: [], dataUrls: [], indexFetches: 0, indexStatus: 200, onIndex: null, gate: null });
    h.bodies.clear();
    h.remote = false;
    h.reachable = true;
});

describe('licensed pulls go to the boat-LAN host at the moment they run', () => {
    it('a pull queued behind the 3 slots never reaches the tailnet when a health check turns to it', async () => {
        h.rows = licensed(4);
        registerFromPiIndex(h.rows as never);
        let release!: () => void;
        h.gate = new Promise<void>((resolve) => (release = resolve));
        const pulls = (h.rows as Array<{ cellId: string }>).map((row) => downloadPiCell(row.cellId));
        await vi.waitFor(() => expect(h.dataUrls).toHaveLength(3));
        // The 2 s LAN probe timed out, the tailnet answered: the live base is now 100.x.
        h.remote = true;
        release();
        const results = await Promise.all(pulls);
        expect(h.dataUrls.filter((url) => url.startsWith(TAILNET))).toEqual([]);
        expect(h.dataUrls.every((url) => url.startsWith(LAN))).toBe(true);
        expect(results).toEqual([true, true, true, false]);
        expect(vault.has('OC-99-ZZ0003')).toBe(false);
    });

    // The live base is still 100.x, but the status went unreachable while the
    // index came, so "via remote access" reads false: the transport must be
    // judged with the base, in the same tick, not after the index.
    it('an index read over the tailnet pre-warms nothing, even when the remote flag drops while it lands', async () => {
        h.remote = true;
        h.rows = [serve('US5ZZ01M', 'US', 40), ...licensed(5)];
        h.onIndex = () => {
            h.reachable = false;
        };
        const summary = await syncEncFromPi(undefined, { priorityCenter: CENTRE, maxCells: 20 });
        const licensedPulls = h.dataUrls.filter((url) => url.includes('/OC-99-'));
        expect(licensedPulls).toEqual([]);
        expect(summary.boatCharts).toBe('tailnet');
        expect(boatRegistryWhy()).toBe('tailnet');
    });

    // A guard (the import's authority check already stops a run whose base moved).
    it('a sync whose base turns to the tailnet part-way stops, with no licensed pull over it', async () => {
        h.rows = licensed(5);
        let release!: () => void;
        h.gate = new Promise<void>((resolve) => (release = resolve));
        const run = syncEncFromPi(undefined, { priorityCenter: CENTRE, maxCells: 20 });
        await vi.waitFor(() => expect(h.dataUrls).toHaveLength(1));
        h.remote = true;
        release();
        await expect(run).rejects.toThrow(/changed/);
        expect(h.dataUrls).toHaveLength(1);
        expect(h.dataUrls[0].startsWith(LAN)).toBe(true);
    });

    it('a Pi that goes quiet part-way gets no further licensed pull; each is reported, none sent', async () => {
        h.rows = licensed(4);
        let release!: () => void;
        h.gate = new Promise<void>((resolve) => (release = resolve));
        const run = syncEncFromPi(undefined, { priorityCenter: CENTRE, maxCells: 20 });
        await vi.waitFor(() => expect(h.dataUrls).toHaveLength(1));
        h.reachable = false;
        release();
        const summary = await run;
        expect(h.dataUrls).toHaveLength(1);
        expect(summary.cells).toHaveLength(1);
        expect(summary.skipped.map((s) => s.filename)).toHaveLength(3);
    });
});

describe('the boat registry tells the truth', () => {
    it('a first ask over the tailnet does not stick: back on her Wi-Fi the next ask reads the index', async () => {
        h.remote = true;
        h.rows = licensed(3);
        expect(await ensureBoatRegistry()).toBe('away');
        expect(boatRegistryWhy()).toBe('tailnet');
        expect(h.indexFetches).toBe(0);
        h.remote = false;
        expect(await ensureBoatRegistry()).toBe('loaded');
        expect(h.indexFetches).toBe(1);
        expect(boatRegistryState()).toBe('loaded');
        expect(meta.listCells().map((cell) => cell.id)).toContain('OC-99-ZZ0002');
    });

    it('an index the Pi refuses says away, not "Opening…" for the rest of the session', async () => {
        h.indexStatus = 503;
        expect(boatChartsNow()).toBe('opening');
        await expect(syncEncFromPi()).rejects.toThrow(/Failed to list Pi charts/);
        expect(boatRegistryState()).toBe('away');
        expect(boatChartsNow()).toBe('away');
    });

    it('Cast Off just after a launch aboard waits for her charts, so it does not say "recheck"', async () => {
        h.rows = licensed(2);
        expect(boatRegistryState()).toBe('pending');
        // The index lands while Cast Off waits: open, so no recheck words.
        expect(await boatChartsAwayAtCastOff(8_000)).toBeNull();
        expect(h.indexFetches).toBe(1);
        expect(boatRegistryState()).toBe('loaded');
    });

    it('Cast Off over remote access still says where to recheck, after a bounded wait', async () => {
        h.remote = true;
        h.rows = licensed(2);
        expect(await boatChartsAwayAtCastOff(8_000)).toEqual({ boatName: 'Moana Nui' });
        expect(h.indexFetches).toBe(0);
    });

    it('registration reads the registry once, not once per row (1,031 rows, two open charts held)', () => {
        for (const id of ['US5ZZ01M', 'US4ZZ02M'])
            meta.putCell({
                id,
                sourceHO: 'US',
                edition: 1,
                issued: '2026-08-01',
                importedAt: '2026-08-02T00:00:00.000Z',
                bbox: [-149.6, -17.6, -149.5, -17.5],
                geojsonPath: `enc-cells/${id}.geojson`,
                hazardCount: 4,
                usage: 'navigation',
                sizeBytes: 1000,
                licence: 'open',
            });
        const rows = licensed(1031);
        const reads = vi.spyOn(Storage.prototype, 'getItem');
        try {
            registerFromPiIndex(rows as never);
            // One index read per record written is putCell's own; the old loop added
            // a full registry read (index + every open record) for each row on top.
            expect(reads.mock.calls.length).toBeLessThan(rows.length * 1.5);
        } finally {
            reads.mockRestore();
        }
        expect(meta.listCells()).toHaveLength(1033);
    });
});
