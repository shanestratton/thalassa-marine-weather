import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { record } from '../userOverlays/model';
import {
    ANNOTATION_BYTES,
    annotationId,
    validateAnnotationLibrary,
    type AnnotationLibrary,
    type AnnotationGeometry,
} from './model';
import { safeLabel } from '../userOverlays/model';

const empty = (): AnnotationLibrary => ({ schema: 1, revision: 0, annotations: [] });
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export const subscribeAnnotations = (fn: () => void) => {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
};
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
}
function check(scope: AuthIdentityScope) {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) throw Error('Sign in again to manage private drawings.');
}
async function digest(text: string) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
}
const options = (path: string) => ({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
function missing(error: unknown) {
    return (
        record(error) &&
        (['ENOENT', 'OS-PLUG-FILE-0008'].includes(String(error.code)) ||
            [
                'File does not exist.',
                'Entry does not exist.',
                'Folder does not exist.',
                'Directory does not exist.',
            ].includes(String(error.message)))
    );
}
async function pathFor(scope: AuthIdentityScope) {
    check(scope);
    const hash = (await digest(scope.key)).slice(0, 32);
    check(scope);
    return `chart-annotations/v1/${hash}`;
}
async function read(path: string, scope: AuthIdentityScope): Promise<AnnotationLibrary> {
    check(scope);
    try {
        const stat = await Filesystem.stat(options(path + '/library.json'));
        check(scope);
        if (
            stat.type !== 'file' ||
            !Number.isSafeInteger(stat.size) ||
            stat.size <= 0 ||
            stat.size > ANNOTATION_BYTES + 256
        )
            throw Error('Private drawing file exceeds its limit.');
    } catch (error) {
        check(scope);
        if (missing(error)) return empty();
        throw Error('Private drawings are unavailable.');
    }
    const result = await Filesystem.readFile(options(path + '/library.json'));
    check(scope);
    if (typeof result.data !== 'string' || new TextEncoder().encode(result.data).length > ANNOTATION_BYTES + 256)
        throw Error('Private drawing file exceeds its limit.');
    const value: unknown = JSON.parse(result.data);
    if (
        !record(value) ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        !record(value.library)
    )
        throw Error('Private drawing file is damaged.');
    if ((await digest(JSON.stringify(value.library))) !== value.sha256)
        throw Error('Private drawing integrity failed.');
    check(scope);
    return validateAnnotationLibrary(value.library);
}
export async function loadAnnotations(scope = getAuthIdentityScope()): Promise<AnnotationLibrary> {
    const path = await pathFor(scope);
    return serial(() => read(path, scope));
}
async function mutate(
    expectedRevision: number,
    change: (library: AnnotationLibrary) => AnnotationLibrary,
    scope: AuthIdentityScope,
) {
    return serial(async () => {
        const path = await pathFor(scope),
            current = await read(path, scope);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision)
            throw Error('Drawings changed. Reopen the library before saving.');
        if (current.revision >= Number.MAX_SAFE_INTEGER - 1) throw Error('Private drawing revision limit reached.');
        const next = validateAnnotationLibrary({ ...change(current), revision: current.revision + 1 }),
            text = JSON.stringify(next),
            sha256 = await digest(text);
        check(scope);
        let roots: Awaited<ReturnType<typeof Filesystem.readdir>>['files'] = [];
        try {
            roots = (await Filesystem.readdir(options('chart-annotations/v1'))).files;
        } catch (error) {
            if (!missing(error)) throw Error('Private drawing storage is unavailable.');
        }
        check(scope);
        if (roots.length >= 4 && !roots.some((r) => r.name === path.split('/').at(-1)))
            throw Error('This device already holds four private drawing libraries.');
        await Filesystem.writeFile({
            ...options(path + '/library.tmp'),
            data: JSON.stringify({ sha256, library: next }),
            recursive: true,
        });
        check(scope);
        await Filesystem.rename({
            from: path + '/library.tmp',
            to: path + '/library.json',
            directory: Directory.Data,
            toDirectory: Directory.Data,
        });
        check(scope);
        for (const fn of [...listeners])
            try {
                fn();
            } catch {
                /* isolate subscribers */
            }
        return next;
    });
}
/** Only explicit user-created geometry enters this store; no ENC read/borrow API exists here. */
export function saveAnnotation(
    geometry: AnnotationGeometry,
    label: string,
    expectedRevision: number,
    scope = getAuthIdentityScope(),
) {
    return mutate(
        expectedRevision,
        (library) => {
            const now = Date.now();
            return {
                ...library,
                annotations: [
                    ...library.annotations,
                    {
                        id: annotationId(),
                        revision: 1,
                        createdAt: now,
                        updatedAt: now,
                        label: safeLabel(label, 'User drawing'),
                        visible: true,
                        geometry,
                    },
                ],
            };
        },
        scope,
    );
}
export function changeAnnotation(
    id: string,
    expectedItemRevision: number,
    expectedRevision: number,
    patch: { visible?: boolean; label?: string },
    scope = getAuthIdentityScope(),
) {
    return mutate(
        expectedRevision,
        (library) => {
            const item = library.annotations.find((r) => r.id === id);
            if (!item || item.revision !== expectedItemRevision)
                throw Error('This drawing changed. Reopen it before editing.');
            if (
                Object.keys(patch).some((k) => !['visible', 'label'].includes(k)) ||
                (patch.visible !== undefined && typeof patch.visible !== 'boolean') ||
                (patch.label !== undefined && typeof patch.label !== 'string')
            )
                throw Error('Invalid drawing change.');
            return {
                ...library,
                annotations: library.annotations.map((r) =>
                    r.id === id
                        ? {
                              ...r,
                              revision: r.revision + 1,
                              updatedAt: Math.max(Date.now(), r.updatedAt),
                              visible: patch.visible ?? r.visible,
                              label: patch.label === undefined ? r.label : safeLabel(patch.label, 'User drawing'),
                          }
                        : r,
                ),
            };
        },
        scope,
    );
}
export function removeAnnotation(
    id: string,
    expectedItemRevision: number,
    expectedRevision: number,
    scope = getAuthIdentityScope(),
) {
    return mutate(
        expectedRevision,
        (library) => {
            if (!library.annotations.some((r) => r.id === id && r.revision === expectedItemRevision))
                throw Error('This drawing changed. Reopen it before removing.');
            return { ...library, annotations: library.annotations.filter((r) => r.id !== id) };
        },
        scope,
    );
}
