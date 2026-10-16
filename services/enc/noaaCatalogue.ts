import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { satelliteModeBlocks } from '../networkPolicy';
import { noaaAgreementAccepted } from './noaaAgreement';
import {
    noaaBounds,
    noaaIntersects,
    parseNoaaIndex,
    parseNoaaShard,
    type NoaaBounds,
    type NoaaCatalogueCell,
    type NoaaCatalogueIndex,
    type NoaaObject,
} from './noaaCatalogueContract';

const ORIGIN = 'https://tiles.thalassatiles.com/noaa-enc/v1/';
const WEEK = 7 * 86400_000;
const CACHE_KEY = 'thalassa_noaa_catalogue_v1';
const DOWNLOAD_KEY = 'thalassa_noaa_originals_v1';
const CACHE_CAP = 4 * 1024 * 1024;
const ARCHIVE_CAP = 128 * 1024 * 1024;
export interface NoaaDownload {
    id: string;
    edition: number;
    update: number;
    chartSha256: string;
    zipSha256: string;
    bytes: number;
    path: string;
    savedAt: number;
    installed: boolean;
    withdrawn: boolean;
}
interface Cache {
    index: NoaaCatalogueIndex | null;
    fetchedAt: number;
    shards: Array<{ key: string; body: string }>;
}
export interface NoaaAreaCatalogue {
    index: NoaaCatalogueIndex;
    cells: NoaaCatalogueCell[];
    saved: boolean;
    checkedAt: number;
}
function current(scope: AuthIdentityScope): void {
    if (!isAuthIdentityScopeCurrent(scope)) throw Error('Account changed. Reopen NOAA charts.');
}
async function authority(scope: AuthIdentityScope): Promise<void> {
    current(scope);
    if (!(await noaaAgreementAccepted(scope))) throw Error('Read and accept the NOAA ENC agreement first.');
    current(scope);
}
const key = (base: string, scope: AuthIdentityScope): string => authScopedStorageKey(base, scope);
async function sha(bytes: Uint8Array): Promise<string> {
    const result = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
/** Streaming bound is enforced even when Content-Length is absent or false. */
export async function readNoaaBytes(response: Response, maximum: number): Promise<Uint8Array> {
    const header = response.headers.get('content-length');
    if (!response.ok || !response.body || (header && (!/^\d+$/.test(header) || Number(header) > maximum)))
        throw Error('NOAA chart download unavailable.');
    const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > maximum) throw Error('NOAA download exceeds the phone limit.');
            chunks.push(part.value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
async function fetchBytes(
    path: string,
    maximum: number,
    scope: AuthIdentityScope,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    current(scope);
    if (satelliteModeBlocks('offline-download'))
        throw Error('Satellite Mode: NOAA catalogue and chart downloads wait for normal network.');
    if (
        !/^(?:index\.json|generations\/[a-f0-9]{24}\/shards\/x\d{2}y\d{2}\.json|objects\/[a-f0-9]{64}\.(?:json|zip))$/.test(
            path,
        )
    )
        throw Error('Invalid NOAA object path.');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 30_000);
    try {
        if (signal?.aborted) controller.abort();
        const response = await fetch(ORIGIN + path, {
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
        });
        const bytes = await readNoaaBytes(response, maximum);
        current(scope);
        return bytes;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}
const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
async function verifiedObject(object: NoaaObject, scope: AuthIdentityScope, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = await fetchBytes(object.key, object.bytes, scope, signal);
    if (bytes.byteLength !== object.bytes || (await sha(bytes)) !== object.sha256)
        throw Error('NOAA download checksum changed.');
    current(scope);
    return bytes;
}
async function cache(scope: AuthIdentityScope): Promise<Cache> {
    const empty = { index: null, fetchedAt: 0, shards: [] };
    const { value } = await Preferences.get({ key: key(CACHE_KEY, scope) });
    current(scope);
    if (!value || value.length > CACHE_CAP) return empty;
    try {
        const r = JSON.parse(value) as Cache;
        if (
            !Number.isFinite(r.fetchedAt) ||
            r.fetchedAt <= 0 ||
            r.fetchedAt > Date.now() + 300_000 ||
            !Array.isArray(r.shards) ||
            r.shards.length > 8
        )
            return empty;
        const index = parseNoaaIndex(r.index);
        for (const shard of r.shards) {
            const entry = index.shards.find((row) => row.key === shard.key);
            if (!entry || typeof shard.body !== 'string') return empty;
            const bytes = new TextEncoder().encode(shard.body);
            if (bytes.length !== entry.bytes || (await sha(bytes)) !== entry.sha256) return empty;
            parseNoaaShard(JSON.parse(shard.body), index);
        }
        current(scope);
        return { index, fetchedAt: r.fetchedAt, shards: r.shards };
    } catch {
        return empty;
    }
}
async function saveCache(value: Cache, scope: AuthIdentityScope): Promise<void> {
    current(scope);
    let body = JSON.stringify(value);
    while (new TextEncoder().encode(body).length > CACHE_CAP && value.shards.length) {
        value.shards.shift();
        body = JSON.stringify(value);
    }
    await Preferences.set({ key: key(CACHE_KEY, scope), value: body });
    current(scope);
}
export async function savedNoaaDownloads(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<NoaaDownload[]> {
    const { value } = await Preferences.get({ key: key(DOWNLOAD_KEY, scope) });
    current(scope);
    if (!value || value.length > 32 * 1024) return [];
    try {
        const rows: unknown = JSON.parse(value);
        if (!Array.isArray(rows) || rows.length > 32) return [];
        const prefix = await archivePrefix(scope);
        if (
            rows.some(
                (r) =>
                    !r ||
                    typeof r !== 'object' ||
                    !/^US[1-6][A-Z0-9]{5}$/.test(r.id) ||
                    !Number.isInteger(r.edition) ||
                    r.edition < 1 ||
                    r.edition > 9999 ||
                    !Number.isInteger(r.update) ||
                    r.update < 0 ||
                    r.update > 9999 ||
                    !/^[a-f0-9]{64}$/.test(r.chartSha256) ||
                    !/^[a-f0-9]{64}$/.test(r.zipSha256) ||
                    !Number.isInteger(r.bytes) ||
                    r.bytes < 1 ||
                    r.bytes > 32 * 1024 * 1024 ||
                    r.path !== `${prefix}/${r.zipSha256}.zip` ||
                    typeof r.savedAt !== 'number' ||
                    !Number.isFinite(r.savedAt) ||
                    r.savedAt <= 0 ||
                    r.savedAt > Date.now() + 300_000 ||
                    typeof r.installed !== 'boolean' ||
                    typeof r.withdrawn !== 'boolean',
            ) ||
            rows.reduce((n, row) => n + row.bytes, 0) > ARCHIVE_CAP ||
            new Set(rows.map((r) => r.zipSha256)).size !== rows.length
        )
            return [];
        current(scope);
        return rows as NoaaDownload[];
    } catch {
        return [];
    }
}
async function saveDownloads(rows: NoaaDownload[], scope: AuthIdentityScope): Promise<void> {
    current(scope);
    await Preferences.set({ key: key(DOWNLOAD_KEY, scope), value: JSON.stringify(rows) });
    current(scope);
}
async function archivePrefix(scope: AuthIdentityScope): Promise<string> {
    const account = (await sha(new TextEncoder().encode(scope.key))).slice(0, 32);
    current(scope);
    return `${Capacitor.isNativePlatform() ? 'Application Support/' : ''}noaa-originals/${account}`;
}
const directory = (): Directory => (Capacitor.isNativePlatform() ? Directory.Library : Directory.Data);
function base64(bytes: Uint8Array): string {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 16384)
        binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
    return btoa(binary);
}
let mutations: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutations.then(operation, operation);
    mutations = next.catch(() => undefined);
    return next;
}
async function withdrawals(index: NoaaCatalogueIndex, scope: AuthIdentityScope): Promise<void> {
    await serialized(async () => {
        current(scope);
        const rows = await savedNoaaDownloads(scope);
        if (!rows.some((row) => index.withdrawn.includes(row.id) && !row.withdrawn)) return;
        const { removeNoaaCatalogueRevision } = await import('./EncHazardService');
        for (const row of rows) {
            if (!index.withdrawn.includes(row.id) || row.withdrawn) continue;
            current(scope);
            if (row.installed)
                await removeNoaaCatalogueRevision(
                    row.id,
                    { edition: row.edition, updateNumber: row.update, contentSha256: row.chartSha256 },
                    () => current(scope),
                );
            row.withdrawn = true;
            row.installed = false;
        }
        await saveDownloads(rows, scope);
    });
}
async function refreshIndex(saved: Cache, scope: AuthIdentityScope, signal?: AbortSignal): Promise<Cache> {
    const bytes = await fetchBytes('index.json', 256 * 1024, scope, signal);
    const index = parseNoaaIndex(JSON.parse(decode(bytes)));
    if (
        Date.now() - Date.parse(index.checkedAt) > WEEK + 86400_000 ||
        (saved.index && Date.parse(index.sourceAt) < Date.parse(saved.index.sourceAt))
    )
        throw Error('NOAA publisher edition check is stale. Saved charts remain available; try again later.');
    current(scope);
    const next = {
        index,
        fetchedAt: Date.now(),
        shards: saved.index?.generation === index.generation ? saved.shards : [],
    };
    await withdrawals(index, scope);
    await saveCache(next, scope);
    return next;
}
/** Only static root metadata, at most once per seven days. Camera/boat
 * positions never leave the device. No chart or archive is auto-downloaded. */
export async function checkNoaaCatalogueWeekly(): Promise<void> {
    const scope = getAuthIdentityScope();
    try {
        if (satelliteModeBlocks('offline-download') || !(await noaaAgreementAccepted(scope))) return;
        if (!(await savedNoaaDownloads(scope)).length) return;
        const saved = await cache(scope);
        if (Date.now() - saved.fetchedAt >= WEEK) await refreshIndex(saved, scope);
    } catch {
        /* Saved edition/date stays visible; failed checks never stamp fresh. */
    }
}
export async function loadNoaaArea(
    bounds: NoaaBounds,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<NoaaAreaCatalogue> {
    const scope = getAuthIdentityScope();
    await authority(scope);
    if (!noaaBounds(bounds)) throw Error('Move the chart to a valid area.');
    let saved = await cache(scope),
        offline = satelliteModeBlocks('offline-download');
    if (!offline && (options.refresh || !saved.index || Date.now() - saved.fetchedAt >= WEEK)) {
        try {
            saved = await refreshIndex(saved, scope, options.signal);
        } catch (error) {
            if (options.refresh || !saved.index) throw error;
            offline = true;
        }
    }
    if (!saved.index) throw Error('No saved NOAA catalogue. Connect on normal network to check editions.');
    const index = saved.index;
    const selected = index.shards.filter((row) => noaaIntersects(row.bbox, bounds));
    if (selected.length > 8) throw Error('Zoom in to a smaller NOAA chart area.');
    const cells = new Map<string, NoaaCatalogueCell>();
    for (const entry of selected) {
        let text = saved.shards.find((row) => row.key === entry.key)?.body;
        if (!text) {
            if (offline) throw Error('This NOAA area is not saved. Download its catalogue on normal network.');
            text = decode(await verifiedObject(entry, scope, options.signal));
            saved.shards.push({ key: entry.key, body: text });
            if (saved.shards.length > 8) saved.shards.shift();
        }
        for (const row of parseNoaaShard(JSON.parse(text), index))
            if (noaaIntersects(row.bbox, bounds)) cells.set(row.id, row);
        if (cells.size > 512) throw Error('Zoom in to fewer than512 NOAA cells.');
    }
    await saveCache(saved, scope);
    return {
        index,
        cells: [...cells.values()].sort((a, b) => a.scale - b.scale || a.id.localeCompare(b.id)),
        saved: offline,
        checkedAt: saved.fetchedAt,
    };
}
export function installNoaaCell(cell: NoaaCatalogueCell, signal?: AbortSignal): Promise<void> {
    const scope = getAuthIdentityScope();
    return serialized(async () => {
        await authority(scope);
        // Revalidate caller against the current signed-by-hash regional row,
        // never an arbitrary URL/object passed from UI or stale search results.
        const saved = await cache(scope);
        if (
            !saved.index ||
            Date.now() - saved.fetchedAt > WEEK ||
            Date.now() - Date.parse(saved.index.checkedAt) > WEEK + 86400_000 ||
            saved.index.withdrawn.includes(cell.id)
        )
            throw Error('Check current NOAA editions before downloading.');
        const trusted = saved.shards
            .flatMap((s) => parseNoaaShard(JSON.parse(s.body), saved.index!))
            .find((row) => row.id === cell.id);
        if (!trusted || JSON.stringify(trusted) !== JSON.stringify(cell) || !cell.chart || !cell.zip)
            throw Error('This chart conversion is not available in the current catalogue.');
        const rows = await savedNoaaDownloads(scope);
        const held = rows.find((row) => row.zipSha256 === cell.zip!.sha256);
        if (!held && (rows.length >= 32 || rows.reduce((n, row) => n + row.bytes, 0) + cell.zip.bytes > ARCHIVE_CAP))
            throw Error('Saved NOAA originals are full (32 archives /128MiB). Remove an old download first.');
        const chartBytes = await verifiedObject(cell.chart, scope, signal);
        const chart = JSON.parse(decode(chartBytes));
        if (
            chart.cellId !== cell.id ||
            chart.sourceHO !== 'US' ||
            chart.edition !== cell.edition ||
            chart.updateNumber !== cell.update ||
            chart.issued !== cell.issued
        )
            throw Error('NOAA chart identity/revision does not match its catalogue.');
        let archiveVerified = false;
        if (held) {
            try {
                const previous = await Filesystem.readFile({ path: held.path, directory: directory() });
                archiveVerified =
                    typeof previous.data === 'string' &&
                    (await sha(Uint8Array.from(atob(previous.data), (c) => c.charCodeAt(0)))) === cell.zip.sha256;
                current(scope);
            } catch {
                current(scope);
            }
        }
        if (!archiveVerified) {
            const zip = await verifiedObject(cell.zip, scope, signal);
            if (zip[0] !== 0x50 || zip[1] !== 0x4b || zip[2] !== 3 || zip[3] !== 4)
                throw Error('NOAA original is not a ZIP archive.');
            const path = `${await archivePrefix(scope)}/${cell.zip.sha256}.zip`;
            current(scope);
            if (!held) {
                // Reserve bounded storage before writing. A failed native write
                // remains a removable original-only record and cannot bypass quota.
                rows.push({
                    id: cell.id,
                    edition: cell.edition,
                    update: cell.update,
                    chartSha256: cell.chart.sha256,
                    zipSha256: cell.zip.sha256,
                    bytes: cell.zip.bytes,
                    path,
                    savedAt: Date.now(),
                    installed: false,
                    withdrawn: false,
                });
                await saveDownloads(rows, scope);
            }
            await Filesystem.writeFile({ path, directory: directory(), data: base64(zip), recursive: true });
            current(scope);
            const reread = await Filesystem.readFile({ path, directory: directory() });
            if (
                typeof reread.data !== 'string' ||
                (await sha(Uint8Array.from(atob(reread.data), (c) => c.charCodeAt(0)))) !== cell.zip.sha256
            )
                throw Error('NOAA original could not be verified on this device.');
        }
        await authority(scope);
        if (signal?.aborted) throw Error('NOAA chart download cancelled. Original archive remains saved.');
        const { importCell } = await import('./EncHazardService');
        await importCell(chart, {
            usage: 'navigation',
            contentSha256: cell.chart.sha256,
            assertAuthority: () => current(scope),
        });
        current(scope);
        const record = rows.find((row) => row.zipSha256 === cell.zip!.sha256)!;
        record.installed = true;
        await saveDownloads(rows, scope);
    });
}
export function removeNoaaDownload(record: NoaaDownload): Promise<void> {
    const scope = getAuthIdentityScope();
    return serialized(async () => {
        current(scope);
        const rows = await savedNoaaDownloads(scope),
            held = rows.find((row) => row.zipSha256 === record.zipSha256);
        if (!held) return;
        const { removeNoaaCatalogueRevision } = await import('./EncHazardService');
        await removeNoaaCatalogueRevision(
            held.id,
            { edition: held.edition, updateNumber: held.update, contentSha256: held.chartSha256 },
            () => current(scope),
        );
        current(scope);
        try {
            await Filesystem.deleteFile({ path: held.path, directory: directory() });
        } catch (error) {
            // A reserved original-only record may correspond to a write that
            // never completed. Confirm absence; other I/O failures keep quota.
            const exists = await Filesystem.stat({ path: held.path, directory: directory() }).then(
                () => true,
                () => false,
            );
            if (exists) throw error;
        }
        await saveDownloads(
            rows.filter((row) => row !== held),
            scope,
        );
    });
}
