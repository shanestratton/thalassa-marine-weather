/**
 * syncEncFromPi splits the Pi's index by licence (127-C-c decision 7).
 *
 * Protected rows are registered in memory in ONE batch (metadata only: no
 * blob, no Filesystem call), then the nearest 20 are pre-warmed into the
 * vault. Open rows keep today's pull-to-disk plan. The manual sync is the
 * same: register + prewarm 20, never "every cell into memory". Over remote
 * access (the tailnet) no licensed cell is pulled at all.
 *
 * The real import, registry, store and vault run; the Pi transport, the
 * platform's Filesystem and the settings store are stubbed. 1,031 fictional
 * rows (OC-99-ZZ…) and two NOAA-shaped ones, in a synthetic Caribbean box.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    installedAt: string;
    source: 'pi-decrypt' | 'url';
    contentSha256: string;
    licence?: 'open' | 'protected';
}

const h = vi.hoisted(() => ({
    rows: [] as unknown[],
    bodies: new Map<string, string>(),
    fetched: [] as string[],
    fsCalls: [] as string[],
    viaRemoteAccess: false,
    settings: { boatCharts: undefined as { licensed: boolean } | null | undefined },
    updateSettings: vi.fn(),
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
    piCache: {
        isAvailable: () => true,
        baseUrl: 'https://pi.local:3001',
        get viaRemoteAccess() {
            return h.viaRemoteAccess;
        },
        ping: async () => ({ reachable: true }),
        onStatusChange: () => () => undefined,
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({
            settings: h.settings,
            updateSettings: (patch: Record<string, unknown>) => {
                h.updateSettings(patch);
                Object.assign(h.settings, patch);
            },
        }),
    },
}));
vi.mock('@capacitor/filesystem', () => {
    const op =
        (name: string, value: unknown = undefined) =>
        async (o: { path?: string; from?: string }) => {
            h.fsCalls.push(`${name}:${o.path ?? o.from}`);
            if (name === 'stat' || name === 'readFile') throw new Error('File does not exist');
            return value;
        };
    return {
        Directory: { Data: 'DATA', Library: 'LIBRARY', Documents: 'DOCUMENTS', Cache: 'CACHE' },
        Encoding: { UTF8: 'utf8' },
        Filesystem: {
            writeFile: op('writeFile', { uri: '' }),
            readFile: op('readFile'),
            stat: op('stat'),
            mkdir: op('mkdir'),
            rename: op('rename'),
            deleteFile: op('deleteFile'),
            rmdir: op('rmdir'),
            readdir: async () => ({ files: [] }),
            getUri: async (o: { path: string; directory: string }) => ({ uri: `${o.directory}/${o.path}` }),
        },
    };
});

import { registerFromPiIndex, syncEncFromPi } from '../services/EncImportService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import * as meta from '../services/enc/EncCellMetadata';
import * as vault from '../services/enc/boatCellVault';
import { downloadPiCell } from '../services/enc/piCellSync';

/** Rows spread across a synthetic box; row 0 sits on the priority centre. */
function serve(id: string, sourceHO: string, i: number, extra: Partial<Row> = {}): Row {
    const lon = -61.0 - (i % 40) * 0.05;
    const lat = 15.0 + Math.floor(i / 40) * 0.05;
    const bbox: [number, number, number, number] = [lon, lat, lon + 0.04, lat + 0.04];
    const square = [
        [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[1]],
        ],
    ];
    const cell = {
        cellId: id,
        sourceHO,
        edition: 5,
        issued: '2026-09-01',
        bbox,
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 6, DRVAL2: 12 },
                        geometry: { type: 'Polygon', coordinates: square },
                    },
                ],
            },
        },
    };
    const body = JSON.stringify({ cells: [cell] });
    h.bodies.set(id, body);
    return {
        cellId: id,
        sourceHO,
        edition: 5,
        issued: '2026-09-01',
        bbox,
        featureCount: 1,
        sizeBytes: Buffer.byteLength(body) + 37,
        installedAt: '2026-09-30T00:00:00.000Z',
        source: sourceHO === 'US' ? 'url' : 'pi-decrypt',
        contentSha256: createHash('sha256').update(body).digest('hex'),
        ...extra,
    };
}

const protectedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => serve(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'ZZ', i));
const CENTRE = { lat: 15.01, lon: -60.99 };
const fsWrites = () => h.fsCalls.filter((c) => /^(writeFile|mkdir|rename)/.test(c));

describe('syncEncFromPi — the protected half registers in memory and pre-warms 20', () => {
    beforeEach(() => {
        localStorage.clear();
        meta.clearAllCellMetadata();
        vault.clear();
        h.rows = [];
        h.bodies.clear();
        h.fetched = [];
        h.fsCalls = [];
        h.viaRemoteAccess = false;
        h.settings = { boatCharts: undefined };
        h.updateSettings.mockClear();
    });

    it('1,031 protected rows: registered in one notify, at most 20 blobs pulled, no Filesystem write', async () => {
        h.rows = protectedRows(1031);
        const heard = vi.fn();
        const off = meta.subscribe(heard);
        await syncEncFromPi(undefined, { priorityCenter: CENTRE, maxCells: 20 });
        off();
        expect(meta.listCells()).toHaveLength(1031);
        expect(h.fetched.length).toBeLessThanOrEqual(20);
        expect(h.fetched).toContain('OC-99-ZZ0000');
        expect(fsWrites()).toEqual([]);
        // One notify for the whole registration batch, then one per pre-warm wave at most.
        expect(heard.mock.calls.length).toBeLessThanOrEqual(1 + h.fetched.length);
        expect(meta.boatRegistryLoaded()).toBe(true);
        for (const id of h.fetched) expect(vault.has(id)).toBe(true);
    });

    it('the manual sync (no cap given) pre-warms 20, not 1,031', async () => {
        h.rows = protectedRows(1031);
        await syncEncFromPi();
        expect(h.fetched.length).toBeLessThanOrEqual(20);
        expect(meta.listCells()).toHaveLength(1031);
    });

    it('a second sync re-registers nothing and pulls only what the vault lacks', async () => {
        h.rows = protectedRows(30);
        await syncEncFromPi(undefined, { priorityCenter: CENTRE, maxCells: 20 });
        const version = meta.getVersion();
        h.fetched = [];
        await syncEncFromPi(undefined, { priorityCenter: CENTRE, maxCells: 20 });
        expect(h.fetched).toEqual([]);
        expect(meta.getVersion()).toBe(version);
    });

    it('open rows still pull to disk as before', async () => {
        h.rows = [serve('US5ZZ01M', 'US', 0), serve('US4ZZ02M', 'US', 1), ...protectedRows(3)];
        await syncEncFromPi();
        expect(h.fetched).toEqual(expect.arrayContaining(['US5ZZ01M', 'US4ZZ02M']));
        expect(
            fsWrites()
                .filter((c) => c.startsWith('writeFile'))
                .sort(),
        ).toEqual(['writeFile:enc-cells/US4ZZ02M.geojson', 'writeFile:enc-cells/US5ZZ01M.geojson']);
    });

    it('over remote access no licensed cell is registered or pulled, and the reason is returned', async () => {
        h.viaRemoteAccess = true;
        h.rows = [serve('US5ZZ01M', 'US', 0), ...protectedRows(5)];
        const summary = await syncEncFromPi();
        expect(h.fetched).toEqual(['US5ZZ01M']);
        expect(meta.listCells().map((c) => c.id)).toEqual(['US5ZZ01M']);
        expect(summary.boatCharts).toEqual('tailnet');
        expect(await downloadPiCell('OC-99-ZZ0001')).toBe(false);
    });

    it('register from the index, then import the blob: the fingerprint is byte-identical', async () => {
        const rows = protectedRows(3);
        registerFromPiIndex(rows as never);
        const scope: [number, number, number, number] = [-62, 14.9, -60.9, 15.1];
        const before = meta.getRegistryFingerprint(scope);
        expect(before).toContain('OC-99-ZZ0001');
        expect(await downloadPiCell('OC-99-ZZ0001')).toBe(true);
        expect(vault.has('OC-99-ZZ0001')).toBe(true);
        expect(meta.getRegistryFingerprint(scope)).toBe(before);
    });
});

describe('the boatCharts account flag (127-DESKMAP C1)', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('flag-owner');
        localStorage.clear();
        meta.clearAllCellMetadata();
        vault.clear();
        h.settings = { boatCharts: undefined };
        h.updateSettings.mockClear();
    });

    it('an index with one protected row writes { licensed: true } once; an identical one writes nothing', () => {
        registerFromPiIndex([serve('OC-99-ZZ0500', 'ZZ', 0), serve('US5ZZ01M', 'US', 1)] as never);
        expect(h.updateSettings).toHaveBeenCalledTimes(1);
        expect(h.updateSettings).toHaveBeenCalledWith({ boatCharts: { licensed: true } });
        registerFromPiIndex([serve('OC-99-ZZ0500', 'ZZ', 0), serve('US5ZZ01M', 'US', 1)] as never);
        expect(h.updateSettings).toHaveBeenCalledTimes(1);
    });

    it('signed out, nothing is written', () => {
        setAuthIdentityScope(null);
        registerFromPiIndex([serve('OC-99-ZZ0501', 'ZZ', 0)] as never);
        expect(h.updateSettings).not.toHaveBeenCalled();
    });

    it('an all-NOAA index writes false', () => {
        registerFromPiIndex([serve('US5ZZ01M', 'US', 0)] as never);
        expect(h.updateSettings).toHaveBeenCalledWith({ boatCharts: { licensed: false } });
    });

    it('forgetPairing writes null', async () => {
        h.settings = { boatCharts: { licensed: true } };
        const { forgetPairing } = await import('../services/PiPairingService');
        forgetPairing();
        await vi.waitFor(() => expect(h.updateSettings).toHaveBeenCalledWith({ boatCharts: null }));
    });

    it('the flag rides user_settings: settingsForCloudSync never strips it', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('stores/settingsStore.ts', 'utf8');
        const body = src.slice(
            src.indexOf('function settingsForCloudSync'),
            src.indexOf('return withoutRetiredSettings'),
        );
        expect(body).toContain('vessel: _vessel');
        expect(body).not.toContain('boatCharts');
    });
});
