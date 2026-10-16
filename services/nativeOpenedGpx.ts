import { registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

import { clearOpenedGpx, stageOpenedGpx } from './openedGpxQueue';
export const OPEN_GPX_MAX_BYTES = 8 * 1024 * 1024;
const Documents = registerPlugin<{
    copyGpx(options: { url: string; ownerNamespace: string }): Promise<{ path: string; size: number }>;
}>('GribDocument');
const PATH = /^gpx-import\/[a-f0-9]{32}\/[a-f0-9-]{36}\.gpx$/;
let generation = 0;
subscribeAuthIdentityScope(() => {
    generation++;
});
export function isLocalGpxUrl(raw: string): boolean {
    if (raw.length > 8192) return false;
    try {
        const url = new URL(raw);
        return (
            url.protocol === 'file:' &&
            (!url.hostname || url.hostname === 'localhost') &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            /\.gpx$/i.test(url.pathname)
        );
    } catch {
        return false;
    }
}
const remove = async (path: string) => {
    if (PATH.test(path)) await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
};
/** One private, bounded copy feeds the existing preview; never saves a voyage or sends a route. */
export async function openNativeGpx(url: string, scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
    if (!isLocalGpxUrl(url)) throw new Error('Choose a local GPX attachment from Mail or Files.');
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('GPX import stopped.');
    const token = ++generation;
    clearOpenedGpx();
    let expired = false;
    const live = () => !expired && token === generation && isAuthIdentityScopeCurrent(scope);
    const guard = () => {
        if (!live()) throw new Error('GPX import stopped.');
    };
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope.key)));
    guard();
    const namespace = [...digest]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
    const owned = (path: unknown): path is string =>
        typeof path === 'string' && PATH.test(path) && path.startsWith(`gpx-import/${namespace}/`);
    let copiedPath: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const copy = Documents.copyGpx({ url, ownerNamespace: namespace }).then(async (value) => {
            if (!live()) {
                if (owned(value.path)) await remove(value.path);
                throw new Error('GPX import stopped.');
            }
            if (!owned(value.path)) throw new Error('Invalid GPX copy.');
            copiedPath = value.path;
            if (!Number.isSafeInteger(value.size) || value.size < 8 || value.size > OPEN_GPX_MAX_BYTES)
                throw new Error('The GPX file exceeds 8 MiB or could not be read.');
            return value;
        });
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                expired = true;
                reject(new Error('The GPX copy timed out. Save the attachment to Files and try again.'));
            }, 15_000);
        });
        const read = (async () => {
            const value = await copy;
            guard();
            const stat = await Filesystem.stat({ path: value.path, directory: Directory.Data });
            guard();
            if (stat.type !== 'file' || stat.size !== value.size) throw new Error('The GPX copy changed.');
            const result = await Filesystem.readFile({
                path: value.path,
                directory: Directory.Data,
                encoding: Encoding.UTF8,
            });
            guard();
            if (
                typeof result.data !== 'string' ||
                result.data.length > OPEN_GPX_MAX_BYTES ||
                new TextEncoder().encode(result.data).byteLength !== value.size ||
                /<!DOCTYPE|<!ENTITY/i.test(result.data)
            )
                throw new Error('The GPX file is damaged or uses unsupported XML declarations.');
            return new File([result.data], 'Opened route.gpx', { type: 'application/gpx+xml' });
        })();
        const file = await Promise.race([read, deadline]);
        guard();
        stageOpenedGpx(file, scope);
    } finally {
        if (timer) clearTimeout(timer);
        expired = true;
        if (copiedPath) await remove(copiedPath);
    }
}
