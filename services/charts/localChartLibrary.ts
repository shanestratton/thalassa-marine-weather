import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import {
    addLocalChart,
    localChartKind,
    localChartPath,
    readLocalChartManifest,
    LOCAL_CHART_LIBRARY_BYTES,
    LOCAL_CHART_LIBRARY_COUNT,
    LOCAL_CHART_MANIFEST_BYTES,
    type LocalChartManifest,
    type LocalChartRecord,
    type LocalChartRights,
} from './localChartLibraryContract';
import { assertLocalChartSqliteBytes, LOCAL_CHART_FILE_BYTES } from './localChartLimits';
import { waitForLocalChart } from './localChartWait';
import { encodeLocalChartBase64, decodeLocalChartBase64, localChartBase64Length } from './localChartWebEncoding';

const Native = registerPlugin<{
    copyChart(options: { url: string; ownerNamespace: string; rights: LocalChartRights }): Promise<{
        path: string;
        size: number;
        name?: string;
    }>;
    pickChart(options: { ownerNamespace: string; rights: LocalChartRights }): Promise<{
        path: string;
        size: number;
        name: string;
    }>;
}>('GribDocument');
export interface LocalChartOperation {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}
interface Context {
    scope: AuthIdentityScope;
    namespace: string;
    check(): void;
}
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const revisions = new Map<string, number>();
const revisionKey = (scope: AuthIdentityScope, id: string) => `${scope.key}/${id}`;
const notify = () => {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            /* A view cannot prevent another owner fence. */
        }
    }
};
subscribeAuthIdentityScope(notify);
export const subscribeLocalChartLibrary = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
const hash = async (bytes: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
const stopped = () => new Error('Local chart operation stopped.');
function capture(options: LocalChartOperation = {}) {
    const scope = getAuthIdentityScope();
    const check = () => {
        if (!isAuthIdentityScopeCurrent(scope) || options.signal?.aborted || options.isCurrent?.() === false)
            throw stopped();
    };
    check();
    return { scope, check };
}
function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
}
async function context(captured: ReturnType<typeof capture>): Promise<Context> {
    captured.check();
    const namespace = (await hash(new TextEncoder().encode(captured.scope.key))).slice(0, 32);
    captured.check();
    return { ...captured, namespace };
}
const missing = (error: unknown) =>
    error instanceof Error && /not exist|not found|ENOENT|does not exist/i.test(error.message);
const folder = (ctx: Context) => `chart-library/${ctx.namespace}`;
const indexPath = (ctx: Context) => `${folder(ctx)}/index.json`;
const json = (value: unknown) =>
    JSON.stringify(value).replace(
        /[\u0080-\uffff]/g,
        (letter) => `\\u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
async function ensureFolder(ctx: Context) {
    try {
        await Filesystem.mkdir({ path: folder(ctx), directory: Directory.Data, recursive: true });
    } catch (error) {
        ctx.check();
        const stat = await Filesystem.stat({ path: folder(ctx), directory: Directory.Data });
        ctx.check();
        if (stat.type !== 'directory') throw error;
    }
    ctx.check();
}
async function readIndex(ctx: Context): Promise<LocalChartManifest> {
    ctx.check();
    let stat;
    try {
        stat = await Filesystem.stat({ path: indexPath(ctx), directory: Directory.Data });
    } catch (error) {
        ctx.check();
        if (!missing(error)) throw error;
        return { schema: 1, ownerNamespace: ctx.namespace, charts: [] };
    }
    ctx.check();
    if (stat.type !== 'file' || stat.size < 2 || stat.size > LOCAL_CHART_MANIFEST_BYTES)
        throw new Error('Saved chart index is invalid.');
    const result = await Filesystem.readFile({
        path: indexPath(ctx),
        directory: Directory.Data,
        encoding: Encoding.UTF8,
    });
    ctx.check();
    if (typeof result.data !== 'string' || new TextEncoder().encode(result.data).length !== stat.size)
        throw new Error('Saved chart index changed.');
    return readLocalChartManifest(result.data, ctx.namespace);
}
async function writeIndex(ctx: Context, previous: LocalChartManifest, next: LocalChartManifest): Promise<void> {
    ctx.check();
    const text = json(readLocalChartManifest(json(next), ctx.namespace));
    if (text.length > LOCAL_CHART_MANIFEST_BYTES) throw new Error('Saved chart index is too large.');
    const pending = `${folder(ctx)}/index.pending`;
    await ensureFolder(ctx);
    try {
        await Filesystem.writeFile({ path: pending, directory: Directory.Data, data: text, encoding: Encoding.UTF8 });
        ctx.check();
        await Filesystem.rename({ from: pending, to: indexPath(ctx), directory: Directory.Data });
        try {
            ctx.check();
        } catch (error) {
            // The global queue prevents a new generation from reading or writing
            // this index until this exact in-flight rename has been rolled back.
            await Filesystem.writeFile({
                path: indexPath(ctx),
                directory: Directory.Data,
                data: json(previous),
                encoding: Encoding.UTF8,
            });
            throw error;
        }
    } finally {
        await Filesystem.deleteFile({ path: pending, directory: Directory.Data }).catch(() => undefined);
    }
}
async function rollbackIndex(ctx: Context, previous: LocalChartManifest): Promise<void> {
    // Rollback names only the captured owner's index and runs inside the global
    // storage queue. It cannot publish or mutate the next account's library.
    await Filesystem.writeFile({
        path: indexPath(ctx),
        directory: Directory.Data,
        data: json(previous),
        encoding: Encoding.UTF8,
    });
}
function assertRights(rights: LocalChartRights): void {
    if (rights !== 'own' && rights !== 'open') throw new Error('Choose your own chart or an openly licensed chart.');
}
function assertBytes(size: number) {
    if (!Number.isSafeInteger(size) || size < 8 || size > LOCAL_CHART_FILE_BYTES)
        throw new Error('Choose a chart no larger than 32 MiB.');
}
function contentHeader(bytes: Uint8Array, kind: LocalChartRecord['kind']) {
    if (kind === 'mbtiles') {
        assertLocalChartSqliteBytes(bytes);
    } else if (kind === 'kap') {
        if (!new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536))).includes('BSB/'))
            throw new Error('This file has no supported KAP image header. Choose the KAP image, not a BSB catalogue.');
    } else if (
        bytes.length < 8 ||
        !(
            (bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0) ||
            (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42)
        )
    ) {
        throw new Error('This file is not a supported classic GeoTIFF. BigTIFF is not supported on this phone.');
    }
}
/** An exact stat and bounded stream precede hash admission; never an unbounded arrayBuffer fallback. */
async function readBytes(path: string, size: number, ctx: Context, webEncoding?: 'base64'): Promise<Uint8Array> {
    assertBytes(size);
    const deadline = performance.now() + 30_000;
    ctx.check();
    const stat = await Filesystem.stat({ path, directory: Directory.Data });
    ctx.check();
    if (stat.type !== 'file' || stat.size !== (webEncoding ? localChartBase64Length(size) : size))
        throw new Error('The saved chart is missing or changed.');
    if (!Capacitor.isNativePlatform()) {
        // Capacitor's web adapter stores Blobs in IndexedDB; its getUri path is
        // not a fetchable HTTP resource. Do not base64-copy this bounded Blob.
        const result = await Filesystem.readFile({ path, directory: Directory.Data });
        ctx.check();
        if (webEncoding) {
            if (typeof result.data !== 'string') throw new Error('The saved browser chart encoding changed.');
            return decodeLocalChartBase64(result.data, size, () => {
                ctx.check();
                if (performance.now() >= deadline) throw new Error('Browser chart read timed out.');
            });
        }
        if (!(result.data instanceof Blob) || result.data.size !== size)
            throw new Error('The saved web chart is not an admitted Blob.');
        const bytes = new Uint8Array(await waitForLocalChart(result.data.arrayBuffer(), ctx.check, deadline));
        ctx.check();
        if (bytes.byteLength !== size) throw new Error('The saved chart changed while reading.');
        return bytes;
    }
    const uri = await Filesystem.getUri({ path, directory: Directory.Data });
    ctx.check();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null = null;
    try {
        const response = await waitForLocalChart(
            fetch(Capacitor.convertFileSrc(uri.uri), { signal: controller.signal }),
            ctx.check,
            deadline,
        );
        body = response.body;
        ctx.check();
        if (!response.ok || response.status !== 200 || !response.body)
            throw new Error('The saved chart cannot be read.');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size))
            throw new Error('The saved chart changed while reading.');
        reader = response.body.getReader();
        const bytes = new Uint8Array(size);
        let at = 0;
        while (true) {
            const next = await waitForLocalChart(reader.read(), ctx.check, deadline);
            ctx.check();
            if (next.done) break;
            if (at + next.value.byteLength > size) throw new Error('The saved chart exceeds its declared size.');
            bytes.set(next.value, at);
            at += next.value.byteLength;
        }
        if (at !== size) throw new Error('The saved chart is incomplete.');
        return bytes;
    } finally {
        clearTimeout(timeout);
        controller.abort();
        if (reader) {
            void reader.cancel().catch(() => undefined);
            try {
                reader.releaseLock();
            } catch {
                /* An abandoned native read may still hold its lock. */
            }
        } else if (body) void body.cancel().catch(() => undefined);
    }
}
/** Counts retained bytes on disk across owner folders without reading another owner's index or chart content. */
async function reserveDisk(ctx: Context, incoming: number): Promise<void> {
    let root;
    try {
        root = await Filesystem.readdir({ path: 'chart-library', directory: Directory.Data });
    } catch (error) {
        ctx.check();
        if (missing(error)) return;
        throw error;
    }
    ctx.check();
    if (root.files.length > 32) throw new Error('Saved chart storage needs cleanup.');
    let bytes = 0,
        count = 0,
        entries = root.files.length;
    for (const dir of root.files) {
        if (dir.type !== 'directory' || !/^[a-f0-9]{32}$/.test(dir.name))
            throw new Error('Saved chart storage contains an unexpected entry.');
        const listing = await Filesystem.readdir({ path: `chart-library/${dir.name}`, directory: Directory.Data });
        ctx.check();
        entries += listing.files.length;
        if (entries > 128) throw new Error('Saved chart storage needs cleanup.');
        for (const file of listing.files) {
            if (file.type !== 'file' || !Number.isSafeInteger(file.size) || file.size < 0)
                throw new Error('Saved chart storage cannot be measured.');
            if (['index.json', 'index.pending'].includes(file.name)) {
                if (file.size > LOCAL_CHART_MANIFEST_BYTES) throw new Error('Saved chart index is too large.');
            } else {
                count++;
                // Charge string fallback at two bytes per base64 character.
                bytes += file.size * (file.name.endsWith('.base64') ? 2 : 1);
            }
        }
    }
    if (count >= LOCAL_CHART_LIBRARY_COUNT || bytes + incoming > LOCAL_CHART_LIBRARY_BYTES)
        throw new Error('Saved charts are full (8 files or 64 MiB). Remove a saved chart first.');
}
export function listLocalCharts(options: LocalChartOperation = {}): Promise<LocalChartRecord[]> {
    const captured = capture(options);
    return serial(async () => {
        const ctx = await context(captured),
            manifest = await readIndex(ctx);
        for (const chart of manifest.charts) {
            const stat = await Filesystem.stat({
                path: localChartPath(ctx.namespace, chart),
                directory: Directory.Data,
            });
            ctx.check();
            if (
                stat.type !== 'file' ||
                stat.size !== (chart.webEncoding ? localChartBase64Length(chart.bytes) : chart.bytes)
            )
                throw new Error('A saved chart is missing or changed. Remove it before importing another copy.');
        }
        return manifest.charts;
    });
}
function validCopiedPath(path: string, ctx: Context, kind: LocalChartRecord['kind']): boolean {
    const id = path.split('/').at(-1)?.split('.')[0] ?? '';
    try {
        return localChartPath(ctx.namespace, { id, kind }) === path;
    } catch {
        return false;
    }
}
async function cleanupCopy(path: string, ctx: Context, kind: LocalChartRecord['kind']) {
    if (validCopiedPath(path, ctx, kind))
        await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
}
export function importLocalChart(
    source: File | { url: string; name: string } | 'native-picker',
    rights: LocalChartRights,
    options: LocalChartOperation = {},
): Promise<LocalChartRecord> {
    assertRights(rights);
    if (!(source instanceof File) && source !== 'native-picker') {
        const url = new URL(source.url);
        if (
            source.url.length > 8192 ||
            url.protocol !== 'file:' ||
            (url.hostname && url.hostname !== 'localhost') ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            decodeURIComponent(url.pathname.split('/').at(-1) ?? '') !== source.name
        )
            throw new Error('Choose a local chart attachment from Mail or Files.');
        localChartKind(source.name);
    }
    const captured = capture(options);
    return serial(async () => {
        const ctx = await context(captured);
        const before = await readIndex(ctx);
        if (before.charts.length >= LOCAL_CHART_LIBRARY_COUNT) throw new Error('Remove a saved chart first.');
        let path: string | undefined,
            kind: LocalChartRecord['kind'] | undefined,
            webEncoding: 'base64' | undefined,
            committed = false,
            indexAttempted = false;
        try {
            let name: string, size: number;
            if (source instanceof File) {
                name = source.name;
                kind = localChartKind(name);
                size = source.size;
                assertBytes(size);
                await reserveDisk(ctx, size);
                ctx.check();
                path = localChartPath(ctx.namespace, { id: crypto.randomUUID(), kind });
                if (Capacitor.isNativePlatform()) throw new Error('Use Choose file to import on this phone.');
                // Own the bytes rather than retaining the file-picker's external
                // File backing. WebKit cannot reliably persist that backing in
                // IndexedDB; a bounded in-memory Blob is a real private copy.
                const copy = await waitForLocalChart(source.arrayBuffer(), ctx.check, performance.now() + 30_000);
                ctx.check();
                if (copy.byteLength !== size) throw new Error('The selected chart changed while copying.');
                await ensureFolder(ctx);
                try {
                    await Filesystem.writeFile({
                        path,
                        directory: Directory.Data,
                        data: new Blob([copy], { type: 'application/octet-stream' }),
                    });
                } catch (error) {
                    ctx.check();
                    if (!(error instanceof Error) || !/preparing Blob\/File|DataCloneError/i.test(error.message))
                        throw error;
                    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
                    ctx.check();
                    await reserveDisk(ctx, 2 * localChartBase64Length(size));
                    const id = path.split('/').at(-1)!.split('.')[0];
                    webEncoding = 'base64';
                    path = localChartPath(ctx.namespace, { id, kind, webEncoding });
                    const deadline = performance.now() + 30_000;
                    const check = () => {
                        ctx.check();
                        if (performance.now() >= deadline) throw new Error('Browser chart copy timed out.');
                    };
                    await Filesystem.writeFile({
                        path,
                        directory: Directory.Data,
                        data: encodeLocalChartBase64(new Uint8Array(copy), check),
                    });
                }
                ctx.check();
            } else {
                let expired = false;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const copied = (
                    source === 'native-picker'
                        ? Native.pickChart({ ownerNamespace: ctx.namespace, rights })
                        : Native.copyChart({ url: source.url, ownerNamespace: ctx.namespace, rights })
                ).then(async (value) => {
                    const copiedKind = localChartKind(value.path.split('/').at(-1) ?? '');
                    if (!validCopiedPath(value.path, ctx, copiedKind)) throw new Error('Invalid private chart copy.');
                    try {
                        ctx.check();
                        if (expired) throw stopped();
                        if (localChartKind(source === 'native-picker' ? value.name : source.name) !== copiedKind)
                            throw new Error('The chart copy has a different format.');
                    } catch (error) {
                        await cleanupCopy(value.path, ctx, copiedKind);
                        throw error;
                    }
                    return { ...value, kind: copiedKind };
                });
                try {
                    const value = await waitForLocalChart(
                        Promise.race([
                            copied,
                            new Promise<never>((_, reject) => {
                                timer = setTimeout(
                                    () => {
                                        expired = true;
                                        reject(new Error('The chart copy timed out.'));
                                    },
                                    source === 'native-picker' ? 120_000 : 15_000,
                                );
                            }),
                        ]),
                        ctx.check,
                        performance.now() + (source === 'native-picker' ? 120_000 : 15_000) + 50,
                    );
                    path = value.path;
                    kind = value.kind;
                    name = source === 'native-picker' ? value.name : source.name;
                    size = value.size;
                    assertBytes(size);
                    ctx.check();
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
            const bytes = await readBytes(path, size, ctx, webEncoding);
            contentHeader(bytes, kind);
            const sha256 = await hash(bytes);
            ctx.check();
            const record: LocalChartRecord = {
                id: path.split('/').at(-1)!.split('.')[0],
                name,
                kind,
                bytes: size,
                rights,
                importedAt: Date.now(),
                sha256,
                ...(webEncoding ? { webEncoding } : {}),
            };
            const next = addLocalChart(before, record);
            indexAttempted = true;
            await writeIndex(ctx, before, next);
            ctx.check();
            committed = true;
            notify();
            ctx.check();
            return record;
        } finally {
            if (!committed) {
                try {
                    if (indexAttempted) await rollbackIndex(ctx, before);
                } finally {
                    if (path && kind) {
                        if (
                            webEncoding &&
                            path ===
                                localChartPath(ctx.namespace, {
                                    id: path.split('/').at(-1)!.split('.')[0],
                                    kind,
                                    webEncoding,
                                })
                        )
                            await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
                        else await cleanupCopy(path, ctx, kind);
                    }
                }
            }
        }
    });
}
export function readLocalChart(
    id: string,
    options: LocalChartOperation = {},
): Promise<{
    chart: LocalChartRecord;
    bytes: Uint8Array;
    namespace: string;
    isCurrent(): boolean;
}> {
    const captured = capture(options);
    const key = revisionKey(captured.scope, id),
        revision = revisions.get(key) ?? 0;
    const originalCheck = captured.check;
    captured.check = () => {
        originalCheck();
        if ((revisions.get(key) ?? 0) !== revision) throw stopped();
    };
    return serial(async () => {
        const ctx = await context(captured);
        const chart = (await readIndex(ctx)).charts.find((item) => item.id === id);
        if (!chart) throw new Error('This saved chart is unavailable.');
        const bytes = await readBytes(localChartPath(ctx.namespace, chart), chart.bytes, ctx, chart.webEncoding);
        contentHeader(bytes, chart.kind);
        if ((await hash(bytes)) !== chart.sha256) throw new Error('The saved chart checksum changed.');
        ctx.check();
        return {
            chart,
            bytes,
            namespace: ctx.namespace,
            isCurrent: () => {
                try {
                    ctx.check();
                    return true;
                } catch {
                    return false;
                }
            },
        };
    });
}
export function removeLocalChart(id: string, options: LocalChartOperation = {}): Promise<void> {
    const captured = capture(options);
    const key = revisionKey(captured.scope, id);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    notify();
    return serial(async () => {
        const ctx = await context(captured),
            before = await readIndex(ctx);
        const chart = before.charts.find((item) => item.id === id);
        if (!chart) throw new Error('This saved chart is unavailable.');
        const next = { ...before, charts: before.charts.filter((item) => item.id !== id) };
        let erased = false;
        try {
            await writeIndex(ctx, before, next);
            ctx.check();
            notify();
            ctx.check();
            // An already issued native unlink can only name this immutable,
            // owner-scoped UUID, never a later import or another account.
            await Filesystem.deleteFile({ path: localChartPath(ctx.namespace, chart), directory: Directory.Data });
            erased = true;
            ctx.check();
        } catch (error) {
            if (!erased) await rollbackIndex(ctx, before);
            throw error;
        }
    });
}
