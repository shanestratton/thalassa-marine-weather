/**
 * diaryPhotoStore — Durable offline storage for diary photo blobs.
 *
 * IndexedDB can store Blob objects natively (no base64 round-trip) with
 * a quota in the 100MB–1GB range on iOS WKWebView and modern browsers.
 * This replaces the in-memory Map that lost photos across app suspends,
 * and avoids the ~5MB localStorage quota problem with data: URIs.
 *
 * Photo keys are opaque strings the service generates; the entry stores
 * these keys as `idb:<uuid>`-prefixed references. On sync, we read the
 * Blob back, upload it to Supabase Storage, then delete the local copy.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('diaryPhotoStore');

const DB_NAME = 'thalassa-diary';
const DB_VERSION = 2;
const PHOTO_STORE = 'photos';
const AUDIO_STORE = 'audio';

/** URL prefix used in DiaryEntry.photos[] to reference an IndexedDB blob. */
export const IDB_PHOTO_PREFIX = 'idb:';
/** URL prefix used in DiaryEntry.audio_url for an IndexedDB voice memo. */
export const IDB_AUDIO_PREFIX = 'idb-audio:';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB not available'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
            if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _dbPromise;
}

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const trans = db.transaction(storeName, mode);
                const store = trans.objectStore(storeName);
                const req = fn(store);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }),
    );
}

function genKey(prefix: string): string {
    // Short random key — IndexedDB keys don't need global uniqueness, just
    // uniqueness within this store. 10 random chars = ~60 bits entropy.
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/** Returns true when the ref points to a blob in our IndexedDB store. */
export function isIdbPhoto(ref: string): boolean {
    return ref.startsWith(IDB_PHOTO_PREFIX);
}

/**
 * Persist a photo Blob to IndexedDB. Returns an opaque reference string
 * (`idb:xxx`) suitable for storing in a DiaryEntry.photos[] array.
 */
export async function savePhoto(blob: Blob): Promise<string> {
    const key = genKey(IDB_PHOTO_PREFIX);
    await tx(PHOTO_STORE, 'readwrite', (store) => store.put(blob, key));
    return key;
}

/** Read a photo Blob by its reference. Returns null if not found. */
export async function loadPhoto(ref: string): Promise<Blob | null> {
    if (!isIdbPhoto(ref)) return null;
    try {
        const blob = await tx<Blob | undefined>(PHOTO_STORE, 'readonly', (store) => store.get(ref));
        return blob ?? null;
    } catch (e) {
        log.warn('loadPhoto failed:', e);
        return null;
    }
}

/** Delete a photo by reference. Idempotent. */
export async function deletePhoto(ref: string): Promise<void> {
    if (!isIdbPhoto(ref)) return;
    try {
        await tx(PHOTO_STORE, 'readwrite', (store) => store.delete(ref));
    } catch (e) {
        log.warn('deletePhoto failed:', e);
    }
}

/**
 * Produce a short-lived blob: URL for displaying an IDB photo in an <img>.
 * Caller is responsible for URL.revokeObjectURL() when the element unmounts,
 * though a leaked URL is only as heavy as the blob pointer (bytes aren't
 * duplicated).
 */
export async function toBlobUrl(ref: string): Promise<string | null> {
    const blob = await loadPhoto(ref);
    return blob ? URL.createObjectURL(blob) : null;
}

/** Returns true when the ref points to a voice memo in our IndexedDB store. */
export function isIdbAudio(ref: string): boolean {
    return ref.startsWith(IDB_AUDIO_PREFIX);
}

/** Persist a voice-memo Blob without putting base64 audio into localStorage. */
export async function saveAudio(blob: Blob): Promise<string> {
    const key = genKey(IDB_AUDIO_PREFIX);
    await tx(AUDIO_STORE, 'readwrite', (store) => store.put(blob, key));
    return key;
}

/** Read a voice-memo Blob by its opaque IndexedDB reference. */
export async function loadAudio(ref: string): Promise<Blob | null> {
    if (!isIdbAudio(ref)) return null;
    try {
        const blob = await tx<Blob | undefined>(AUDIO_STORE, 'readonly', (store) => store.get(ref));
        return blob ?? null;
    } catch (e) {
        log.warn('loadAudio failed:', e);
        return null;
    }
}

/** Delete a voice memo by reference. Idempotent. */
export async function deleteAudio(ref: string): Promise<void> {
    if (!isIdbAudio(ref)) return;
    try {
        await tx(AUDIO_STORE, 'readwrite', (store) => store.delete(ref));
    } catch (e) {
        log.warn('deleteAudio failed:', e);
    }
}
