import { satelliteModeActive } from '../networkPolicy';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { catalogueCacheEpoch, readCatalogueCache, writeCatalogueCache } from './cache';
import {
    CATALOGUE_BASE,
    SHARD_MAX_BYTES,
    cataloguePath,
    nearbyAreaKeys,
    normaliseName,
    namePrefix,
    nameSearchKeys,
    areaSearchKeys,
    parseManifest,
    parseShard,
    type CatalogueDataset,
    type CatalogueManifest,
    type MarinePlace,
} from './schema';

export interface CatalogueResult {
    records: MarinePlace[];
    manifests: CatalogueManifest[];
    cachedOnly: boolean;
    partial: boolean;
    offlineComplete?: boolean;
    noaaConsentRequired?: boolean;
}
const offline = () => satelliteModeActive() || (typeof navigator !== 'undefined' && navigator.onLine === false);
const ttl = 12 * 3600000;
let active = 0;
const waiting: (() => void)[] = [];
async function boundedFetch(path: string, signal?: AbortSignal): Promise<string | null> {
    if (!cataloguePath(path)) throw new Error('Invalid catalogue path');
    if (waiting.length >= 16) throw new Error('Catalogue request queue is full');
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
        signal?.throwIfAborted();
        if (offline()) throw new Error('Catalogue downloads paused offline or in Satellite Mode');
        const response = await fetch(`${CATALOGUE_BASE}/${path}`, {
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
        });
        if (response.status === 404) return null;
        if (
            !response.ok ||
            !/^application\/(?:geo\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
            Number(response.headers.get('content-length')) > SHARD_MAX_BYTES
        )
            throw new Error('Catalogue unavailable');
        if (!response.body) throw new Error('Empty catalogue response');
        const reader = response.body.getReader(),
            chunks: Uint8Array[] = [];
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > SHARD_MAX_BYTES) throw new Error('Catalogue shard exceeds limit');
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        signal?.throwIfAborted();
        if (offline()) throw new Error('Catalogue download paused');
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } finally {
        active--;
        waiting.shift()?.();
    }
}
async function read<T>(
    path: string,
    parse: (v: unknown) => T,
    signal?: AbortSignal,
    cacheOnly = false,
): Promise<T | null> {
    signal?.throwIfAborted();
    const epoch = catalogueCacheEpoch(),
        saved = await readCatalogueCache(path);
    signal?.throwIfAborted();
    let previous: T | null = null;
    if (saved) {
        try {
            previous = parse(JSON.parse(saved.text));
        } catch {
            /* Corrupt/stale schema is never consumed. */
        }
    }
    const immutable = !path.endsWith('/manifest.json');
    if (previous && (immutable || Date.now() - saved!.at < ttl || cacheOnly || offline())) return previous;
    if (cacheOnly || offline()) return previous;
    try {
        const text = await boundedFetch(path, signal);
        signal?.throwIfAborted();
        if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
        if (text === null) return null;
        const result = parse(JSON.parse(text));
        // Optional offline storage must not convert a successful online read to missing data.
        await writeCatalogueCache(path, text, epoch).catch(() => undefined);
        signal?.throwIfAborted();
        if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
        return result;
    } catch (error) {
        signal?.throwIfAborted();
        if (epoch !== catalogueCacheEpoch()) throw error;
        if (previous) return previous;
        throw error;
    }
}
async function manifest(dataset: CatalogueDataset, signal?: AbortSignal, cacheOnly = false) {
    return read(`${dataset}/manifest.json`, (v) => parseManifest(v, dataset), signal, cacheOnly);
}
async function shard(m: CatalogueManifest, key: string, signal?: AbortSignal, cacheOnly = false) {
    if (!m.shards.includes(key)) return []; // Inventory proves this generation has no records in this cell/prefix.
    return read(`${m.dataset}/${m.generation}/${key}.json`, (v) => parseShard(v, m, key), signal, cacheOnly);
}
export async function searchMarinePlaces(
    query: string,
    near?: { lat: number; lon: number },
    signal?: AbortSignal,
): Promise<CatalogueResult> {
    const epoch = catalogueCacheEpoch();
    const prefix = namePrefix(query);
    if (!prefix || query.length > 100) return { records: [], manifests: [], partial: false, cachedOnly: offline() };
    const m = await manifest('places', signal);
    if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
    if (!m) throw new Error('Worldwide marine names have not been published here yet');
    const keys = nameSearchKeys(m, query);
    if (keys.length > 4) throw new Error('Many marine places match these letters. Type a longer name.');
    const records = new Map<string, MarinePlace>();
    let missing = false;
    for (const key of keys) {
        const part = await shard(m, key, signal);
        if (part === null) missing = true;
        for (const point of part ?? []) records.set(point.id, point);
    }
    if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
    const text = normaliseName(query);
    const distance = (p: MarinePlace) =>
        near
            ? Math.acos(
                  Math.min(
                      1,
                      Math.max(
                          -1,
                          Math.sin((near.lat * Math.PI) / 180) * Math.sin((p.lat * Math.PI) / 180) +
                              Math.cos((near.lat * Math.PI) / 180) *
                                  Math.cos((p.lat * Math.PI) / 180) *
                                  Math.cos(((p.lon - near.lon) * Math.PI) / 180),
                      ),
                  ),
              )
            : 0;
    return {
        records: [...records.values()]
            .filter((p) => [p.name, ...p.aliases].some((s) => normaliseName(s).startsWith(text)))
            .sort((a, b) => distance(a) - distance(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
            .slice(0, 30),
        manifests: [m],
        cachedOnly: offline(),
        partial: missing,
    };
}
/** Requests public 2-degree cells only, at most16 cells/source. Nothing runs at phone boot. */
export async function loadMarineArea(
    lat: number,
    lon: number,
    datasets: readonly CatalogueDataset[] = ['places', 'osm', 'noaa'],
    signal?: AbortSignal,
    cacheOnly = false,
): Promise<CatalogueResult> {
    return loadMarineCells(nearbyAreaKeys(lat, lon), datasets, signal, cacheOnly, { lat, lon });
}
export async function loadMarineCells(
    keys: readonly string[],
    datasets: readonly CatalogueDataset[],
    signal?: AbortSignal,
    cacheOnly = false,
    near?: { lat: number; lon: number },
): Promise<CatalogueResult> {
    if (keys.length > 16 || !keys.every((key) => /^(?:[0-8]?\d)_(?:1[0-7]\d|[0-9]?\d)$/.test(key)))
        throw new Error('Invalid catalogue area');
    const records = new Map<string, MarinePlace>(),
        manifests: CatalogueManifest[] = [];
    const requiredPaths: string[] = [];
    const epoch = catalogueCacheEpoch();
    let partial = false;
    const scope = getAuthIdentityScope();
    let offlineComplete = true;
    let noaaConsentRequired = false;
    for (const dataset of [...new Set(datasets)].slice(0, 3)) {
        signal?.throwIfAborted();
        if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Catalogue account changed');
        if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
        try {
            let agreementHash: string | undefined;
            if (dataset === 'noaa') {
                const { noaaAgreementAccepted, NOAA_AGREEMENT_SHA256 } = await import('../enc/noaaAgreement');
                if (!(await noaaAgreementAccepted())) {
                    partial = true;
                    offlineComplete = false;
                    noaaConsentRequired = true;
                    continue;
                }
                agreementHash = NOAA_AGREEMENT_SHA256;
            }
            const m = await manifest(dataset, signal, cacheOnly);
            if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
            if (!m) {
                partial = true;
                offlineComplete = false;
                continue;
            }
            if (dataset === 'noaa' && m.agreementSha256 !== agreementHash)
                throw new Error('NOAA agreement version differs; update the app before using this catalogue');
            manifests.push(m);
            const leaves = areaSearchKeys(m, keys, near);
            if (leaves.length > 16) partial = true;
            const selected = leaves.slice(0, 16);
            requiredPaths.push(
                `${dataset}/manifest.json`,
                ...selected.map((key) => `${dataset}/${m.generation}/${key}.json`),
            );
            // Sequential cells avoid a large pending queue; the shared gate permits two sheets only.
            for (const key of selected) {
                if (records.size >= 10000) {
                    partial = true;
                    break;
                }
                const points = await shard(m, key, signal, cacheOnly);
                if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Catalogue account changed');
                if (points === null) partial = true;
                for (const p of points ?? []) {
                    if (records.size >= 10000) {
                        partial = true;
                        break;
                    }
                    records.set(p.id, p);
                }
            }
        } catch {
            signal?.throwIfAborted();
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Catalogue account changed');
            if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
            partial = true;
            offlineComplete = false;
        }
    }
    for (const path of requiredPaths) if (!(await readCatalogueCache(path))) offlineComplete = false;
    signal?.throwIfAborted();
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Catalogue account changed');
    if (epoch !== catalogueCacheEpoch()) throw new Error('Catalogue operation cancelled by deletion');
    return {
        records: [...records.values()],
        manifests,
        partial,
        cachedOnly: cacheOnly || offline(),
        offlineComplete: offlineComplete && !partial,
        noaaConsentRequired,
    };
}
