import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    areaKey,
    cataloguePath,
    LICENCES,
    namePrefix,
    nearbyAreaKeys,
    parseManifest,
    parseShard,
    type CatalogueDataset,
    type MarinePlace,
} from '../services/marineCatalogue/schema';

const h = vi.hoisted(() => ({
    satellite: false,
    noaaAccepted: false,
    files: new Map<string, string>(),
    write: vi.fn(),
    fetch: vi.fn(),
}));
vi.mock('../services/enc/noaaAgreement', () => ({
    noaaAgreementAccepted: async () => h.noaaAccepted,
    NOAA_AGREEMENT_SHA256: '175f625ba0ae7b8656bf41010d6e5226b70f66a5a5c00ceff450c2eba2411c24',
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        stat: async ({ path }: { path: string }) => {
            if (!h.files.has(path)) throw new Error('Missing');
            return { size: new TextEncoder().encode(h.files.get(path)).length };
        },
        readFile: async ({ path }: { path: string }) => ({ data: h.files.get(path) }),
        writeFile: async ({ path, data }: { path: string; data: string }) => {
            await h.write();
            h.files.set(path, data);
        },
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => h.satellite }));
const manifest = (dataset: CatalogueDataset = 'places') => ({
    schema: 1 as const,
    dataset,
    generation: '202610-fixture',
    builtAt: new Date().toISOString(),
    sourceAt: new Date().toISOString(),
    count: 2,
    shards: ['names/63-6f-72', 'areas/36_179'],
    ...(dataset === 'noaa'
        ? { agreementSha256: '175f625ba0ae7b8656bf41010d6e5226b70f66a5a5c00ceff450c2eba2411c24' }
        : {}),
    coverage: 'Generated fixture only',
    licence: LICENCES[dataset].url,
    sourceUrl:
        dataset === 'places'
            ? 'https://download.geonames.org/export/dump/allCountries.zip'
            : dataset === 'osm'
              ? 'https://download.geofabrik.de/australia-oceania.html'
              : 'https://www.charts.noaa.gov/ENCs/ENCs.shtml',
});
const place = (id = 'geonames:1', lon = 179.5): MarinePlace => ({
    id,
    name: 'Coral Bay',
    kind: 'bay',
    lat: -17,
    lon,
    country: 'FJ',
    aliases: [],
    approximate: true,
});
const shard = (key: string, records = [place()], dataset: CatalogueDataset = 'places') => ({
    schema: 1,
    dataset,
    generation: '202610-fixture',
    key,
    records,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
    vi.resetModules();
    h.satellite = false;
    h.noaaAccepted = false;
    h.files.clear();
    h.fetch.mockReset();
    h.write.mockReset();
    vi.stubGlobal('fetch', h.fetch);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('public catalogue geometry, provenance and identity boundary', () => {
    it('handles Unicode and the date line without Greenwich area requests', () => {
        expect(namePrefix('Île du thé')).toBe('69-6c-65');
        expect(areaKey(0, 180)).toBe(areaKey(0, -180));
        const keys = nearbyAreaKeys(-17, 179.9);
        expect(keys.some((k) => k.endsWith('_0'))).toBe(true);
        expect(keys.some((k) => k.endsWith('_179'))).toBe(true);
        expect(keys.some((k) => k.endsWith('_90'))).toBe(false);
        expect(() => nearbyAreaKeys(90, 0)).toThrow('polar');
    });
    it('refuses traversal, outside host paths and unrecognised record payloads', () => {
        expect(cataloguePath('places/../../charts.json')).toBe(false);
        expect(cataloguePath('places/202610-fixture/areas/90_0.json')).toBe(false);
        expect(() =>
            parseManifest({ ...manifest(), sourceUrl: 'https://download.geonames.org.evil.test/' }, 'places'),
        ).toThrow();
        expect(() =>
            parseShard(
                shard('areas/36_179', [{ ...place(), chartMesh: [] } as MarinePlace]),
                manifest(),
                'areas/36_179',
            ),
        ).toThrow();
        expect(() => parseShard(shard('areas/36_179'), manifest(), 'areas/0_0')).toThrow();
        expect(() => parseShard(shard('areas/36_179', [place(), place()]), manifest(), 'areas/36_179')).toThrow();
    });
    it('does not merge nearby distinct moorings or invent shelter/permission', async () => {
        const { catalogueMoorings, catalogueAnchorages } = await import('../services/marineCatalogue/adapters');
        const a = { ...place('osm-node1'), kind: 'mooring' as const },
            b = { ...a, id: 'osm-node2', lon: a.lon + 0.00001 };
        expect(catalogueMoorings([a, b], manifest('osm'))).toHaveLength(2);
        expect(catalogueMoorings([a], manifest('osm'))[0]).toMatchObject({
            access: 'Unknown — check permission',
            fetchLandNM: undefined,
        });
        expect(catalogueAnchorages([{ ...a, kind: 'anchorage' }], [manifest('osm')])[0].properties.notes).toContain(
            'Less data here',
        );
    });
});
describe('bounded app-owned queries and persistent offline cache', () => {
    it('refines dense global name prefixes without downloading every matching world shard', async () => {
        const m = {
            ...manifest(),
            shards: ['a', 'b', 'c', 'd', 'e'].map((c) => `names/63-6f-72-${c.codePointAt(0)!.toString(16)}`),
        };
        h.fetch.mockResolvedValue(json(m));
        const service = await import('../services/marineCatalogue/service');
        await expect(service.searchMarinePlaces('Cor')).rejects.toThrow('longer name');
        expect(h.fetch).toHaveBeenCalledTimes(1);
        h.fetch.mockResolvedValue(json(shard('names/63-6f-72-61')));
        expect((await service.searchMarinePlaces('Coral')).records).toHaveLength(1);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });
    it('the persisted pack stays within quota including JSON escaping and evicts oldest downloads', async () => {
        const cache = await import('../services/marineCatalogue/cache');
        const text = '"'.repeat(512 * 1024),
            epoch = cache.catalogueCacheEpoch();
        for (let i = 0; i < 26; i++)
            await cache.writeCatalogueCache(`places/202610-fixture/areas/1_${i}.json`, text, epoch);
        const stats = await cache.catalogueCacheStats();
        expect(stats.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
        expect(stats.entries).toBeLessThan(26);
        expect(await cache.readCatalogueCache('places/202610-fixture/areas/1_0.json')).toBeNull();
        expect(await cache.readCatalogueCache('places/202610-fixture/areas/1_25.json')).not.toBeNull();
    });
    it('withholds NOAA-derived fetches until the exact agreement is accepted, including cached reads', async () => {
        const service = await import('../services/marineCatalogue/service');
        const blocked = await service.loadMarineCells(['36_179'], ['noaa']);
        expect(blocked).toMatchObject({ records: [], noaaConsentRequired: true, partial: true });
        expect(h.fetch).not.toHaveBeenCalled();
        h.noaaAccepted = true;
        h.fetch.mockImplementation(async (url: string) =>
            url.endsWith('manifest.json')
                ? json(manifest('noaa'))
                : json(shard('areas/36_179', [{ ...place('noaa:0226000000001234'), kind: 'anchorage' }], 'noaa')),
        );
        expect((await service.loadMarineCells(['36_179'], ['noaa'])).records).toHaveLength(1);
        h.noaaAccepted = false;
        h.fetch.mockClear();
        expect((await service.loadMarineCells(['36_179'], ['noaa'], undefined, true)).records).toEqual([]);
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('withholds a new NOAA agreement version even when the previous version was accepted', async () => {
        h.noaaAccepted = true;
        h.fetch.mockResolvedValue(json({ ...manifest('noaa'), agreementSha256: 'a'.repeat(64) }));
        const service = await import('../services/marineCatalogue/service');
        expect(await service.loadMarineCells(['36_179'], ['noaa'])).toMatchObject({
            records: [],
            partial: true,
            offlineComplete: false,
        });
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    it('inventory proves an empty cell without a fetch and a missing listed shard remains incomplete', async () => {
        h.fetch.mockResolvedValue(json(manifest()));
        const service = await import('../services/marineCatalogue/service');
        expect(await service.loadMarineCells(['1_1'], ['places'])).toMatchObject({
            records: [],
            partial: false,
            offlineComplete: true,
        });
        expect(h.fetch).toHaveBeenCalledTimes(1);
        h.fetch.mockResolvedValue(new Response('', { status: 404 }));
        const missing = await service.loadMarineCells(['36_179'], ['places']);
        expect(missing.offlineComplete).toBe(false);
    });
    it('searches one public prefix and ranks ambiguous names by local distance', async () => {
        h.fetch.mockImplementation(async (url: string) =>
            url.endsWith('manifest.json')
                ? json(manifest())
                : json(shard('names/63-6f-72', [place('geonames:1', -70), place('geonames:2', 179.5)])),
        );
        const { searchMarinePlaces } = await import('../services/marineCatalogue/service');
        const found = await searchMarinePlaces('Coral', { lat: -17, lon: 179.4 });
        expect(found.records.map((p) => p.id)).toEqual(['geonames:2', 'geonames:1']);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.fetch.mock.calls[1][0]).toMatch(/\/places\/202610-fixture\/names\/63-6f-72\.json$/);
        expect(h.fetch.mock.calls.every(([url]) => !String(url).includes('179.4'))).toBe(true);
        expect(h.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    });
    it('restores the actual native pack across a cold process and makes no Satellite WAN request', async () => {
        h.fetch.mockImplementation(async (url: string) =>
            url.endsWith('manifest.json') ? json(manifest()) : json(shard('names/63-6f-72')),
        );
        await (await import('../services/marineCatalogue/service')).searchMarinePlaces('Coral');
        expect(h.files.size).toBe(1);
        vi.resetModules();
        h.fetch.mockClear();
        h.satellite = true;
        const found = await (await import('../services/marineCatalogue/service')).searchMarinePlaces('Coral');
        expect(found.records[0].name).toBe('Coral Bay');
        expect(found.cachedOnly).toBe(true);
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('cold cache-only endpoint lookup never starts a provider request', async () => {
        const result = await (
            await import('../services/marineCatalogue/service')
        ).loadMarineArea(-17, 179.5, ['places'], undefined, true);
        expect(result).toMatchObject({ records: [], partial: true, cachedOnly: true });
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('rejects oversize/wrong MIME and records genuinely unpublished coverage', async () => {
        h.fetch.mockResolvedValue(new Response('not-json', { headers: { 'content-type': 'text/html' } }));
        const service = await import('../services/marineCatalogue/service');
        await expect(service.searchMarinePlaces('Coral')).rejects.toThrow();
        expect(h.files.size).toBe(0);
        h.fetch.mockResolvedValue(new Response('', { status: 404 }));
        await expect(service.searchMarinePlaces('Coral')).rejects.toThrow('not been published');
        h.fetch.mockResolvedValue(
            new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
        );
        await expect(service.searchMarinePlaces('Coral')).rejects.toThrow('exceeds');
        expect(h.files.size).toBe(0);
    });
    it('aborted queued requests never reach WAN and deletion fences late completed downloads', async () => {
        let resolve!: (response: Response) => void;
        h.fetch.mockImplementation(
            () =>
                new Promise<Response>((r) => {
                    resolve = r;
                }),
        );
        const service = await import('../services/marineCatalogue/service'),
            cache = await import('../services/marineCatalogue/cache');
        const task = service.searchMarinePlaces('Coral');
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
        await cache.clearCatalogueCache();
        const cancelled = expect(task).rejects.toThrow('deletion');
        resolve(json(manifest()));
        await cancelled;
        expect((await cache.catalogueCacheStats()).entries).toBe(0);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        await cache.clearCatalogueCache();
        const aborted = new AbortController();
        aborted.abort();
        await expect(service.searchMarinePlaces('Coral', undefined, aborted.signal)).rejects.toThrow();
    });
});
