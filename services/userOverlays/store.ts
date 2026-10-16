import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import {
    normalizeOverlay,
    OVERLAY_INPUT_BYTES,
    OVERLAY_MAX_FILES,
    OVERLAY_MAX_FEATURES,
    OVERLAY_MAX_VERTICES,
    OVERLAY_TOTAL_BYTES,
    safeLabel,
    record,
    type OverlayData,
    type OverlayPreview,
} from './model';

export interface UserOverlay {
    id: string;
    label: string;
    createdAt: number;
    bytes: number;
    features: number;
    vertices: number;
    polygons: number;
    visible: boolean;
    alerts: boolean;
}
export interface UserOverlayLibrary {
    schema: 1;
    charts: boolean;
    position: 'boat' | 'phone';
    overlays: UserOverlay[];
}
const HASH = /^[a-f0-9]{64}$/;
const listeners = new Set<() => void>();
let queue: Promise<unknown> = Promise.resolve(),
    epoch = 0;
export const subscribeUserOverlays = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};
function changed() {
    epoch++;
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch {
            /* isolate lifecycle consumers */
        }
    }
}
subscribeAuthIdentityScope(changed);
export const userOverlayGeneration = () => epoch;
const digest = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
function check(scope: AuthIdentityScope) {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) throw Error('Sign in again to manage private overlays.');
}
async function folder(scope: AuthIdentityScope) {
    check(scope);
    const key = (await digest(scope.key)).slice(0, 32);
    check(scope);
    return `user-overlays/v1/${key}`;
}
const options = (path: string) => ({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
function parseLibrary(v: unknown): UserOverlayLibrary {
    if (
        !record(v) ||
        v.schema !== 1 ||
        typeof v.charts !== 'boolean' ||
        !['boat', 'phone'].includes(String(v.position)) ||
        !Array.isArray(v.overlays) ||
        v.overlays.length > OVERLAY_MAX_FILES
    )
        throw Error('Private overlay library is damaged.');
    const ids = new Set<string>();
    let total = 0,
        features = 0,
        vertices = 0;
    for (const r of v.overlays) {
        if (
            !record(r) ||
            typeof r.id !== 'string' ||
            !HASH.test(r.id) ||
            ids.has(r.id) ||
            typeof r.label !== 'string' ||
            !r.label ||
            safeLabel(r.label, '') !== r.label ||
            typeof r.visible !== 'boolean' ||
            typeof r.alerts !== 'boolean' ||
            !['createdAt', 'bytes', 'features', 'vertices', 'polygons'].every(
                (k) => typeof r[k] === 'number' && Number.isSafeInteger(r[k]) && (r[k] as number) >= 0,
            ) ||
            (r.createdAt as number) <= 0 ||
            (r.createdAt as number) > 8_640_000_000_000_000 ||
            (r.bytes as number) <= 0 ||
            (r.features as number) <= 0 ||
            (r.vertices as number) <= 0 ||
            (r.bytes as number) > OVERLAY_INPUT_BYTES ||
            (r.features as number) > 2000 ||
            (r.vertices as number) > 50000
        )
            throw Error('Private overlay library is damaged.');
        ids.add(r.id);
        total += r.bytes as number;
        features += r.features as number;
        vertices += r.vertices as number;
    }
    if (total > OVERLAY_TOTAL_BYTES || features > OVERLAY_MAX_FEATURES || vertices > OVERLAY_MAX_VERTICES)
        throw Error('Private overlay library exceeds its byte, feature or vertex limit.');
    return v as unknown as UserOverlayLibrary;
}
async function readAt(path: string, scope: AuthIdentityScope): Promise<UserOverlayLibrary> {
    check(scope);
    try {
        await Filesystem.stat(options(path + '/index.json'));
    } catch (error) {
        check(scope);
        if (
            !record(error) ||
            !(
                ['ENOENT', 'OS-PLUG-FILE-0008'].includes(String(error.code)) ||
                error.message === 'File does not exist.' ||
                error.message === 'Entry does not exist.' ||
                error.message === 'Folder does not exist.'
            )
        )
            throw Error('Private overlay storage is unavailable.');
        return { schema: 1, charts: false, position: 'boat', overlays: [] };
    }
    const r = await Filesystem.readFile(options(path + '/index.json'));
    check(scope);
    if (typeof r.data !== 'string' || new TextEncoder().encode(r.data).length > 16384)
        throw Error('Private overlay index is damaged.');
    return parseLibrary(JSON.parse(r.data));
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = queue.then(fn, fn);
    queue = job.catch(() => {});
    return job;
}
export async function loadUserOverlays(scope = getAuthIdentityScope()) {
    const path = await folder(scope);
    return serial(() => readAt(path, scope));
}
async function writeIndex(path: string, library: UserOverlayLibrary, scope: AuthIdentityScope) {
    check(scope);
    const text = JSON.stringify(parseLibrary(library));
    await Filesystem.writeFile({ ...options(path + '/index.tmp'), data: text, recursive: true });
    check(scope);
    await Filesystem.rename({
        from: path + '/index.tmp',
        to: path + '/index.json',
        directory: Directory.Data,
        toDirectory: Directory.Data,
    });
    check(scope);
    changed();
}
export function saveUserOverlay(
    preview: OverlayPreview,
    label: string,
    scope = getAuthIdentityScope(),
): Promise<UserOverlay> {
    return serial(async () => {
        const path = await folder(scope),
            normalized = normalizeOverlay(preview.data),
            text = JSON.stringify(normalized.data),
            id = await digest(text);
        check(scope);
        const library = await readAt(path, scope);
        let roots: Awaited<ReturnType<typeof Filesystem.readdir>>['files'] = [];
        try {
            roots = (await Filesystem.readdir(options('user-overlays/v1'))).files;
        } catch (error) {
            if (
                !record(error) ||
                !(
                    ['ENOENT', 'OS-PLUG-FILE-0008'].includes(String(error.code)) ||
                    error.message === 'Directory does not exist.' ||
                    error.message === 'File does not exist.' ||
                    error.message === 'Entry does not exist.' ||
                    error.message === 'Folder does not exist.'
                )
            )
                throw Error('Private overlay storage is unavailable.');
        }
        check(scope);
        const own = path.split('/').at(-1)!;
        if (roots.length >= 4 && !roots.some((r) => r.name === own))
            throw Error('This device already holds four private overlay libraries.');
        // Reconcile only this account's immutable orphans under the writer lock.
        try {
            const files = (await Filesystem.readdir(options(path))).files;
            check(scope);
            if (files.length > 32) throw Error('Private overlay folder needs recovery.');
            for (const f of files)
                if (/^[a-f0-9]{64}\.json$/.test(f.name) && !library.overlays.some((r) => r.id + '.json' === f.name)) {
                    check(scope);
                    await Filesystem.deleteFile(options(path + '/' + f.name));
                    check(scope);
                }
        } catch (error) {
            if (
                !record(error) ||
                !(
                    ['ENOENT', 'OS-PLUG-FILE-0008'].includes(String(error.code)) ||
                    error.message === 'Directory does not exist.' ||
                    error.message === 'File does not exist.' ||
                    error.message === 'Entry does not exist.' ||
                    error.message === 'Folder does not exist.'
                )
            )
                throw error;
        }
        if (library.overlays.some((r) => r.id === id)) throw Error('This exact overlay is already saved.');
        if (
            library.overlays.length >= OVERLAY_MAX_FILES ||
            library.overlays.reduce((n, r) => n + r.features, 0) + normalized.data.features.length >
                OVERLAY_MAX_FEATURES ||
            library.overlays.reduce((n, r) => n + r.vertices, 0) + normalized.vertices > OVERLAY_MAX_VERTICES ||
            library.overlays.reduce((n, r) => n + r.bytes, 0) + normalized.bytes > OVERLAY_TOTAL_BYTES
        )
            throw Error(
                'Private overlay limit reached: remove an overlay first (10 files / 8 MiB / 2,000 features / 50,000 vertices).',
            );
        const row: UserOverlay = {
            id,
            label: safeLabel(label, 'User overlay'),
            createdAt: Date.now(),
            bytes: normalized.bytes,
            features: normalized.data.features.length,
            vertices: normalized.vertices,
            polygons: normalized.polygons,
            visible: true,
            alerts: false,
        };
        await Filesystem.writeFile({ ...options(path + '/' + id + '.json'), data: text, recursive: true });
        check(scope);
        await writeIndex(path, { ...library, overlays: [...library.overlays, row] }, scope);
        return row;
    });
}
export function updateUserOverlay(
    id: string | null,
    patch: { visible?: boolean; alerts?: boolean; charts?: boolean; position?: 'boat' | 'phone' },
    scope = getAuthIdentityScope(),
) {
    return serial(async () => {
        if (
            (id !== null && !HASH.test(id)) ||
            Object.keys(patch).some((k) => !['visible', 'alerts', 'charts', 'position'].includes(k)) ||
            Object.entries(patch).some(([k, v]) =>
                k === 'position' ? !['boat', 'phone'].includes(String(v)) : typeof v !== 'boolean',
            )
        )
            throw Error('Invalid overlay change.');
        const path = await folder(scope),
            library = await readAt(path, scope);
        const next =
            id === null
                ? { ...library, charts: patch.charts ?? library.charts, position: patch.position ?? library.position }
                : {
                      ...library,
                      overlays: library.overlays.map((r) =>
                          r.id === id
                              ? { ...r, visible: patch.visible ?? r.visible, alerts: patch.alerts ?? r.alerts }
                              : r,
                      ),
                  };
        await writeIndex(path, next, scope);
    });
}
export function removeUserOverlay(id: string, scope = getAuthIdentityScope()) {
    return serial(async () => {
        if (!HASH.test(id)) throw Error('Invalid overlay.');
        const path = await folder(scope),
            library = await readAt(path, scope);
        await writeIndex(path, { ...library, overlays: library.overlays.filter((r) => r.id !== id) }, scope);
        await Filesystem.deleteFile(options(path + '/' + id + '.json')).catch(() => {});
        check(scope);
    });
}
export async function readUserOverlay(row: UserOverlay, scope = getAuthIdentityScope()): Promise<OverlayData> {
    if (!HASH.test(row.id)) throw Error('Invalid overlay.');
    const path = await folder(scope),
        stat = await Filesystem.stat(options(path + '/' + row.id + '.json'));
    check(scope);
    // Native reports UTF-8 bytes; the web plugin stores a UTF-16 string length.
    // Bound either representation before reading, then verify exact UTF-8 bytes and SHA below.
    if (
        stat.type !== 'file' ||
        !Number.isSafeInteger(stat.size) ||
        stat.size <= 0 ||
        stat.size > row.bytes ||
        stat.size > OVERLAY_INPUT_BYTES ||
        (Capacitor.isNativePlatform() && stat.size !== row.bytes)
    )
        throw Error('Private overlay file changed.');
    const r = await Filesystem.readFile(options(path + '/' + row.id + '.json'));
    check(scope);
    if (
        typeof r.data !== 'string' ||
        new TextEncoder().encode(r.data).length !== row.bytes ||
        (await digest(r.data)) !== row.id
    )
        throw Error('Private overlay file integrity failed.');
    check(scope);
    const normalized = normalizeOverlay(JSON.parse(r.data));
    if (
        normalized.bytes !== row.bytes ||
        normalized.data.features.length !== row.features ||
        normalized.vertices !== row.vertices ||
        normalized.polygons !== row.polygons
    )
        throw Error('Private overlay metadata does not match its file.');
    return normalized.data;
}
