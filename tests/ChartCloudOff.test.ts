/**
 * Chart cloud off (126-20, and the personal shelf deleted in 127): no
 * licensed chart cell goes to, or comes from, the cloud.
 *
 * o-charts (Roberto, 2026-10-10, pasted by Shane): "Storing unencrypted data
 * on any medium, and especially in the cloud, is strictly prohibited by the
 * terms of the licenses signed with the chart providers."
 *
 * The REAL supabase-js client with only fetch faked, so "no storage call"
 * means no request leaves the device: the fake Storage would happily serve a
 * personal manifest, personal cells and a mixed root manifest, and accept any
 * upload. Nothing may ask for the personal shelf (127 deletes the module); the
 * shared root shelf may register and download public-domain NOAA cells, and
 * nothing else.
 *
 * Fictional data only: licensed-style ZZ5TEST1 and OC-99-ZZTEST, NOAA-shaped
 * US5XX01M, account user-zz, test.invalid URLs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';

type BBox = [number, number, number, number];

/** A fictional NOAA harbour cell and a fictional licensed cell beside it (overlapping on purpose). */
const US_BBOX: BBox = [-70.9, 42.2, -70.6, 42.5];
const ZZ_BBOX: BBox = [-70.8, 42.3, -70.5, 42.6];
const OC_BBOX: BBox = [-70.7, 42.4, -70.4, 42.7];

function conversion(cellId: string, sourceHO: string, bbox: BBox): EncConversionResult {
    const [west, south, east, north] = bbox;
    return {
        cellId,
        sourceHO,
        edition: 3,
        updateNumber: 0,
        issued: '2026-09-01',
        bbox,
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 5, DRVAL2: 10 },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [west + 0.01, south + 0.01],
                                    [east - 0.01, south + 0.01],
                                    [east - 0.01, north - 0.01],
                                    [west + 0.01, south + 0.01],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
    } as EncConversionResult;
}

const h = vi.hoisted(() => {
    const requests: { method: string; path: string }[] = [];
    const objects = new Map<string, string>();
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.pathname.startsWith('/storage/')) requests.push({ method, path: url.pathname });
        const prefix = '/storage/v1/object/enc-cells/';
        if (url.pathname.startsWith(prefix)) {
            const name = decodeURIComponent(url.pathname.slice(prefix.length));
            if (method === 'GET') {
                const text = objects.get(name);
                if (text === undefined) {
                    return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
                }
                const response = new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
                // jsdom's global Blob has no text(); WKWebView's does. Hand back
                // Node's, as the device would hand back its own.
                const { Blob: NodeBlob } = await import('node:buffer');
                Object.defineProperty(response, 'blob', {
                    value: async () => new NodeBlob([text], { type: 'application/json' }),
                });
                return response;
            }
            // Any upload is accepted: the test is that none is attempted.
            return json(200, { Key: `enc-cells/${name}`, Id: 'object-zz' });
        }
        return json(404, { message: `unexpected ${url.pathname}` });
    });
    return { requests, objects, fetch };
});

vi.mock('../services/supabase', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    return {
        supabase: createClient('https://chart-cloud.test.invalid', 'anon-test-key', {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: h.fetch as unknown as typeof fetch },
        }),
        isSupabaseConfigured: () => true,
        getCurrentUserId: async () => 'user-zz',
    };
});
vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
// Rung 1 is the boat's Pi: off the boat in these tests.
const pi = vi.hoisted(() => ({ downloadPiCell: vi.fn(async (_cellId: string) => false) }));
vi.mock('../services/enc/piCellSync', () => pi);
// The validated import transaction, reduced to what these paths need: the
// bytes land in the real local store and the real registry.
vi.mock('../services/enc/EncHazardService', () => ({
    importCell: vi.fn(
        async (blob: EncConversionResult, options: { usage?: EncCell['usage']; cloudManifestVersion?: number }) => {
            const { saveCellGeoJSON } = await import('../services/enc/EncCellStore');
            const { putCell } = await import('../services/enc/EncCellMetadata');
            const { path, sizeBytes } = await saveCellGeoJSON(blob.cellId, blob);
            const cell: EncCell = {
                id: blob.cellId,
                sourceHO: blob.sourceHO,
                edition: blob.edition,
                issued: blob.issued,
                importedAt: '2026-10-10T00:00:00.000Z',
                bbox: blob.bbox,
                geojsonPath: path,
                hazardCount: 1,
                usage: options.usage ?? 'navigation',
                sizeBytes,
                ...(options.cloudManifestVersion !== undefined
                    ? { cloudManifestVersion: options.cloudManifestVersion }
                    : {}),
            };
            putCell(cell, { allowAuthorityUpgrade: true });
            return cell;
        },
    ),
    invalidateCloudCellBlob: vi.fn(async () => false),
    retireCloudCell: vi.fn(async () => false),
}));

/** Fresh module state per test: both sync modules cache their manifests. */
async function load() {
    vi.resetModules();
    const { Filesystem } = (await import('@capacitor/filesystem')) as unknown as { Filesystem: { reset(): void } };
    Filesystem.reset();
    const { supabase } = await import('../services/supabase');
    // The mocked client can outlive resetModules, and spyOn then hands back
    // the same spy: clear it so each test counts only its own calls.
    const storageFrom = vi.spyOn(supabase!.storage, 'from');
    storageFrom.mockClear();
    return {
        storageFrom,
        cloud: await import('../services/enc/cloudCellSync'),
        store: await import('../services/enc/EncCellStore'),
        meta: await import('../services/enc/EncCellMetadata'),
    };
}

/** What the fake Storage holds: a personal shelf and a mixed root shelf. */
function stockTheBucket(): void {
    h.objects.clear();
    h.objects.set(
        'manifest.json',
        JSON.stringify({
            version: 3,
            cells: [
                { cellId: 'US5XX01M', bbox: US_BBOX },
                { cellId: 'ZZ5TEST1', bbox: ZZ_BBOX },
            ],
        }),
    );
    h.objects.set('US5XX01M.json', JSON.stringify(conversion('US5XX01M', 'US', US_BBOX)));
    h.objects.set('ZZ5TEST1.json', JSON.stringify(conversion('ZZ5TEST1', 'ZZ', ZZ_BBOX)));
    h.objects.set(
        'u/user-zz/manifest.json',
        JSON.stringify({
            version: 4,
            cells: [
                { cellId: 'ZZ5TEST1', bbox: ZZ_BBOX, sourceBytes: 1, edition: 3 },
                { cellId: 'OC-99-ZZTEST', bbox: OC_BBOX, sourceBytes: 1, edition: 3 },
            ],
        }),
    );
    h.objects.set('u/user-zz/ZZ5TEST1.json', JSON.stringify(conversion('ZZ5TEST1', 'ZZ', ZZ_BBOX)));
    h.objects.set('u/user-zz/OC-99-ZZTEST.json', JSON.stringify(conversion('OC-99-ZZTEST', 'ZZ', OC_BBOX)));
}

/** A licensed chart synced from the boat's Pi: bytes on this device, Pi identity, no cloud marker. */
async function holdPiSyncedChart(env: Awaited<ReturnType<typeof load>>): Promise<void> {
    const blob = conversion('ZZ4TEST2', 'ZZ', ZZ_BBOX);
    const { path, sizeBytes } = await env.store.saveCellGeoJSON(blob.cellId, blob);
    env.meta.putCell({
        id: blob.cellId,
        sourceHO: blob.sourceHO,
        edition: blob.edition,
        issued: blob.issued,
        importedAt: '2026-10-09T00:00:00.000Z',
        bbox: blob.bbox,
        geojsonPath: path,
        hazardCount: 1,
        usage: 'navigation',
        sizeBytes,
        piSizeBytes: sizeBytes,
        contentSha256: 'c'.repeat(64),
    });
}

const storageRequests = () => h.requests.map((request) => `${request.method} ${request.path}`);

function tracked(...paths: string[]): string[] {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], { maxBuffer: 64 * 1024 * 1024 })
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
}

beforeEach(() => {
    localStorage.clear();
    h.requests.length = 0;
    h.fetch.mockClear();
    pi.downloadPiCell.mockClear();
    stockTheBucket();
});

describe('the personal chart shelf is gone (127)', () => {
    // 126-20 switched it off; 127 deletes it. The fake bucket above still
    // holds a personal shelf for user-zz, so every test below would see a
    // request to it if any path were left.
    it('the module is deleted', () => {
        expect(existsSync('services/enc/personalCellSync.ts')).toBe(false);
    });

    it('no app source names the personal shelf or its owner prefix', () => {
        const app = tracked(
            'App.tsx',
            'ApplicationShell.tsx',
            'components',
            'contexts',
            'hooks',
            'pages',
            'services',
            'stores',
            'utils',
            'workers',
        ).filter((path) => /\.(ts|tsx)$/.test(path));
        expect(app.length).toBeGreaterThan(500);
        const offenders = app.filter((path) => {
            const source = readFileSync(path, 'utf8');
            // Imports and the shelf's object paths. (A comment may still tell
            // the history: EncPersonalCloudPanel's header is 127-C-c's to reword.)
            return /from '[^']*personalCellSync'|import\('[^']*personalCellSync'\)|enc-cells\/u\/|[`'"]u\/\$\{/.test(
                source,
            );
        });
        expect(offenders).toEqual([]);
    });

    it('the validated import no longer takes a personal manifest version', () => {
        // The field stays on EncCell as a read-only legacy marker (old records,
        // the Pi mirror), but nothing can write it any more.
        expect(readFileSync('services/enc/EncHazardService.ts', 'utf8')).not.toContain('personalManifestVersion');
    });

    it('the end of a Pi sync calls no publish hook (EncInstallFlow runs the sync itself)', () => {
        const importService = readFileSync('services/EncImportService.ts', 'utf8');
        expect(importService).not.toMatch(/publishNewCellsIfEnabled|publishPersonalCells/);
    });

    it('a licensed chart held from the Pi is left alone by the cloud passes', async () => {
        const env = await load();
        await holdPiSyncedChart(env);
        const before = env.meta.listRegisteredCells();

        await env.cloud.registerCloudCells();
        await env.cloud.downloadCloudCellsForBBox(ZZ_BBOX);

        expect(env.meta.getRegisteredCell('ZZ4TEST2')).toEqual(before.find((cell) => cell.id === 'ZZ4TEST2'));
        expect(storageRequests().filter((request) => request.includes('/u/'))).toEqual([]);
        expect(storageRequests().filter((request) => !request.startsWith('GET '))).toEqual([]);
    });
});

describe('loadCellGeoJSON reaches the cloud for NOAA cells only', () => {
    it('tries the Pi, then the NOAA shelf, and stops: two rungs, no third', async () => {
        const env = await load();

        await expect(env.store.loadCellGeoJSON('OC-99-ZZTEST')).resolves.toBeNull();

        expect(pi.downloadPiCell).toHaveBeenCalledExactlyOnceWith('OC-99-ZZTEST');
        expect(storageRequests()).toEqual([]);
        const ladder = readFileSync('services/enc/EncCellStore.ts', 'utf8');
        const body = ladder.slice(ladder.indexOf('export async function loadCellGeoJSON'));
        const rungs = body.slice(0, body.indexOf('\n}\n')).match(/await import\('\.\/[A-Za-z]+'\)/g);
        expect(rungs).toEqual(["await import('./piCellSync')", "await import('./cloudCellSync')"]);
    });

    it.each(['ZZ5TEST1', 'OC-99-ZZTEST'])(
        'a licensed cell missing from this device stays missing: %s is never fetched from either shelf',
        async (cellId) => {
            const env = await load();

            await expect(env.store.loadCellGeoJSON(cellId)).resolves.toBeNull();

            expect(env.storageFrom).not.toHaveBeenCalled();
            expect(storageRequests()).toEqual([]);
            expect(env.meta.getRegisteredCell(cellId)).toBeNull();
        },
    );

    it('a NOAA cell still loads from the shared shelf, and only from the root', async () => {
        const env = await load();

        const blob = await env.store.loadCellGeoJSON('US5XX01M');

        expect(blob?.cellId).toBe('US5XX01M');
        expect(storageRequests()).toEqual([
            'GET /storage/v1/object/enc-cells/manifest.json',
            'GET /storage/v1/object/enc-cells/US5XX01M.json',
        ]);
        expect(env.meta.getRegisteredCell('US5XX01M')).toMatchObject({ usage: 'navigation', cloudManifestVersion: 3 });
    });
});

describe('the shared root shelf registers and downloads NOAA cells only', () => {
    it("names NOAA cells exactly as the server's read policy does", async () => {
        const { cloud } = await load();
        for (const id of ['US5XX01M', 'US1ZZ999', 'us5xx01m']) expect(cloud.isNoaaEncCellId(id), id).toBe(true);
        for (const id of [
            'ZZ5TEST1',
            'OC-99-ZZTEST',
            'USX12345',
            'US5XX01MZ',
            'US5XX01',
            'XUS5XX01M',
            'US5XX01M.json',
        ]) {
            expect(cloud.isNoaaEncCellId(id), id).toBe(false);
        }
    });

    it('a mixed root manifest registers the NOAA cell and never the licensed one', async () => {
        const env = await load();

        await expect(env.cloud.registerCloudCells()).resolves.toBe(1);

        expect(env.meta.getRegisteredCell('US5XX01M')).toMatchObject({ usage: 'pending', cloudManifestVersion: 3 });
        expect(env.meta.getRegisteredCell('ZZ5TEST1')).toBeNull();
        expect(storageRequests()).toEqual(['GET /storage/v1/object/enc-cells/manifest.json']);
    });

    it('downloadCloudCell refuses a licensed cell before any request, even one the manifest lists', async () => {
        const env = await load();

        await expect(env.cloud.downloadCloudCell('ZZ5TEST1')).resolves.toBe(false);

        expect(env.storageFrom).not.toHaveBeenCalled();
        expect(storageRequests()).toEqual([]);
    });

    it('a route corridor over both cells fills from the NOAA cell alone', async () => {
        const env = await load();

        const fill = await env.cloud.downloadCloudCellsForBBox([-70.85, 42.35, -70.55, 42.45]);

        expect(fill).toEqual({ downloaded: 1, needed: 1, bucketAvailable: true });
        expect(storageRequests()).toEqual([
            'GET /storage/v1/object/enc-cells/manifest.json',
            'GET /storage/v1/object/enc-cells/US5XX01M.json',
        ]);
        expect(env.meta.getRegisteredCell('ZZ5TEST1')).toBeNull();
    });

    it('with no root manifest the bucket is reported unavailable, whatever the personal shelf holds', async () => {
        h.objects.delete('manifest.json');
        const env = await load();

        const fill = await env.cloud.downloadCloudCellsForBBox(ZZ_BBOX);

        expect(fill).toEqual({ downloaded: 0, needed: 0, bucketAvailable: false });
        expect(storageRequests()).toEqual(['GET /storage/v1/object/enc-cells/manifest.json']);
    });

    it('a device that synced the root manifest before 126 still accepts the same version', async () => {
        // Before 126 the continuity signature covered every entry the manifest
        // listed. Keeping that meaning means an unchanged manifest, if it is
        // ever readable again, is not mistaken for one rewritten in place.
        localStorage.setItem('thalassa_enc_cloud_manifest_version', '3');
        const before126 = JSON.stringify({
            version: 3,
            cells: [
                { cellId: 'US5XX01M', bbox: US_BBOX },
                { cellId: 'ZZ5TEST1', bbox: ZZ_BBOX },
            ],
        });
        localStorage.setItem('thalassa_enc_cloud_manifest_signature', before126);
        const env = await load();

        await expect(env.cloud.registerCloudCells()).resolves.toBe(1);

        expect(env.meta.getRegisteredCell('US5XX01M')).toMatchObject({ usage: 'pending', cloudManifestVersion: 3 });
        expect(env.meta.getRegisteredCell('ZZ5TEST1')).toBeNull();
        expect(localStorage.getItem('thalassa_enc_cloud_manifest_signature')).toBe(before126);
    });

    it('a manifest rewritten without a version bump is still refused', async () => {
        localStorage.setItem('thalassa_enc_cloud_manifest_version', '3');
        localStorage.setItem(
            'thalassa_enc_cloud_manifest_signature',
            JSON.stringify({ version: 3, cells: [{ cellId: 'US5XX01M', bbox: US_BBOX }] }),
        );
        const env = await load();

        await expect(env.cloud.registerCloudCells()).resolves.toBe(0);

        expect(env.meta.getRegisteredCell('US5XX01M')).toBeNull();
    });
});

describe('what the skipper is told when a passage lacks charts', () => {
    // A gap the cloud cannot fill is now a gap only the boat's Pi can fill.
    // No message may send the skipper to the cloud, sign-in or the account
    // for licensed charts.
    const read = (path: string) => readFileSync(path, 'utf8');

    it.each(['services/autoroutingThalassa.ts', 'components/map/useAutoRouteLeg.ts'])(
        '%s points at the Pi, not the chart cloud',
        (path) => {
            const source = read(path);
            expect(source).not.toMatch(/chart cloud isn't reachable|licensed-access|\(the charts are licensed\)/);
            expect(source).toMatch(/Licensed charts come only from your boat's Pi/);
        },
    );

    it('the /plan sign-in wall no longer says charts live on the account', () => {
        const source = read('components/BuilderDeepLink.tsx');
        expect(source).not.toMatch(/your charts/i);
        expect(source).toMatch(/your tides and saved routes live on your account/);
    });
});
