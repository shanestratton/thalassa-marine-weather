/**
 * vaultFiles — Ship's Documents attachments as files on this phone (126-B3a,
 * binder audit 2026-10-09, DOC-1 and DOC-2).
 *
 * Before 126 a picked paper was read whole into a base64 data: URI and kept
 * in the binder table AND in every queued INSERT/UPDATE of the shared outbox,
 * so each write of any binder rewrote a PDF; the file opened only until the
 * first sync replaced the reference with a cloud one, and never with no signal.
 * Now:
 *
 *   - A picked file is checked (the form's own types), photos are shrunk to a
 *     2000 px JPEG, anything over 25 MiB is refused with its size, and the
 *     rest is written to Library/vault/<identity>/documents/ in ~2 MiB chunks:
 *     no plugin call carries more, and no step holds the whole file as a
 *     string (the 2 GB WebContent ceiling).
 *   - Rows and the outbox carry `local-vault://<path under Library>`, a short
 *     reference SyncService uploads from (readForUpload: the WebView reads the
 *     file, never base64 across the bridge) and replaces with the cloud one.
 *   - A per-identity index (vault/<identity>/index.json) remembers which copy
 *     belongs to which paper after the pull replaces the reference, so the
 *     paper opens at the customs counter in airplane mode. With signal the
 *     cloud's file is asked first: another device may have replaced it at
 *     the same cloud path (126-B3b compares the stored object's stamp).
 *   - Old inline base64 is drained to files once, through LocalDatabase's
 *     rewriteQueuedRecord (outbox first, crash-safe); papers filed while
 *     signed out are taken into the adopting account's own folder; files
 *     nothing refers to, and copies of papers that are gone, are collected
 *     after an hour; account deletion removes the folder.
 *
 * Library, never Data: on iOS @capacitor/filesystem resolves DATA to the
 * Documents folder, which Info.plist shares with the Files app, and passport
 * scans must not be listed under "On My iPhone › Thalassa" (LocalDatabase.ts).
 *
 * Lazy everywhere: DocumentsHub, SyncService, the boot-time drain and account
 * deletion all import() it.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

import { createLogger } from '../../utils/createLogger';
import { docCacheFileName, docFileExtension } from '../../components/vessel/documents/docFiles';
import {
    generateUUID,
    getAll,
    getById,
    getFullQueue,
    getLocalDatabaseSession,
    identityFileToken,
    isLocalDatabaseSessionCurrent,
    rewriteQueuedRecord,
    type LocalDatabaseSession,
} from './LocalDatabase';

const log = createLogger('VaultFiles');

/** A failure's message for the log: a reason, never a paper's name or bytes. */
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : error);

// ── Constants ──────────────────────────────────────────────────

/** A file under Library, on this phone: `local-vault://vault/<token>/documents/p-<uuid>.<ext>`. */
export const LOCAL_VAULT_SCHEME = 'local-vault://';
/**
 * 25 MiB, the vessel_vault bucket's file_size_limit (20261010160000). Every
 * upload crosses the bridge as base64 (CapacitorHttp), so ~33 MiB of string,
 * once; a larger cap waits for a streaming upload.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const VAULT_DIRECTORY = Directory.Library;
const TABLE = 'ship_documents';
/** How a queued payload names an inline file (JSON.stringify writes no spaces). */
const INLINE_MARK = '"file_uri":"data:';

const PHOTO_MAX_EDGE = 2000;
/** Not ProfilePhotoService's avatar retry at 0.5: small print must stay legible. */
const PHOTO_QUALITY = 0.85;
/**
 * A photo larger than this is never decoded to shrink it: its RGBA bitmap
 * alone (4 bytes a pixel) would near WebContent's 2 GB ceiling (a scanned
 * chart of 20000 x 28000 px is 2.2 GB). A 48 MP phone photo is under it.
 */
const PHOTO_MAX_DECODE_PIXELS = 50_000_000;
/** Enough of a file's start for its type and, for a PNG or most JPEGs, its pixel size. */
const HEAD_BYTES = 128 * 1024;
/**
 * Just under 2 MiB per plugin call, in whole 3-byte groups, so every chunk's
 * base64 but the last has no '=' and the chunks join into one valid file.
 */
const CHUNK_BYTES = 699_050 * 3;
/** The same, counted in base64 characters (a multiple of 4). */
const CHUNK_CHARS = (CHUNK_BYTES / 3) * 4;
/** A file picked in a form that is still open is never collected. */
const GC_MIN_AGE_MS = 60 * 60 * 1000;

export type VaultExtension = 'pdf' | 'jpg' | 'png' | 'heic' | 'doc' | 'docx';

/** DocumentForm's `accept` list. */
const ACCEPTED: Readonly<Record<string, VaultExtension>> = {
    pdf: 'pdf',
    jpg: 'jpg',
    jpeg: 'jpg',
    png: 'png',
    heic: 'heic',
    doc: 'doc',
    docx: 'docx',
};
const PHOTOS: ReadonlySet<VaultExtension> = new Set(['jpg', 'png', 'heic']);
/** ISO-BMFF brands of HEIC/HEIF stills (the bytes after 'ftyp'). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

// ── Paths ──────────────────────────────────────────────────────

const vaultRoot = (token: string) => `vault/${token}`;
const documentsFolder = (token: string) => `${vaultRoot(token)}/documents`;
const indexPath = (token: string) => `${vaultRoot(token)}/index.json`;

/**
 * The Library path a `local-vault://` reference names, or null. Only the
 * shape this module writes is accepted, so a reference can never reach
 * outside a vault folder.
 */
export function vaultPathOf(uri: unknown): string | null {
    if (typeof uri !== 'string' || !uri.startsWith(LOCAL_VAULT_SCHEME)) return null;
    const path = uri.slice(LOCAL_VAULT_SCHEME.length);
    return /^vault\/[A-Za-z0-9_]+\/documents\/[A-Za-z0-9_-]+\.[a-z]{2,4}$/.test(path) ? path : null;
}

function extensionOfPath(path: string): VaultExtension {
    return ACCEPTED[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'pdf';
}

function currentScope(): { session: LocalDatabaseSession; token: string } {
    const session = getLocalDatabaseSession();
    return { session, token: identityFileToken(session.identity) };
}

// ── Bytes ──────────────────────────────────────────────────────

/** A slice of a file as base64, read by the WebView (FileReader), never decoded in JS. */
function readBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : '');
        };
        reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
        reader.readAsDataURL(blob);
    });
}

function bytesOfBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * The type a file's first bytes say it is, whatever its name: a PDF named
 * .jpg is a PDF. Null when the bytes say nothing the form takes.
 */
export function sniffExtension(head: Uint8Array, name = ''): VaultExtension | null {
    const starts = (bytes: readonly number[], at = 0) => bytes.every((byte, i) => head[at + i] === byte);
    const text = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
    if (text(0, 4) === '%PDF') return 'pdf';
    if (starts([0xff, 0xd8, 0xff])) return 'jpg';
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (text(4, 8) === 'ftyp' && HEIF_BRANDS.has(text(8, 12))) return 'heic';
    if (starts([0xd0, 0xcf, 0x11, 0xe0])) return 'doc';
    // A zip is a Word file only when it is named as one (Pages and others are zips too).
    if (starts([0x50, 0x4b]) && /\.docx?$/i.test(name)) return 'docx';
    return null;
}

/**
 * Width x height that a PNG's IHDR or a JPEG's frame header gives, from the
 * file's first bytes; null when they do not say (HEIC, or a JPEG whose
 * metadata runs past the head).
 */
function photoPixels(head: Uint8Array): number | null {
    const u16 = (at: number) => (head[at] << 8) | head[at + 1];
    const u32 = (at: number) => u16(at) * 65536 + u16(at + 2);
    if (head[0] === 0x89 && head[1] === 0x50 && head.length >= 24) return u32(16) * u32(20);
    if (head[0] !== 0xff || head[1] !== 0xd8) return null;
    let at = 2;
    while (at + 9 < head.length && head[at] === 0xff) {
        const marker = head[at + 1];
        if (marker === 0xff) {
            at += 1; // a fill byte
            continue;
        }
        // Start of frame (C0-CF bar DHT C4, JPG C8 and DAC CC): length, precision, height, width.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return u16(at + 5) * u16(at + 7);
        }
        if (marker === 0xd9 || marker === 0xda) return null;
        at += 2 + u16(at + 2);
    }
    return null;
}

function extensionOfName(name: string): VaultExtension | null {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? (ACCEPTED[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/**
 * A photo over 2000 px as a 2000 px JPEG (orientation from the image), or null
 * when it is small enough already, cannot be decoded here (an old WebView and
 * HEIC), or would not come out smaller.
 */
async function shrinkPhoto(photo: Blob): Promise<Blob | null> {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    let bitmap: ImageBitmap | null = null;
    try {
        try {
            bitmap = await createImageBitmap(photo, { imageOrientation: 'from-image' });
        } catch (error) {
            // A WebView without the options dictionary; decoding errors are not TypeErrors.
            if (!(error instanceof TypeError)) throw error;
            bitmap = await createImageBitmap(photo);
        }
        const { width, height } = bitmap;
        const longest = Math.max(width, height);
        if (!width || !height || longest <= PHOTO_MAX_EDGE) return null;
        const scale = PHOTO_MAX_EDGE / longest;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) return null;
        // A transparent PNG would otherwise turn black as a JPEG.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const shrunk = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
        // Let WebKit free the backing store now, not at the next GC.
        canvas.width = 0;
        canvas.height = 0;
        return shrunk && shrunk.size > 0 && shrunk.size < photo.size ? shrunk : null;
    } catch {
        return null;
    } finally {
        bitmap?.close?.();
    }
}

async function removeQuietly(path: string): Promise<void> {
    await Filesystem.deleteFile({ path, directory: VAULT_DIRECTORY }).catch(() => undefined);
}

/**
 * Write base64 pieces to one file: the first creates it (and its folders),
 * the rest append. A failure removes what was written.
 */
async function writePieces(
    path: string,
    pieces: AsyncIterable<string>,
): Promise<'ok' | 'read-failed' | 'write-failed'> {
    let started = false;
    const iterator = pieces[Symbol.asyncIterator]();
    for (;;) {
        let next: IteratorResult<string>;
        try {
            next = await iterator.next();
        } catch {
            if (started) await removeQuietly(path);
            return 'read-failed';
        }
        if (next.done) return started ? 'ok' : 'read-failed';
        try {
            if (!started) {
                await Filesystem.writeFile({ path, data: next.value, directory: VAULT_DIRECTORY, recursive: true });
                started = true;
            } else {
                await Filesystem.appendFile({ path, data: next.value, directory: VAULT_DIRECTORY });
            }
        } catch {
            if (started) await removeQuietly(path);
            return 'write-failed';
        }
    }
}

async function* chunksOf(body: Blob): AsyncIterable<string> {
    for (let start = 0; start < body.size; start += CHUNK_BYTES) {
        yield await readBase64(body.slice(start, Math.min(body.size, start + CHUNK_BYTES)));
    }
}

// ── Pick and save ──────────────────────────────────────────────

export type SaveAttachmentFailure = 'unsupported-type' | 'too-large' | 'read-failed' | 'write-failed';

export type SaveAttachmentResult =
    | { ok: true; uri: string; bytes: number; ext: VaultExtension }
    | { ok: false; reason: SaveAttachmentFailure; bytes?: number };

/**
 * Keep a picked file on this phone: checked, a photo shrunk, capped, and
 * written in chunks under this identity's vault folder. The caller owns the
 * reference from here (DocumentsHub files it, or leaves it for the GC).
 */
export async function saveAttachment(
    file: Blob & { name?: string },
    options: { maxBytes?: number } = {},
): Promise<SaveAttachmentResult> {
    const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const name = file.name ?? '';
    // The file input always names the file; its extension must be one the form takes.
    const named = extensionOfName(name);
    if (!named) return { ok: false, reason: 'unsupported-type' };

    let token: string;
    try {
        token = currentScope().token;
    } catch {
        return { ok: false, reason: 'write-failed' };
    }
    // An empty file is an iCloud placeholder that never downloaded, not a paper.
    if (!file.size) return { ok: false, reason: 'read-failed' };

    let ext: VaultExtension;
    let head: Uint8Array;
    try {
        head = bytesOfBase64(await readBase64(file.slice(0, HEAD_BYTES)));
        ext = sniffExtension(head, name) ?? named;
    } catch {
        return { ok: false, reason: 'read-failed' };
    }

    let body: Blob = file;
    if (PHOTOS.has(ext)) {
        // A huge scan is not decoded here (its bitmap could end the app): it is
        // kept as it is when within the cap.
        const pixels = photoPixels(head);
        const shrunk = pixels !== null && pixels > PHOTO_MAX_DECODE_PIXELS ? null : await shrinkPhoto(file);
        if (shrunk) {
            body = shrunk;
            ext = 'jpg';
        }
    }
    if (body.size > maxBytes) return { ok: false, reason: 'too-large', bytes: body.size };

    const path = `${documentsFolder(token)}/p-${generateUUID()}.${ext}`;
    const written = await writePieces(path, chunksOf(body));
    if (written !== 'ok') return { ok: false, reason: written };
    return { ok: true, uri: `${LOCAL_VAULT_SCHEME}${path}`, bytes: body.size, ext };
}

/** Remove a picked file nothing will file (its form or account is gone). */
export async function discardAttachment(uri: string): Promise<void> {
    const path = vaultPathOf(uri);
    if (path) await removeQuietly(path);
}

/**
 * The file behind a `local-vault://` reference, for the upload: read by the
 * WebView from the app's own origin (as MBTilesService does), never as base64
 * through the plugin. A file that is gone throws 'Local attachment missing'.
 */
export async function readForUpload(uri: string): Promise<Blob> {
    const path = vaultPathOf(uri);
    let fileUri: string;
    try {
        if (!path) throw new Error('not a vault path');
        await Filesystem.stat({ path, directory: VAULT_DIRECTORY });
        fileUri = (await Filesystem.getUri({ path, directory: VAULT_DIRECTORY })).uri;
    } catch {
        throw new Error('Local attachment missing');
    }
    const response = await fetch(Capacitor.convertFileSrc(fileUri));
    if (!response.ok) throw new Error(`Could not read local attachment (${response.status})`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('Local attachment was empty or unreadable');
    return blob;
}

// ── The index of copies this phone keeps ──────────────────────

interface IndexEntry {
    /** Library path of the copy. */
    path: string;
    bytes: number;
    savedAt: string;
    /**
     * Where this phone's own upload of this copy went (SyncService), and when.
     * Never proof the cloud still holds this copy: another device can replace
     * the file at the same path.
     */
    remote?: string;
    pushedAt?: string;
    /** The row and stored-object stamps a cloud check confirmed (126-B3b). */
    rowStamp?: string;
    objectStamp?: string;
    /** Over the bucket's cap: kept on this phone only, the row has no file. */
    tooLarge?: boolean;
}

interface VaultIndex {
    version: 1;
    entries: Record<string, IndexEntry>;
}

async function readIndex(token: string): Promise<VaultIndex> {
    const target = indexPath(token);
    // A crash between writing the temporary file and the rename leaves only it.
    for (const candidate of [target, `${target}.tmp`]) {
        try {
            const { data } = await Filesystem.readFile({
                path: candidate,
                directory: VAULT_DIRECTORY,
                encoding: Encoding.UTF8,
            });
            const parsed = JSON.parse(String(data)) as Partial<VaultIndex> | null;
            if (parsed && typeof parsed.entries === 'object' && parsed.entries) {
                return { version: 1, entries: { ...parsed.entries } };
            }
        } catch {
            /* missing or unreadable: try the next */
        }
    }
    return { version: 1, entries: {} };
}

/** Atomic: a temporary file, then a rename over the index. */
async function writeIndex(token: string, index: VaultIndex): Promise<void> {
    const target = indexPath(token);
    const temporary = `${target}.tmp`;
    await Filesystem.writeFile({
        path: temporary,
        data: JSON.stringify(index),
        directory: VAULT_DIRECTORY,
        encoding: Encoding.UTF8,
        recursive: true,
    });
    try {
        await Filesystem.rename({
            from: temporary,
            to: target,
            directory: VAULT_DIRECTORY,
            toDirectory: VAULT_DIRECTORY,
        });
    } catch {
        // A platform that will not rename over a file: the temporary copy is
        // complete, and readIndex falls back to it if this second try fails.
        await removeQuietly(target);
        await Filesystem.rename({
            from: temporary,
            to: target,
            directory: VAULT_DIRECTORY,
            toDirectory: VAULT_DIRECTORY,
        });
    }
}

let indexTail: Promise<unknown> = Promise.resolve();

/** Read, change and write one index, one change at a time; `change` returns how many entries it changed. */
function updateIndex(token: string, change: (entries: Record<string, IndexEntry>) => number): Promise<number> {
    const run = indexTail.then(async () => {
        const index = await readIndex(token);
        const changed = change(index.entries);
        if (changed > 0) await writeIndex(token, index);
        return changed;
    });
    indexTail = run.catch(() => undefined);
    return run;
}

/**
 * Remember that `docId`'s attachment is the vault file `uri` (picked on this
 * phone and filed), or forget it (`uri` null: the attachment was removed).
 */
export async function recordLocalCopy(
    docId: string,
    uri: string | null,
    bytes = 0,
    extra: { tooLarge?: boolean } = {},
): Promise<void> {
    await setIndexEntry(currentScope().token, docId, uri, bytes, extra);
}

async function setIndexEntry(
    token: string,
    docId: string,
    uri: string | null,
    bytes: number,
    extra: { tooLarge?: boolean },
): Promise<void> {
    const path = uri === null ? null : vaultPathOf(uri);
    if (uri !== null && !path) return; // a cloud reference: nothing of this phone's to index
    await updateIndex(token, (entries) => {
        if (!path) {
            if (!entries[docId]) return 0;
            delete entries[docId];
            return 1;
        }
        entries[docId] = {
            path,
            bytes,
            savedAt: new Date().toISOString(),
            ...(extra.tooLarge ? { tooLarge: true } : {}),
        };
        return 1;
    });
}

interface DocRow {
    id: string;
    file_uri?: string | null;
    updated_at?: string;
    user_id?: string | null;
}

/**
 * After this phone uploaded a vault file (SyncService): note where it went on
 * the paper's own entry for that very file (a later pick has replaced it
 * otherwise). Never fails the push.
 */
export async function notePushedCopy(docId: string, uri: string, remote: string): Promise<void> {
    const path = vaultPathOf(uri);
    if (!path) return;
    await updateIndex(path.split('/')[1], (entries) => {
        const entry = entries[docId];
        if (!entry || entry.path !== path) return 0;
        entries[docId] = { ...entry, remote, pushedAt: new Date().toISOString() };
        return 1;
    }).catch((error) => log.warn('documents: index-push-note-failed', reasonOf(error)));
}

export interface LocalCopy {
    /** Library path of the copy. */
    path: string;
    ext: VaultExtension;
    bytes: number;
    /**
     * True when it is the paper's current file: the row names it, or it is
     * kept on this phone only. Any other copy may have been replaced in the
     * cloud by another device, so with signal the cloud is asked first; it is
     * still the best there is with no signal, or when the cloud does not answer.
     */
    fresh: boolean;
}

async function sizeIfPresent(path: string): Promise<number | null> {
    try {
        const info = await Filesystem.stat({ path, directory: VAULT_DIRECTORY });
        return info.type === 'directory' ? null : info.size;
    } catch {
        return null;
    }
}

/**
 * The copy of a paper on this phone, if any: the file its row names, else
 * this identity's index entry. Null when there is none.
 */
export async function localCopyFor(doc: DocRow): Promise<LocalCopy | null> {
    let token: string;
    try {
        token = currentScope().token;
    } catch {
        return null;
    }
    const own = vaultPathOf(doc.file_uri);
    if (own) {
        const bytes = await sizeIfPresent(own);
        if (bytes !== null) return { path: own, ext: extensionOfPath(own), bytes, fresh: true };
    }
    const entry = (await readIndex(token)).entries[doc.id];
    if (!entry || !vaultPathOf(`${LOCAL_VAULT_SCHEME}${entry.path}`)) return null;
    const bytes = await sizeIfPresent(entry.path);
    if (bytes === null) return null;
    return {
        path: entry.path,
        ext: extensionOfPath(entry.path),
        bytes,
        fresh: entry.tooLarge === true && !doc.file_uri,
    };
}

/** Ids of papers kept on this phone only (over the cap; their rows have no file). */
export async function phoneOnlyCopies(): Promise<Set<string>> {
    const { token } = currentScope();
    const entries = (await readIndex(token)).entries;
    return new Set(Object.keys(entries).filter((id) => entries[id].tooLarge === true));
}

/**
 * Copy a paper's file into a share sheet's Cache folder, named by 126-B1's
 * rule (`<name>-<id8>.<ext>`), natively: no byte of it passes through JS.
 * The share sheet and the Cache clean-up after it are DocumentsHub's
 * (presentDocFile). Returns the copy's file URI.
 */
export async function openLocalCopy(
    copy: LocalCopy,
    doc: { id: string; document_name: string },
    folder: string,
): Promise<string> {
    await Filesystem.mkdir({ path: folder, directory: Directory.Cache, recursive: true }).catch(() => undefined);
    const { uri } = await Filesystem.copy({
        from: copy.path,
        directory: VAULT_DIRECTORY,
        to: `${folder}/${docCacheFileName(doc.document_name, doc.id, copy.ext)}`,
        toDirectory: Directory.Cache,
    });
    return uri;
}

// ── Drain: old inline base64 to files, once ────────────────────

export interface DrainOutcome {
    /** Inline files moved to the vault. */
    moved: number;
    /** Of those, over the cap: kept on this phone, the row's file is null. */
    keptLocal: number;
    /** Left for the next launch (being pushed, or a write that failed). */
    skipped: number;
}

const isInline = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:');

/** Identities whose drain finished in this launch: the GC may read their queue. */
const drainedThisLaunch = new Set<string>();
let drainRun: { token: string; promise: Promise<DrainOutcome> } | null = null;

/**
 * Move every attachment an older build kept inline (a base64 data: URI in a
 * ship_documents row or queued payload) to a vault file, and point the row
 * and every payload at it. Idempotent: the fast path is a prefix scan with no
 * writes. Over 25 MiB the copy stays on this phone (index `tooLarge`) and the
 * row and payloads lose the file, so the paper's details still sync and the
 * upload can never be refused by the bucket forever.
 */
export function drainInlineAttachments(): Promise<DrainOutcome> {
    let scope: { session: LocalDatabaseSession; token: string };
    try {
        scope = currentScope();
    } catch (error) {
        return Promise.reject(error);
    }
    if (drainRun && drainRun.token === scope.token) return drainRun.promise;
    const promise: Promise<DrainOutcome> = runDrain(scope)
        .then((outcome) => {
            drainedThisLaunch.add(scope.token);
            return outcome;
        })
        .finally(() => {
            if (drainRun?.promise === promise) drainRun = null;
        });
    drainRun = { token: scope.token, promise };
    return promise;
}

async function runDrain({ session, token }: { session: LocalDatabaseSession; token: string }): Promise<DrainOutcome> {
    const outcome: DrainOutcome = { moved: 0, keptLocal: 0, skipped: 0 };
    const rows = getAll<DocRow>(TABLE).filter((row) => isInline(row.file_uri));
    const queued = getFullQueue().filter(
        (item) =>
            item.table_name === TABLE &&
            (item.mutation_type === 'INSERT' || item.mutation_type === 'UPDATE') &&
            item.payload.includes(INLINE_MARK),
    );
    if (rows.length === 0 && queued.length === 0) return outcome;

    let notBase64 = 0;
    const recordIds = [...new Set([...queued.map((item) => item.record_id), ...rows.map((row) => row.id)])];
    for (const id of recordIds) {
        if (!isLocalDatabaseSessionCurrent(session)) break;
        const row = rows.find((candidate) => candidate.id === id);
        // Each distinct inline file of this paper, the row's current one last
        // so it is the copy the index keeps.
        const inline = new Set<string>();
        for (const item of queued) {
            if (item.record_id !== id) continue;
            try {
                const value = (JSON.parse(item.payload) as { file_uri?: unknown }).file_uri;
                if (isInline(value)) inline.add(value);
            } catch {
                /* a payload that does not parse is left as it is */
            }
        }
        if (row && isInline(row.file_uri)) {
            inline.delete(row.file_uri);
            inline.add(row.file_uri);
        }
        for (const dataUri of inline) {
            if (!isLocalDatabaseSessionCurrent(session)) break;
            const moved = await drainOne(session, token, id, dataUri, row?.file_uri === dataUri);
            if (moved === 'not-base64') notBase64 += 1;
            else if (moved === 'skipped') outcome.skipped += 1;
            else {
                outcome.moved += 1;
                if (moved === 'kept-local') outcome.keptLocal += 1;
            }
        }
    }
    if (outcome.moved > 0) {
        log.warn(`documents: drained ${outcome.moved} attachments (${outcome.keptLocal} kept on this phone only)`);
    }
    if (notBase64 > 0) log.warn(`documents: left ${notBase64} inline attachments that are not base64`);
    if (outcome.skipped > 0) log.warn(`documents: ${outcome.skipped} inline attachments wait for the next launch`);
    return outcome;
}

async function drainOne(
    session: LocalDatabaseSession,
    token: string,
    id: string,
    dataUri: string,
    rowHasIt: boolean,
): Promise<'moved' | 'kept-local' | 'not-base64' | 'skipped'> {
    const comma = dataUri.indexOf(',');
    const header = comma > 0 ? dataUri.slice(5, comma) : '';
    const length = dataUri.length - comma - 1;
    if (comma < 0 || !/;base64$/i.test(header) || length <= 0 || length % 4 !== 0) return 'not-base64';
    const padding = dataUri.endsWith('==') ? 2 : dataUri.endsWith('=') ? 1 : 0;
    const bytes = (length / 4) * 3 - padding;

    let ext: VaultExtension;
    try {
        ext =
            sniffExtension(bytesOfBase64(dataUri.slice(comma + 1, comma + 17))) ??
            ACCEPTED[docFileExtension(dataUri)] ??
            'pdf';
    } catch {
        return 'not-base64';
    }

    // An older file only a queued payload still names (the row has moved
    // on), over the cap: it can never upload, and nothing here shows it.
    const tooLarge = bytes > MAX_ATTACHMENT_BYTES;
    const keepFile = !tooLarge || rowHasIt;
    let next: string | null = null;
    let indexed: string | null = null;
    if (keepFile) {
        // The base64 goes to the file as it is, in 4-character-aligned slices.
        const path = `${documentsFolder(token)}/p-${generateUUID()}.${ext}`;
        const slices = (async function* () {
            for (let start = comma + 1; start < dataUri.length; start += CHUNK_CHARS) {
                const slice = dataUri.slice(start, Math.min(dataUri.length, start + CHUNK_CHARS));
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(slice)) throw new Error('not base64');
                yield slice;
            }
        })();
        const written = await writePieces(path, slices);
        if (written === 'read-failed') return 'not-base64';
        if (written !== 'ok') {
            log.warn('documents: drain-write-failed');
            return 'skipped';
        }
        const uri = `${LOCAL_VAULT_SCHEME}${path}`;
        next = tooLarge ? null : uri;
        // The index names the paper's CURRENT file (the row's), and first: a
        // copy kept on this phone only is named nowhere else. A file only a
        // queued payload names is kept by that payload until it uploads. Only
        // while the row still holds this inline file: a paper re-filed while
        // this was written keeps its new file.
        if (rowHasIt) {
            try {
                const set = await updateIndex(token, (entries) => {
                    if (!isLocalDatabaseSessionCurrent(session)) return 0;
                    if (getById<DocRow>(TABLE, id)?.file_uri !== dataUri) return 0;
                    entries[id] = { path, bytes, savedAt: new Date().toISOString(), ...(tooLarge ? { tooLarge } : {}) };
                    return 1;
                });
                if (set > 0) indexed = path;
            } catch (error) {
                log.warn('documents: drain-index-failed', reasonOf(error));
                return 'skipped';
            }
        }
    }
    let rowMoved = false;
    try {
        if (!isLocalDatabaseSessionCurrent(session)) throw new Error('the database changed hands');
        const outcome = await rewriteQueuedRecord(
            TABLE,
            id,
            (payload, item) => {
                if (payload.file_uri !== dataUri) return payload;
                if (next !== null || item.mutation_type === 'INSERT') return { ...payload, file_uri: next };
                // An UPDATE over the cap leaves the server's file as it is: its
                // INSERT may have uploaded that very file, and a null here would
                // delete it (reconcileVaultObjects). An INSERT never overwrites.
                const rest = { ...payload };
                delete rest.file_uri;
                return rest;
            },
            // Read inside the write, so an edit saved meanwhile is never undone.
            rowHasIt ? (current) => (current.file_uri === dataUri ? { file_uri: next } : null) : null,
        );
        rowMoved = outcome.row;
    } catch (error) {
        // Being pushed right now: that push carries it, or the next launch moves it.
        log.warn('documents: drain-deferred', reasonOf(error));
        return 'skipped';
    } finally {
        // The row moved on (or the rewrite waits): the index must not name this file for it.
        if (indexed && !rowMoved) await forgetIndexedPath(token, id, indexed);
    }
    return tooLarge && rowMoved ? 'kept-local' : 'moved';
}

/** Drop `docId`'s entry only if it still names `path` (a newer pick wins). */
async function forgetIndexedPath(token: string, docId: string, path: string): Promise<void> {
    await updateIndex(token, (entries) => {
        if (entries[docId]?.path !== path) return 0;
        delete entries[docId];
        return 1;
    }).catch((error) => log.warn('documents: index-forget-failed', reasonOf(error)));
}

// ── Papers filed while signed out ──────────────────────────────

/**
 * The signed-out vault files of papers this account adopted at sign-in
 * (LocalDatabase's migrateAnonymousScope copies rows and the outbox, never
 * files), by paper: each one its row, queued payloads or the signed-out index
 * names. Only the account's own papers, never a shared skipper's.
 */
async function adoptedAnonymousFiles(identity: string | null): Promise<Map<string, Set<string>>> {
    const anonymousRoot = `${vaultRoot(identityFileToken(null))}/`;
    const byDoc = new Map<string, Set<string>>();
    const add = (id: string, path: string | null | undefined) => {
        if (path && path.startsWith(anonymousRoot)) byDoc.set(id, (byDoc.get(id) ?? new Set<string>()).add(path));
    };
    const owners = new Map<string, unknown>();
    for (const row of getAll<DocRow>(TABLE)) {
        owners.set(row.id, row.user_id);
        if (!row.user_id || row.user_id === identity) add(row.id, vaultPathOf(row.file_uri));
    }
    const isOwn = (id: string) => {
        const owner = owners.get(id);
        return !owner || owner === identity;
    };
    for (const item of getFullQueue()) {
        if (item.table_name !== TABLE || !isOwn(item.record_id)) continue;
        if (!item.payload.includes(`${LOCAL_VAULT_SCHEME}${anonymousRoot}`)) continue;
        try {
            add(item.record_id, vaultPathOf((JSON.parse(item.payload) as { file_uri?: unknown }).file_uri));
        } catch {
            /* unparseable: names nothing */
        }
    }
    const entries = (await readIndex(identityFileToken(null))).entries;
    for (const [id, entry] of Object.entries(entries)) {
        if ((owners.has(id) || byDoc.has(id)) && isOwn(id)) add(id, entry.path);
    }
    return byDoc;
}

/**
 * Take this account's adopted signed-out papers into its own folder: each
 * file copied natively, its row and queued payloads re-pointed (outbox
 * first), its index entry moved, then the signed-out copy removed. From then
 * on the account's own tidy and its deletion cover them. A paper being pushed
 * waits for the next tidy.
 */
async function adoptAnonymousCopies({ session, token }: { session: LocalDatabaseSession; token: string }) {
    const anonymous = identityFileToken(null);
    if (token === anonymous) return;
    const anonymousEntries = (await readIndex(anonymous)).entries;
    for (const [docId, paths] of await adoptedAnonymousFiles(session.identity)) {
        if (!isLocalDatabaseSessionCurrent(session)) return;
        const moved = new Map<string, string>();
        const gone = new Set<string>();
        for (const from of paths) {
            const to = `${vaultRoot(token)}${from.slice(vaultRoot(anonymous).length)}`;
            const source = await sizeIfPresent(from);
            const copied = await sizeIfPresent(to);
            if (source === null && copied === null) {
                gone.add(from);
                continue;
            }
            try {
                // A whole copy from an earlier try is the same file (names are unique).
                if (source !== null && copied !== source) {
                    await removeQuietly(to);
                    await Filesystem.copy({ from, to, directory: VAULT_DIRECTORY, toDirectory: VAULT_DIRECTORY });
                }
                moved.set(`${LOCAL_VAULT_SCHEME}${from}`, `${LOCAL_VAULT_SCHEME}${to}`);
            } catch (error) {
                log.warn('documents: adopt-copy-failed', reasonOf(error));
            }
        }
        if (moved.size > 0) {
            try {
                if (!isLocalDatabaseSessionCurrent(session)) return;
                await rewriteQueuedRecord(
                    TABLE,
                    docId,
                    (payload) => {
                        const to = moved.get(payload.file_uri as string);
                        return to ? { ...payload, file_uri: to } : payload;
                    },
                    (row) => {
                        const to = moved.get(row.file_uri as string);
                        return to ? { file_uri: to } : null;
                    },
                );
            } catch (error) {
                // Being pushed right now: the next tidy takes it across; the copies made go to the GC.
                log.warn('documents: adopt-deferred', reasonOf(error));
                continue;
            }
        }
        const entry = anonymousEntries[docId];
        const entryTo = entry ? vaultPathOf(moved.get(`${LOCAL_VAULT_SCHEME}${entry.path}`)) : null;
        if (entryTo && entry) {
            await updateIndex(token, (entries) => {
                if (entries[docId]) return 0; // the account's own pick is newer
                entries[docId] = { ...entry, path: entryTo };
                return 1;
            });
        }
        if (entry && (entryTo || gone.has(entry.path))) await forgetIndexedPath(anonymous, docId, entry.path);
        for (const from of paths) if (moved.has(`${LOCAL_VAULT_SCHEME}${from}`)) await removeQuietly(from);
    }
}

/** Account deletion: remove the adopted signed-out copies outright, and their entries. */
async function discardAdoptedAnonymousCopies(identity: string): Promise<void> {
    const anonymous = identityFileToken(null);
    for (const [docId, paths] of await adoptedAnonymousFiles(identity)) {
        for (const path of paths) {
            await removeQuietly(path);
            if ((await sizeIfPresent(path)) !== null) {
                throw new Error('A signed-out Documents file could not be removed');
            }
        }
        await updateIndex(anonymous, (entries) => {
            if (!entries[docId] || !paths.has(entries[docId].path)) return 0;
            delete entries[docId];
            return 1;
        });
    }
}

// ── Collect files nothing refers to ────────────────────────────

/**
 * Delete this identity's vault files that no ship_documents row, queued
 * ship_documents payload or index entry names, and only when older than an
 * hour, so a file picked in a form that is still open is never collected.
 * The index forgets papers that are gone (deleted here or on another device,
 * or pruned from a shared binder), an hour on, so their copies go too.
 * Signed in, adopted signed-out papers are taken across first. Never before
 * this launch's drain has finished: until then a queued payload can still
 * hold megabytes of base64. Returns how many files went.
 */
export async function gcVaultFiles(options: { now?: number } = {}): Promise<number> {
    let scope: { session: LocalDatabaseSession; token: string };
    try {
        scope = currentScope();
        if (!drainedThisLaunch.has(scope.token)) await drainInlineAttachments();
    } catch (error) {
        log.warn('documents: drain-failed', reasonOf(error));
        return 0;
    }
    if (!isLocalDatabaseSessionCurrent(scope.session)) return 0;
    const signedOut = scope.token === identityFileToken(null);
    if (!signedOut) {
        await adoptAnonymousCopies(scope).catch((error) => log.warn('documents: adopt-failed', reasonOf(error)));
        if (!isLocalDatabaseSessionCurrent(scope.session)) return 0;
    }

    const folder = documentsFolder(scope.token);
    let listing: { name: string; type: string; mtime?: number }[];
    try {
        listing = (await Filesystem.readdir({ path: folder, directory: VAULT_DIRECTORY })).files;
    } catch {
        return 0; // no folder: nothing was ever picked here
    }

    const keep = new Set<string>();
    const live = new Set<string>();
    try {
        for (const row of getAll<DocRow>(TABLE)) {
            live.add(row.id);
            const path = vaultPathOf(row.file_uri);
            if (path) keep.add(path);
        }
        for (const item of getFullQueue()) {
            // Only Documents payloads, and only those that can name a vault file.
            if (item.table_name !== TABLE || (item.mutation_type !== 'INSERT' && item.mutation_type !== 'UPDATE')) {
                continue;
            }
            live.add(item.record_id);
            if (!item.payload.includes(LOCAL_VAULT_SCHEME)) continue;
            try {
                const path = vaultPathOf((JSON.parse(item.payload) as { file_uri?: unknown }).file_uri);
                if (path) keep.add(path);
            } catch {
                /* unparseable: names nothing */
            }
        }
    } catch {
        return 0; // the database changed hands
    }

    const now = options.now ?? Date.now();
    // Signed out, a row goes only when it is deleted here (Documents forgets
    // its copy then) or adopted by an account, which takes the copy across:
    // so there the index is never pruned.
    let indexed: IndexEntry[] = [];
    await updateIndex(scope.token, (entries) => {
        let dropped = 0;
        if (!signedOut && isLocalDatabaseSessionCurrent(scope.session)) {
            for (const [id, entry] of Object.entries(entries)) {
                if (live.has(id) || !(now - Date.parse(entry.savedAt) >= GC_MIN_AGE_MS)) continue;
                delete entries[id];
                dropped += 1;
            }
        }
        indexed = Object.values(entries);
        return dropped;
    });
    for (const entry of indexed) keep.add(entry.path);

    let removed = 0;
    for (const file of listing) {
        if (file.type === 'directory') continue;
        const path = `${folder}/${file.name}`;
        if (keep.has(path)) continue;
        if (typeof file.mtime !== 'number' || now - file.mtime < GC_MIN_AGE_MS) continue;
        if (!isLocalDatabaseSessionCurrent(scope.session)) break;
        try {
            await Filesystem.deleteFile({ path, directory: VAULT_DIRECTORY });
            removed += 1;
        } catch (error) {
            log.warn('documents: gc-delete-failed', reasonOf(error));
        }
    }
    return removed;
}

/** At launch, once the sync engine runs (useAppBootstrap, on idle): drain, then collect. */
export async function tidyVaultAfterLaunch(): Promise<void> {
    try {
        await drainInlineAttachments();
    } catch (error) {
        log.warn('documents: drain-failed', reasonOf(error));
        return;
    }
    await gcVaultFiles();
}

// ── Account deletion ───────────────────────────────────────────

/**
 * Remove a deleted account's vault folder (its papers and index), never
 * another's, and any papers it adopted from the signed-out scope that its
 * tidy has not taken across yet (readable only while its binder database is
 * still the open one; account deletion runs this before purging it).
 */
export async function purgeVaultFilesForUser(userId: string): Promise<void> {
    const identity = typeof userId === 'string' ? userId.trim() : '';
    if (!identity) throw new Error('A user id is required to purge Documents files');
    const root = vaultRoot(identityFileToken(identity));
    let failure: unknown = null;
    try {
        await Filesystem.rmdir({ path: root, directory: VAULT_DIRECTORY, recursive: true });
    } catch (error) {
        // Nothing there is nothing to remove; anything still there is a failure.
        if (
            await Filesystem.stat({ path: root, directory: VAULT_DIRECTORY }).then(
                () => true,
                () => false,
            )
        ) {
            failure = error;
        }
    }
    let session: LocalDatabaseSession | null = null;
    try {
        session = getLocalDatabaseSession();
    } catch {
        session = null; // between databases: not this account's any more
    }
    if (session && session.identity === identity && isLocalDatabaseSessionCurrent(session)) {
        await discardAdoptedAnonymousCopies(identity).catch((error) => {
            failure ??= error;
        });
    }
    if (failure) throw failure;
}
