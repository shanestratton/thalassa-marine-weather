/**
 * The phone's own copy of every sighting: an IndexedDB outbox that works at
 * sea and syncs later (sightingSync). Modelled on services/diaryPhotoStore.ts.
 *
 * Database 'thalassa-sightings' v1:
 *   - sightings: one LocalSighting per id (keyPath 'id'), stamped with the
 *     account that logged it (ownerUserId; null = logged signed out). Reads
 *     return only the current account's records: another account on the same
 *     phone never sees them.
 *   - photos: the stripped JPEGs, by opaque key.
 *   - meta: small per-account values (the crew feed cache, the last
 *     visibility per group), keyed '<account>|<name>'.
 *
 * Where IndexedDB is missing (old WebViews, tests) a memory store stands in
 * for the session.
 */
import { clearSightingsOutboxFlag, flagSightingsOutbox } from './outboxFlag';
import type { LocalSighting } from './types';

export interface SightingStoreBackend {
    getAll(): Promise<LocalSighting[]>;
    get(id: string): Promise<LocalSighting | null>;
    put(record: LocalSighting): Promise<void>;
    delete(id: string): Promise<void>;
    putBlob(key: string, blob: Blob): Promise<void>;
    getBlob(key: string): Promise<Blob | null>;
    deleteBlob(key: string): Promise<void>;
    getMeta(key: string): Promise<unknown>;
    putMeta(key: string, value: unknown): Promise<void>;
    deleteMeta(key: string): Promise<void>;
    metaKeys(): Promise<string[]>;
}

const DB_NAME = 'thalassa-sightings';
const DB_VERSION = 1;
const RECORDS = 'sightings';
const PHOTOS = 'photos';
const META = 'meta';

function idbBackend(): SightingStoreBackend {
    let dbPromise: Promise<IDBDatabase> | null = null;
    const open = (): Promise<IDBDatabase> => {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS);
                if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch((error: unknown) => {
            dbPromise = null;
            throw error;
        });
        return dbPromise;
    };
    const run = <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> =>
        open().then(
            (db) =>
                new Promise<T>((resolve, reject) => {
                    const tx = db.transaction(store, mode);
                    const req = fn(tx.objectStore(store));
                    let result: T;
                    req.onsuccess = () => {
                        result = req.result as T;
                    };
                    // Resolve on commit, so a write is durable before the caller moves on.
                    tx.oncomplete = () => resolve(result);
                    tx.onerror = () => reject(tx.error ?? req.error);
                    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
                }),
        );
    return {
        getAll: () => run<LocalSighting[]>(RECORDS, 'readonly', (s) => s.getAll()).then((rows) => rows ?? []),
        get: (id) => run<LocalSighting | undefined>(RECORDS, 'readonly', (s) => s.get(id)).then((r) => r ?? null),
        put: (record) => run<void>(RECORDS, 'readwrite', (s) => s.put(record)),
        delete: (id) => run<void>(RECORDS, 'readwrite', (s) => s.delete(id)),
        putBlob: (key, blob) => run<void>(PHOTOS, 'readwrite', (s) => s.put(blob, key)),
        getBlob: (key) => run<Blob | undefined>(PHOTOS, 'readonly', (s) => s.get(key)).then((b) => b ?? null),
        deleteBlob: (key) => run<void>(PHOTOS, 'readwrite', (s) => s.delete(key)),
        getMeta: (key) => run<unknown>(META, 'readonly', (s) => s.get(key)),
        putMeta: (key, value) => run<void>(META, 'readwrite', (s) => s.put(value, key)),
        deleteMeta: (key) => run<void>(META, 'readwrite', (s) => s.delete(key)),
        metaKeys: () =>
            run<IDBValidKey[]>(META, 'readonly', (s) => s.getAllKeys()).then((keys) =>
                (keys ?? []).filter((k): k is string => typeof k === 'string'),
            ),
    };
}

/** A session-only store: tests, and WebViews without IndexedDB. */
export function memoryBackend(): SightingStoreBackend {
    const records = new Map<string, LocalSighting>();
    const blobs = new Map<string, Blob>();
    const meta = new Map<string, unknown>();
    const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
    return {
        getAll: async () => [...records.values()].map(clone),
        get: async (id) => clone(records.get(id) ?? null),
        put: async (record) => {
            records.set(record.id, clone(record));
        },
        delete: async (id) => {
            records.delete(id);
        },
        putBlob: async (key, blob) => {
            blobs.set(key, blob);
        },
        getBlob: async (key) => blobs.get(key) ?? null,
        deleteBlob: async (key) => {
            blobs.delete(key);
        },
        getMeta: async (key) => clone(meta.get(key)),
        putMeta: async (key, value) => {
            meta.set(key, clone(value));
        },
        deleteMeta: async (key) => {
            meta.delete(key);
        },
        metaKeys: async () => [...meta.keys()],
    };
}

let backend: SightingStoreBackend | null = null;

function store(): SightingStoreBackend {
    if (!backend) backend = typeof indexedDB === 'undefined' ? memoryBackend() : idbBackend();
    return backend;
}

/** Test seam: swap the backend (pass null to go back to the default). */
export function setSightingStoreBackend(next: SightingStoreBackend | null): void {
    backend = next;
}

// ── change notice ──────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let noticePending = false;

/** Tell the screens a record changed (batched to one notice per tick). */
function notifyRecordsChanged(): void {
    if (noticePending || listeners.size === 0) return;
    noticePending = true;
    queueMicrotask(() => {
        noticePending = false;
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                /* a screen's refresh must never break a write */
            }
        }
    });
}

/**
 * Called after any sighting is saved or removed on this phone (the sheet's
 * tap, a sync round, a pull). The screens re-read; nothing is passed, so a
 * listener can never see another account's record.
 */
export function subscribeSightingRecords(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The account key records and meta are filed under. */
export function accountKey(userId: string | null): string {
    return userId ? `user:${userId}` : 'anonymous';
}

/** Every record logged by this account on this phone (null = signed out), newest event first. */
export async function listLocalSightings(userId: string | null): Promise<LocalSighting[]> {
    const all = await store().getAll();
    return all
        .filter((record) => record.ownerUserId === userId)
        .sort((a, b) => (a.row.event_date < b.row.event_date ? 1 : a.row.event_date > b.row.event_date ? -1 : 0));
}

/** Every record on the phone, any account: for the outbox only. */
export async function listAllLocalSightings(): Promise<LocalSighting[]> {
    return store().getAll();
}

/** One record, only if it belongs to this account. */
export async function getLocalSighting(id: string, userId: string | null): Promise<LocalSighting | null> {
    const record = await store().get(id);
    return record && record.ownerUserId === userId ? record : null;
}

export async function putLocalSighting(record: LocalSighting): Promise<void> {
    await store().put(record);
    // Waiting to send: app start drains it even if Sightings never opens.
    if (record.ownerUserId && record.sync.op && (record.sync.state === 'pending' || record.sync.state === 'held')) {
        flagSightingsOutbox(record.ownerUserId);
    }
    notifyRecordsChanged();
}

/** Remove a record and its photo blobs. */
export async function deleteLocalSighting(record: LocalSighting): Promise<void> {
    for (const photo of record.photos) {
        if (photo.blobKey) await store().deleteBlob(photo.blobKey);
    }
    await store().delete(record.id);
    notifyRecordsChanged();
}

function newKey(): string {
    const random =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `sighting-photo:${random}`;
}

export async function savePhotoBlob(blob: Blob): Promise<string> {
    const key = newKey();
    await store().putBlob(key, blob);
    return key;
}

export async function loadPhotoBlob(key: string): Promise<Blob | null> {
    try {
        return await store().getBlob(key);
    } catch {
        return null;
    }
}

export async function deletePhotoBlob(key: string): Promise<void> {
    try {
        await store().deleteBlob(key);
    } catch {
        /* idempotent */
    }
}

export async function getSightingMeta<T>(userId: string | null, name: string): Promise<T | null> {
    try {
        const value = await store().getMeta(`${accountKey(userId)}|${name}`);
        return (value ?? null) as T | null;
    } catch {
        return null;
    }
}

export async function putSightingMeta(userId: string | null, name: string, value: unknown): Promise<void> {
    try {
        await store().putMeta(`${accountKey(userId)}|${name}`, value);
    } catch {
        /* a cache: losing it is harmless */
    }
}

/**
 * Account deletion: every sighting this account logged on this phone, their
 * photos and its meta (crew feed cache, defaults). Signed-out records are not
 * the account's and stay. Tries everything, then THROWS if anything could
 * not be removed, so deleteCurrentAccount reports the local cleanup as
 * incomplete instead of claiming exact positions are gone when they are not.
 */
export async function purgeSightingsForUser(userId: string): Promise<number> {
    let removed = 0;
    let failure: unknown = null;
    clearSightingsOutboxFlag(userId);
    try {
        const s = store();
        for (const record of await s.getAll()) {
            if (record.ownerUserId !== userId) continue;
            try {
                await deleteLocalSighting(record);
                removed += 1;
            } catch (error) {
                failure ??= error;
            }
        }
        const prefix = `${accountKey(userId)}|`;
        for (const key of await s.metaKeys()) {
            if (!key.startsWith(prefix)) continue;
            try {
                await s.deleteMeta(key);
            } catch (error) {
                failure ??= error;
            }
        }
    } catch (error) {
        failure ??= error;
    }
    if (removed > 0) notifyRecordsChanged();
    if (failure) {
        throw new Error(`Some sightings could not be removed from this phone: ${String(failure)}`);
    }
    return removed;
}
