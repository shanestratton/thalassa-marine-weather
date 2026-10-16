// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { NOAA_AGREEMENT_SHA256, NOAA_AGREEMENT_URL } from '../services/enc/noaaAgreement';
import {
    parseNoaaIndex,
    parseNoaaShard,
    noaaIntersects,
    noaaRevisionNewer,
} from '../services/enc/noaaCatalogueContract';
const state = vi.hoisted(() => ({
    preferences: new Map<string, string>(),
    files: new Map<string, string>(),
    satellite: false,
    accepted: true,
    importer: vi.fn(),
    withdraw: vi.fn(),
    fetch: vi.fn(),
    writes: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA', Library: 'LIBRARY' },
    Filesystem: {
        writeFile: state.writes,
        readFile: async ({ path }: { path: string }) => {
            if (!state.files.has(path)) throw Error('Missing file');
            return { data: state.files.get(path) };
        },
        deleteFile: async ({ path }: { path: string }) => {
            state.files.delete(path);
        },
        stat: async ({ path }: { path: string }) => {
            if (!state.files.has(path)) throw Error('Missing file');
            return { size: 1 };
        },
    },
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: state.preferences.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            state.preferences.set(key, value);
        },
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => state.satellite }));
vi.mock('../services/enc/noaaAgreement', async (original) => ({
    ...(await original<typeof import('../services/enc/noaaAgreement')>()),
    noaaAgreementAccepted: async () => state.accepted,
}));
vi.mock('../services/enc/EncHazardService', () => ({
    importCell: state.importer,
    removeNoaaCatalogueRevision: state.withdraw,
}));
import {
    checkNoaaCatalogueWeekly,
    installNoaaCell,
    loadNoaaArea,
    readNoaaBytes,
    removeNoaaDownload,
    savedNoaaDownloads,
} from '../services/enc/noaaCatalogue';
const encode = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const hash = (v: Uint8Array): string => createHash('sha256').update(v).digest('hex');
const generation = 'a'.repeat(24),
    bounds: [number, number, number, number] = [-119, 33, -118, 34];
function fixture() {
    const chart = {
        cellId: 'US5CA1LK',
        sourceHO: 'US',
        edition: 1,
        updateNumber: 1,
        issued: '2026-04-22',
        bbox: [-118.5, 33.45, -118.425, 33.525],
        layers: { SBDARE: { type: 'FeatureCollection', features: [] } },
    };
    const json = encode(chart),
        zip = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
    const cell = {
        id: chart.cellId,
        title: 'Public NOAA test cove',
        bbox: chart.bbox,
        edition: 1,
        update: 1,
        issued: chart.issued,
        baseIssued: '2026-02-13',
        scale: 12000,
        sourceUrl: 'https://www.charts.noaa.gov/ENCs/US5CA1LK.zip',
        chart: { key: `objects/${hash(json)}.json`, bytes: json.length, sha256: hash(json) },
        zip: { key: `objects/${hash(zip)}.zip`, bytes: zip.length, sha256: hash(zip) },
    };
    const shard = encode({ schema: 1, generation, cells: [cell] });
    const index = {
        schema: 1,
        generation,
        checkedAt: new Date().toISOString(),
        sourceAt: new Date(Date.now() - 3600000).toISOString(),
        sourceSha256: 'b'.repeat(64),
        agreementSha256: NOAA_AGREEMENT_SHA256,
        sourceUrl: 'https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml',
        agreementUrl: NOAA_AGREEMENT_URL,
        activeCells: 1,
        attribution: 'NOAA ENC data. Not certified ECDIS.',
        withdrawn: [] as string[],
        shards: [
            {
                id: 'x06y12',
                bbox: [-120, 30, -110, 40],
                key: `generations/${generation}/shards/x06y12.json`,
                bytes: shard.length,
                sha256: hash(shard),
            },
        ],
    };
    const resources = new Map<string, Uint8Array>([
        ['index.json', encode(index)],
        [index.shards[0].key, shard],
        [cell.chart.key, json],
        [cell.zip.key, zip],
    ]);
    state.fetch.mockImplementation(async (url: string) => {
        const path = url.replace('https://tiles.thalassatiles.com/noaa-enc/v1/', '');
        const bytes = resources.get(path);
        return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response('Unavailable', { status: 404 });
    });
    return { index, cell, chart, json, zip, resources };
}
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', state.fetch);
    state.preferences.clear();
    state.files.clear();
    state.satellite = false;
    state.accepted = true;
    state.fetch.mockReset();
    state.importer.mockReset();
    state.withdraw.mockReset();
    state.writes.mockReset();
    state.importer.mockImplementation(async (_chart, options) => {
        options.assertAuthority();
    });
    state.withdraw.mockResolvedValue(true);
    state.writes.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
        state.files.set(path, data);
    });
    setAuthIdentityScope('noaa-test-a');
});
afterEach(() => {
    vi.unstubAllGlobals();
});
describe('NOAA regional source and phone import contract', () => {
    it('validates identity, agreement, active revisions, resource paths and dateline coverage', () => {
        const f = fixture(),
            index = parseNoaaIndex(f.index);
        expect(
            parseNoaaShard(JSON.parse(new TextDecoder().decode(f.resources.get(index.shards[0].key))), index)[0].id,
        ).toBe('US5CA1LK');
        expect(noaaIntersects([170, -20, -170, 20], [-180, -10, -175, 10])).toBe(true);
        expect(noaaIntersects([170, -20, -170, 20], [0, -10, 20, 10])).toBe(false);
        expect(noaaRevisionNewer({ edition: 2, update: 0 }, { edition: 1, updateNumber: 9 })).toBe(true);
        for (const change of [
            { agreementSha256: 'old' },
            { checkedAt: new Date(Date.now() + 600000).toISOString() },
            { shards: [{ ...f.index.shards[0], key: 'https://outside.invalid/object' }] },
            { withdrawn: ['AU5TEST1'] },
        ]) {
            expect(() => parseNoaaIndex({ ...f.index, ...change })).toThrow();
        }
        for (const change of [
            { edition: 0 },
            { id: 'AU5TEST1' },
            { sourceUrl: 'https://outside.invalid' },
            { chart: { ...f.cell.chart, key: '../secret' } },
            { zip: null },
        ]) {
            expect(() => parseNoaaShard({ schema: 1, generation, cells: [{ ...f.cell, ...change }] }, index)).toThrow();
        }
    });
    it('downloads static regional paths only, preserves exact original first and imports checked chart bytes', async () => {
        const f = fixture();
        const area = await loadNoaaArea(bounds);
        expect(area.cells).toHaveLength(1);
        expect(state.fetch.mock.calls.map((row) => row[0])).toEqual([
            'https://tiles.thalassatiles.com/noaa-enc/v1/index.json',
            `https://tiles.thalassatiles.com/noaa-enc/v1/${f.index.shards[0].key}`,
        ]);
        await installNoaaCell(area.cells[0]);
        expect(state.importer).toHaveBeenCalledWith(
            f.chart,
            expect.objectContaining({ usage: 'navigation', contentSha256: f.cell.chart.sha256 }),
        );
        const saved = await savedNoaaDownloads();
        expect(saved).toHaveLength(1);
        expect(saved[0].installed).toBe(true);
        expect(Uint8Array.from(atob(state.files.get(saved[0].path)!), (c) => c.charCodeAt(0))).toEqual(f.zip);
        expect(state.writes.mock.invocationCallOrder[0]).toBeLessThan(state.importer.mock.invocationCallOrder[0]);
        for (const [url, options] of state.fetch.mock.calls) {
            expect(url).not.toContain('?');
            expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
        }
        state.fetch.mockClear();
        await checkNoaaCatalogueWeekly();
        expect(state.fetch).not.toHaveBeenCalled();
    });
    it('offers cached metadata in Satellite Mode with no WAN and blocks all chart downloads', async () => {
        fixture();
        const area = await loadNoaaArea(bounds);
        state.fetch.mockClear();
        state.satellite = true;
        expect((await loadNoaaArea(bounds)).saved).toBe(true);
        await checkNoaaCatalogueWeekly();
        await expect(installNoaaCell(area.cells[0])).rejects.toThrow(/Satellite Mode/);
        expect(state.fetch).not.toHaveBeenCalled();
        expect(state.writes).not.toHaveBeenCalled();
        expect(state.importer).not.toHaveBeenCalled();
    });
    it('fails closed on wrong hash, cancelled source, missing conversion and stale publisher', async () => {
        const f = fixture();
        let area = await loadNoaaArea(bounds);
        f.resources.set(f.cell.chart.key, encode({ ...f.chart, edition: 0 }));
        await expect(installNoaaCell(area.cells[0])).rejects.toThrow(/checksum|unavailable/);
        expect(state.writes).not.toHaveBeenCalled();
        expect(state.importer).not.toHaveBeenCalled();
        state.preferences.clear();
        f.index.checkedAt = new Date(Date.now() - 9 * 86400000).toISOString();
        f.index.sourceAt = f.index.checkedAt;
        f.resources.set('index.json', encode(f.index));
        await expect(loadNoaaArea(bounds)).rejects.toThrow(/stale/);
        state.preferences.clear();
        f.index.checkedAt = new Date().toISOString();
        f.resources.set('index.json', encode(f.index));
        const unready = encode({ schema: 1, generation, cells: [{ ...f.cell, zip: null, chart: null }] });
        f.index.shards[0].bytes = unready.length;
        f.index.shards[0].sha256 = hash(unready);
        f.resources.set(f.index.shards[0].key, unready);
        f.resources.set('index.json', encode(f.index));
        area = await loadNoaaArea(bounds);
        await expect(installNoaaCell(area.cells[0])).rejects.toThrow(/not available/);
    });
    it('resumes a failed original write honestly and rejects delayed account completions', async () => {
        fixture();
        const area = await loadNoaaArea(bounds);
        state.writes.mockRejectedValueOnce(Error('Disk full'));
        await expect(installNoaaCell(area.cells[0])).rejects.toThrow('Disk full');
        expect((await savedNoaaDownloads())[0].installed).toBe(false);
        expect(state.importer).not.toHaveBeenCalled();
        await installNoaaCell(area.cells[0]);
        expect((await savedNoaaDownloads())[0].installed).toBe(true);
        setAuthIdentityScope('noaa-test-b');
        expect(await savedNoaaDownloads()).toEqual([]);
        let release!: (value: Response) => void;
        state.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const pending = loadNoaaArea(bounds);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        setAuthIdentityScope('noaa-test-c');
        release(new Response('{}'));
        await expect(pending).rejects.toThrow(/Account changed/);
    });
    it('withdraws tracked originals through exact-revision removal, retains ZIP and never reacquires withdrawn charts', async () => {
        const f = fixture();
        const area = await loadNoaaArea(bounds);
        await installNoaaCell(area.cells[0]);
        f.index.withdrawn = ['US5CA1LK'];
        f.index.shards = [];
        f.resources.set('index.json', encode(f.index));
        await loadNoaaArea(bounds, { refresh: true });
        expect(state.withdraw).toHaveBeenCalledWith(
            'US5CA1LK',
            { edition: 1, updateNumber: 1, contentSha256: f.cell.chart.sha256 },
            expect.any(Function),
        );
        const saved = await savedNoaaDownloads();
        expect(saved[0]).toMatchObject({ withdrawn: true, installed: false });
        expect(state.files.has(saved[0].path)).toBe(true);
        await expect(installNoaaCell(area.cells[0])).rejects.toThrow(/Check current/);
        await removeNoaaDownload(saved[0]);
        expect(await savedNoaaDownloads()).toEqual([]);
        expect(state.files.size).toBe(0);
    });
    it('does not fetch before consent and bounds misleading and unadvertised response bodies', async () => {
        fixture();
        state.accepted = false;
        await expect(loadNoaaArea(bounds)).rejects.toThrow(/agreement/);
        expect(state.fetch).not.toHaveBeenCalled();
        await expect(readNoaaBytes(new Response('123456'), 5)).rejects.toThrow(/limit/);
        await expect(readNoaaBytes(new Response('123', { headers: { 'content-length': '100' } }), 5)).rejects.toThrow(
            /unavailable/,
        );
    });
});
