import { Filesystem, Directory } from '@capacitor/filesystem';
import { registerPlugin } from '@capacitor/core';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { WindStore } from '../../stores/WindStore';
import { decodeGribInWorker } from './gribImportWorkerHost';
import { GRIB_IMPORT_LIMITS, type ImportedGribFile } from './gribImportTypes';

const Documents = registerPlugin<{
    copy(options: { url: string; ownerNamespace: string }): Promise<{ path: string; size: number }>;
}>('GribDocument');
const PREFIX = 'thalassa.grib.import.v1.';
const PATH = /^grib-import\/[a-f0-9]{32}\/[a-f0-9-]{36}\.grb$/;
interface Selection {
    schema: 1;
    owner: string;
    path: string;
    size: number;
    sha256: string;
    active: boolean;
}
let selection: Selection | null = null,
    decoded: ImportedGribFile | null = null,
    installed = false,
    generation = 0;
let activeImport: AbortController | null = null;
const workers = new Set<AbortController>();
let publishing = false;
let pendingView: { owner: string; path: string } | null = null;
const digest = async (buffer: BufferSource) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');
export const gribOwnerNamespace = async (scope: AuthIdentityScope = getAuthIdentityScope()) =>
    (await digest(new TextEncoder().encode(scope.key))).slice(0, 32);
export const isImportedGribPath = (path: string | null | undefined) => !!path && PATH.test(path);
const current = (scope: AuthIdentityScope) => isAuthIdentityScopeCurrent(scope);
function guard(scope: AuthIdentityScope, live: () => boolean = () => true) {
    if (!current(scope) || !live()) throw new Error('GRIB import stopped.');
}
async function remove(path: string) {
    if (PATH.test(path)) await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
}
async function cleanOrphans(
    namespace: string,
    keep: string | undefined,
    scope: AuthIdentityScope,
    live: () => boolean,
): Promise<void> {
    const folder = `grib-import/${namespace}`;
    const listing = await Filesystem.readdir({ path: folder, directory: Directory.Data }).catch(() => ({ files: [] }));
    guard(scope, live);
    if (listing.files.length > 16) throw new Error('Saved GRIB storage needs cleanup.');
    for (const entry of listing.files) {
        const path = `${folder}/${entry.name}`;
        if (PATH.test(path) && path !== keep) {
            guard(scope, live);
            await remove(path);
        }
    }
}
export function importedFieldCoversNow(file: ImportedGribFile, field: 'wind' | 'pressure', now = Date.now()): boolean {
    const data = file[field],
        hours = data?.stepHours;
    return (
        !!hours?.length &&
        now >= Date.parse(file.refTime) + hours[0] * 3600000 &&
        now <= Date.parse(file.refTime) + hours.at(-1)! * 3600000
    );
}
export function currentImportedGrib(): ImportedGribFile | null {
    return selection?.owner === getAuthIdentityScope().key &&
        WindStore.getState().localGribPath === selection.path &&
        !WindStore.getState().isGlobalMode
        ? decoded
        : null;
}
/** Consumed only for a new attachment, never for a cold restore or a mode toggle. */
export function consumeImportedGribView(path: string) {
    if (!pendingView || pendingView.owner !== getAuthIdentityScope().key || pendingView.path !== path) return null;
    const file = currentImportedGrib();
    if (!file) return null;
    pendingView = null;
    const grid = file.wind ?? file.pressure;
    return grid
        ? ([
              [grid.west, grid.south],
              [grid.east, grid.north],
          ] as [[number, number], [number, number]])
        : null;
}
export async function removeSelectedImportedGrib(): Promise<void> {
    const scope = getAuthIdentityScope(),
        namespace = await gribOwnerNamespace(scope);
    guard(scope);
    const record = readSelection(namespace, scope);
    if (!record) return;
    generation++;
    activeImport?.abort();
    for (const worker of workers) worker.abort();
    pendingView = null;
    // Clear the selection before yielding; the user can explicitly choose online data afterwards.
    localStorage.removeItem(PREFIX + namespace);
    selection = null;
    decoded = null;
    if (WindStore.getState().localGribPath === record.path)
        WindStore.setState({
            localGribPath: null,
            isGlobalMode: false,
            grid: null,
            loading: false,
            error: 'Imported GRIB removed. Choose online forecasts to continue.',
            hour: 0,
            totalHours: 0,
        });
    await Filesystem.deleteFile({ path: record.path, directory: Directory.Data }).catch(() => {
        throw new Error('The import was deselected but its saved file could not be removed.');
    });
}
function readSelection(namespace: string, scope: AuthIdentityScope): Selection | null {
    const raw = localStorage.getItem(PREFIX + namespace);
    if (!raw) return null;
    if (raw.length > 2048) throw new Error('Invalid saved GRIB metadata.');
    const m = JSON.parse(raw) as Selection;
    if (
        m.schema !== 1 ||
        m.owner !== scope.key ||
        !PATH.test(m.path) ||
        !m.path.startsWith(`grib-import/${namespace}/`) ||
        !Number.isInteger(m.size) ||
        m.size < 8 ||
        m.size > GRIB_IMPORT_LIMITS.fileBytes ||
        !/^[a-f0-9]{64}$/.test(m.sha256) ||
        typeof m.active !== 'boolean'
    )
        throw new Error('Invalid saved GRIB metadata.');
    return m;
}
async function decodePath(
    path: string,
    size: number,
    scope: AuthIdentityScope,
    live: () => boolean,
    expectedHash?: string,
): Promise<{ file: ImportedGribFile; sha256: string }> {
    guard(scope, live);
    const stat = await Filesystem.stat({ path, directory: Directory.Data });
    guard(scope, live);
    if (stat.type !== 'file' || stat.size !== size || size < 8 || size > GRIB_IMPORT_LIMITS.fileBytes)
        throw new Error('The imported GRIB file is missing, changed or too large.');
    const read = await Filesystem.readFile({ path, directory: Directory.Data });
    guard(scope, live);
    let buffer: ArrayBuffer;
    if (typeof read.data === 'string') {
        if (
            read.data.length > Math.ceil(GRIB_IMPORT_LIMITS.fileBytes / 3) * 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(read.data)
        )
            throw new Error('Invalid imported GRIB encoding.');
        const binary = atob(read.data);
        if (binary.length !== size) throw new Error('The imported GRIB file changed.');
        buffer = Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
    } else {
        if (read.data.size !== size) throw new Error('The imported GRIB file changed.');
        buffer = await read.data.arrayBuffer();
    }
    const sha256 = await digest(buffer);
    guard(scope, live);
    if (expectedHash && sha256 !== expectedHash) throw new Error('The saved GRIB checksum does not match.');
    const controller = new AbortController();
    workers.add(controller);
    try {
        const file = await decodeGribInWorker(buffer, {
            signal: controller.signal,
            isCurrent: () => current(scope) && live(),
        });
        guard(scope, live);
        return { file, sha256 };
    } finally {
        workers.delete(controller);
    }
}
function publish(record: Selection, file: ImportedGribFile): void {
    publishing = true;
    selection = record;
    decoded = file;
    WindStore.setLocalGribPath(record.path);
    WindStore.setState({
        isGlobalMode: false,
        field: 'wind',
        grid: importedFieldCoversNow(file, 'wind') ? file.wind : null,
        loading: false,
        error:
            file.wind && !importedFieldCoversNow(file, 'wind')
                ? 'Imported wind does not cover the current time.'
                : file.wind
                  ? null
                  : 'This GRIB contains pressure only.',
        hour: 0,
        totalHours: file.wind?.totalHours ?? 0,
    });
    window.dispatchEvent(new Event('thalassa:grib-imported'));
    publishing = false;
}
async function copyDocument(
    url: string,
    namespace: string,
    scope: AuthIdentityScope,
    signal: AbortSignal,
): Promise<{ path: string; size: number }> {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error?: Error, value?: { path: string; size: number }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(value!);
        };
        const abort = () => finish(new Error('GRIB import stopped.'));
        const timer = setTimeout(
            () => finish(new Error('The local GRIB copy timed out. Try downloading the attachment to Files first.')),
            15000,
        );
        signal.addEventListener('abort', abort, { once: true });
        void Documents.copy({ url, ownerNamespace: namespace }).then(
            (value) => {
                const owned =
                    typeof value.path === 'string' &&
                    PATH.test(value.path) &&
                    value.path.startsWith(`grib-import/${namespace}/`);
                if (done || !current(scope) || signal.aborted) {
                    if (owned) void remove(value.path);
                    finish(new Error('GRIB import stopped.'));
                    return;
                }
                if (!owned) {
                    finish(new Error('Invalid native GRIB copy.'));
                    return;
                }
                finish(undefined, value);
            },
            () => finish(new Error('The local GRIB file could not be copied.')),
        );
        if (signal.aborted) abort();
    });
}
export async function loadImportedGrib(path: string, live: () => boolean = () => true): Promise<ImportedGribFile> {
    const scope = getAuthIdentityScope(),
        namespace = await gribOwnerNamespace(scope);
    guard(scope, live);
    const record = readSelection(namespace, scope);
    if (!record || record.path !== path) throw new Error('This GRIB is not selected for the current account.');
    if (selection?.path === path && decoded && selection.owner === scope.key) return decoded;
    const result = await decodePath(path, record.size, scope, live, record.sha256);
    guard(scope, live);
    selection = record;
    decoded = result.file;
    return result.file;
}
/** No network, no cross-account fallback. The callback invalidates work when its consumer closes or changes. */
export async function loadSelectedImportedGrib(
    live: () => boolean = () => true,
): Promise<{ file: ImportedGribFile; fingerprint: string } | null> {
    const state = WindStore.getState();
    if (state.isGlobalMode || !isImportedGribPath(state.localGribPath)) return null;
    const scope = getAuthIdentityScope(),
        path = state.localGribPath!;
    const selected = () => live() && !WindStore.getState().isGlobalMode && WindStore.getState().localGribPath === path;
    const file = await loadImportedGrib(path, selected);
    guard(scope, selected);
    if (!selection || selection.path !== path) return null;
    return { file, fingerprint: selection.sha256 };
}
export function isLocalGribUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        return (
            url.protocol === 'file:' &&
            !url.username &&
            !url.password &&
            (!url.hostname || url.hostname === 'localhost') &&
            !url.search &&
            !url.hash &&
            /\.(?:grb|grib|grb1|grib1|grb2|grib2)$/i.test(url.pathname)
        );
    } catch {
        return false;
    }
}
export async function importLocalGribUrl(
    url: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<ImportedGribFile> {
    if (!isLocalGribUrl(url)) throw new Error('Choose a local GRIB attachment from Mail or Files.');
    activeImport?.abort();
    for (const worker of workers) worker.abort();
    const controller = new AbortController();
    activeImport = controller;
    const token = ++generation;
    const live = () => !controller.signal.aborted && token === generation;
    const namespace = await gribOwnerNamespace(scope);
    guard(scope, live);
    let candidate: string | undefined;
    try {
        let previous: Selection | null = null;
        try {
            previous = readSelection(namespace, scope);
        } catch {
            /* A new valid import replaces invalid metadata. */
        }
        await cleanOrphans(namespace, previous?.path, scope, live);
        guard(scope, live);
        const copied = await copyDocument(url, namespace, scope, controller.signal);
        if (!PATH.test(copied.path) || !copied.path.startsWith(`grib-import/${namespace}/`))
            throw new Error('Invalid native GRIB copy.');
        candidate = copied.path;
        guard(scope, live);
        const result = await decodePath(copied.path, copied.size, scope, live);
        guard(scope, live);
        if (!importedFieldCoversNow(result.file, 'wind') && !importedFieldCoversNow(result.file, 'pressure'))
            throw new Error('The imported GRIB is expired or does not cover the current time.');
        const record: Selection = {
            schema: 1,
            owner: scope.key,
            path: copied.path,
            size: copied.size,
            sha256: result.sha256,
            active: true,
        };
        // Synchronous metadata promotion cannot complete after another identity or import wins.
        guard(scope, live);
        localStorage.setItem(PREFIX + namespace, JSON.stringify(record));
        pendingView = { owner: scope.key, path: record.path };
        publish(record, result.file);
        candidate = undefined;
        if (previous && previous.path !== record.path) void remove(previous.path);
        return result.file;
    } finally {
        if (candidate) await remove(candidate);
        if (activeImport === controller) activeImport = null;
    }
}
export async function restoreLocalGribSelection(): Promise<void> {
    const scope = getAuthIdentityScope(),
        token = generation,
        namespace = await gribOwnerNamespace(scope);
    guard(scope, () => token === generation);
    let record: Selection | null;
    try {
        record = readSelection(namespace, scope);
    } catch {
        if (current(scope) && token === generation)
            WindStore.setError('Saved GRIB metadata is invalid. Open the original attachment again.');
        return;
    }
    if (!record?.active) return;
    try {
        const file = await loadImportedGrib(record.path, () => token === generation);
        guard(scope, () => token === generation);
        publish(record, file);
        if (!importedFieldCoversNow(file, 'wind') && !importedFieldCoversNow(file, 'pressure'))
            WindStore.setState({ grid: null, error: 'Saved GRIB is expired or does not cover the current time.' });
    } catch (error) {
        if (current(scope) && token === generation) {
            WindStore.setLocalGribPath(record.path);
            WindStore.setState({
                isGlobalMode: false,
                grid: null,
                error: error instanceof Error ? error.message : 'Saved GRIB unavailable.',
            });
        }
    }
}
export function installLocalGribImports(): void {
    if (installed) return;
    installed = true;
    let wasGlobal = WindStore.getState().isGlobalMode;
    WindStore.subscribe((state) => {
        const enteredOnline = state.isGlobalMode && !wasGlobal;
        wasGlobal = state.isGlobalMode;
        if (enteredOnline && !publishing) {
            generation++;
            activeImport?.abort();
            for (const worker of workers) worker.abort();
            pendingView = null;
        }
        if (
            publishing ||
            !selection ||
            selection.owner !== getAuthIdentityScope().key ||
            state.localGribPath !== selection.path
        )
            return;
        const active = !state.isGlobalMode;
        if (active === selection.active) return;
        const scope = getAuthIdentityScope(),
            record = { ...selection, active };
        selection = record;
        void gribOwnerNamespace(scope)
            .then((namespace) => {
                if (current(scope) && selection === record)
                    localStorage.setItem(PREFIX + namespace, JSON.stringify(record));
            })
            .catch(() => undefined);
    });
    setInterval(() => {
        const file = currentImportedGrib();
        if (file && !importedFieldCoversNow(file, 'wind') && WindStore.getState().grid)
            WindStore.setState({ grid: null, error: 'Imported wind is expired or does not cover the current time.' });
        if (file && !importedFieldCoversNow(file, 'pressure'))
            window.dispatchEvent(new Event('thalassa:grib-pressure-expired'));
    }, 30000);
    subscribeAuthIdentityScope(() => {
        generation++;
        activeImport?.abort();
        for (const worker of workers) worker.abort();
        selection = null;
        decoded = null;
        pendingView = null;
        if (isImportedGribPath(WindStore.getState().localGribPath)) WindStore.reset();
        void restoreLocalGribSelection().catch(() => undefined);
    });
    void restoreLocalGribSelection().catch(() => undefined);
}
