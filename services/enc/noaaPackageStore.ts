/** Account-owned public chart parts. No WAN fallback and no licensed chart
 * input. The catalogue reserves ZIP + manifest + every part before calling. */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { parseNoaaPackage, NOAA_PART_BYTES, type NoaaPackage, type NoaaPartObject } from './noaaPackageContract';
import type { NoaaObject } from './noaaCatalogueContract';
import type { EncCell, EncConversionResult } from './types';
export interface NoaaPackageReference {
    owner: string;
    manifestSha256: string;
    path: string;
}
const staged = new WeakMap<NoaaPackageReference, { manifest: NoaaPackage; scope: AuthIdentityScope }>();
export function assertStagedNoaaPackage(manifest: NoaaPackage, ref: NoaaPackageReference): void {
    const held = staged.get(ref);
    if (!held || held.manifest !== manifest) throw Error('NOAA package has not passed complete local verification.');
    current(held.scope);
    staged.delete(ref);
}
const directory = (): Directory => (Capacitor.isNativePlatform() ? Directory.Library : Directory.Data);
export const noaaPackageSha = async (bytes: Uint8Array): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);
function current(scope: AuthIdentityScope): void {
    if (!isAuthIdentityScopeCurrent(scope)) throw Error('NOAA package account changed.');
}
export async function noaaPackagePath(sha: string, scope = getAuthIdentityScope()): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw Error('Invalid NOAA package identity.');
    const account = (await noaaPackageSha(encoded(scope.key))).slice(0, 32);
    current(scope);
    return `${Capacitor.isNativePlatform() ? 'Application Support/enc-open/' : ''}noaa-packages/${account}/${sha}`;
}
async function exists(path: string): Promise<boolean> {
    try {
        await Filesystem.stat({ path, directory: directory() });
        return true;
    } catch (error) {
        if (/not exist|ENOENT|File does not exist/i.test(String(error))) return false;
        throw error;
    }
}
async function read(path: string, maximum: number): Promise<string> {
    const stat = await Filesystem.stat({ path, directory: directory() });
    if (stat.size > maximum) throw Error('NOAA package file exceeds its bound.');
    const result = await Filesystem.readFile({ path, directory: directory(), encoding: Encoding.UTF8 });
    const text = typeof result.data === 'string' ? result.data : await result.data.text();
    if (encoded(text).length > maximum) throw Error('NOAA package file exceeds its bound.');
    return text;
}
async function verifiedText(path: string, object: NoaaObject): Promise<string> {
    const text = await read(path, object.bytes),
        bytes = encoded(text);
    if (bytes.length !== object.bytes || (await noaaPackageSha(bytes)) !== object.sha256)
        throw Error('Saved NOAA package is incomplete or changed.');
    return text;
}
export async function stageNoaaPackage(
    manifest: NoaaPackage,
    manifestText: string,
    manifestObject: NoaaObject,
    scope: AuthIdentityScope,
    download: (object: NoaaObject) => Promise<Uint8Array>,
    assertAuthority: () => void,
): Promise<NoaaPackageReference> {
    if (manifestText.length > 128 * 1024 || encoded(manifestText).length > 128 * 1024)
        throw Error('NOAA package manifest exceeds its bound.');
    const check = (): void => {
        current(scope);
        assertAuthority();
    };
    parseNoaaPackage(manifest);
    if (JSON.stringify(parseNoaaPackage(JSON.parse(manifestText))) !== JSON.stringify(manifest))
        throw Error('NOAA package manifest value changed.');
    if (
        encoded(manifestText).length !== manifestObject.bytes ||
        (await noaaPackageSha(encoded(manifestText))) !== manifestObject.sha256
    )
        throw Error('NOAA package manifest changed.');
    const store = await import('./EncCellStore');
    await store.storeReady();
    const path = await noaaPackagePath(manifestObject.sha256, scope);
    check();
    // The reserved directory is the durable journal. Write its manifest first;
    // after a kill, every planned byte remains charged until exact cleanup.
    let existingManifest = false;
    try {
        await verifiedText(`${path}/manifest.json`, manifestObject);
        existingManifest = true;
    } catch {
        check();
    }
    if (!existingManifest) {
        await Filesystem.writeFile({
            path: `${path}/manifest.json`,
            directory: directory(),
            encoding: Encoding.UTF8,
            data: manifestText,
            recursive: true,
        });
        check();
        await verifiedText(`${path}/manifest.json`, manifestObject);
        check();
    }
    // Installation decode uses the same resident ledger as rendered/query views.
    const lease = store.reserveNoaaResident(NOAA_PART_BYTES);
    try {
        for (const part of manifest.parts) {
            check();
            let saved: string | undefined;
            try {
                saved = await verifiedText(`${path}/${part.sha256}.json`, part);
            } catch {
                check();
            }
            if (saved !== undefined) {
                await store.parseNoaaPartOffThread(saved, manifest, part);
                check();
                continue;
            }
            const bytes = await download(part);
            check();
            if (bytes.length !== part.bytes || (await noaaPackageSha(bytes)) !== part.sha256)
                throw Error('NOAA part checksum changed.');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            await store.parseNoaaPartOffThread(text, manifest, part);
            check();
            await Filesystem.writeFile({
                path: `${path}/${part.sha256}.json`,
                directory: directory(),
                encoding: Encoding.UTF8,
                data: text,
                recursive: true,
            });
            check();
            await verifiedText(`${path}/${part.sha256}.json`, part);
            check();
        }
    } finally {
        lease.release();
    }
    const ref = { owner: scope.key, manifestSha256: manifestObject.sha256, path };
    staged.set(ref, { manifest, scope });
    return ref;
}
export async function readNoaaPackage(cell: EncCell): Promise<NoaaPackage> {
    const ref = cell.noaaPackage,
        scope = getAuthIdentityScope();
    if (
        !ref ||
        ref.owner !== scope.key ||
        ref.path !== (await noaaPackagePath(ref.manifestSha256, scope)) ||
        cell.contentSha256 !== ref.manifestSha256 ||
        cell.sourceHO !== 'US' ||
        cell.licence === 'protected'
    )
        throw Error('NOAA package authority changed.');
    const text = await read(`${ref.path}/manifest.json`, 128 * 1024);
    if ((await noaaPackageSha(encoded(text))) !== ref.manifestSha256)
        throw Error('NOAA package manifest is incomplete or changed.');
    const manifest = parseNoaaPackage(JSON.parse(text)),
        m = manifest.metadata;
    if (
        m.cellId !== cell.id ||
        m.edition !== cell.edition ||
        m.updateNumber !== cell.updateNumber ||
        m.issued !== cell.issued ||
        JSON.stringify(m.bbox) !== JSON.stringify(cell.bbox)
    )
        throw Error('NOAA package revision changed.');
    current(scope);
    return manifest;
}
export async function readNoaaPackagePart(
    cell: EncCell,
    manifest: NoaaPackage,
    part: NoaaPartObject,
    bounds?: [number, number, number, number],
): Promise<EncConversionResult & { selectedBytes: number }> {
    const scope = getAuthIdentityScope();
    if (cell.noaaPackage?.owner !== scope.key || !manifest.parts.includes(part))
        throw Error('NOAA part authority changed.');
    const text = await verifiedText(`${cell.noaaPackage.path}/${part.sha256}.json`, part);
    current(scope);
    if (encoded(text).length > NOAA_PART_BYTES) throw Error('NOAA part exceeds decode limit.');
    const { parseNoaaPartOffThread } = await import('./EncCellStore');
    const blob = await parseNoaaPartOffThread(text, manifest, part, bounds, true);
    current(scope);
    return blob;
}
/** Only a hash-addressed directory in the captured account may be removed.
 * A failure keeps the catalogue reservation, including partial/orphan files. */
export async function deleteNoaaPackage(sha: string, scope = getAuthIdentityScope()): Promise<void> {
    const path = await noaaPackagePath(sha, scope);
    current(scope);
    try {
        await Filesystem.rmdir({ path, directory: directory(), recursive: true });
    } catch (error) {
        if (await exists(path)) throw error;
    }
    current(scope);
    if (await exists(path)) throw Error('NOAA package cleanup incomplete.');
}
