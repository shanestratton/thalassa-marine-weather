/**
 * Account-scoped local-first cache for recorded voyage tracks.
 *
 * Track payloads are large files while the small LRU index lives in
 * Preferences. Both layers include the immutable account owner. Historical
 * v1/v2 cache data was globally keyed and carried no trustworthy owner, so it
 * is deliberately not migrated: privacy wins over a one-time cache miss.
 */
import { Preferences } from '@capacitor/preferences';
import type { ShipLogEntry } from '../../types';
import { saveLargeData, loadLargeData, deleteLargeData } from '../nativeStorage';
import { createLogger } from '../../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';

const log = createLogger('VoyageTrackCache');

const INDEX_KEY = 'thalassa_voyage_track_index_v3';
const CACHE_VERSION = 3;
/** How many voyages' tracks to keep before evicting the least recently used. */
export const MAX_CACHED_VOYAGES = 8;
/** ~4 MB guard per voyage — skip pathologically large tracks. */
const MAX_BYTES = 4_000_000;

interface CachedTrack {
    version: typeof CACHE_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    voyageId: string;
    at: number;
    entries: ShipLogEntry[];
}

interface IndexRow {
    voyageId: string;
    at: number;
    points: number;
}

interface CacheIndex {
    version: typeof CACHE_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    rows: IndexRow[];
}

const operationTails = new Map<string, Promise<void>>();

/** Collision-free filename token using Unicode code points only. */
function fileToken(value: string): string {
    return Array.from(value, (char) => char.codePointAt(0)!.toString(16)).join('-');
}

/** Filesystem key for one account's voyage payload. */
function trackKey(voyageId: string, scope: AuthIdentityScope): string {
    return `thalassa_track_v3_${fileToken(scope.key)}_${fileToken(voyageId)}`;
}

function indexKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(INDEX_KEY, scope);
}

function withScopeLock<T>(scope: AuthIdentityScope, staleValue: T, operation: () => Promise<T>): Promise<T> {
    const prior = operationTails.get(scope.key) ?? Promise.resolve();
    const result = prior.then(
        () => (isAuthIdentityScopeCurrent(scope) ? operation() : staleValue),
        () => (isAuthIdentityScopeCurrent(scope) ? operation() : staleValue),
    );
    operationTails.set(
        scope.key,
        result.then(
            () => undefined,
            () => undefined,
        ),
    );
    return result;
}

function isOwnedTrack(value: unknown, voyageId: string, scope: AuthIdentityScope): value is CachedTrack {
    if (!value || typeof value !== 'object') return false;
    const track = value as Partial<CachedTrack>;
    return (
        track.version === CACHE_VERSION &&
        track.ownerKey === scope.key &&
        track.ownerUserId === scope.userId &&
        track.voyageId === voyageId &&
        Array.isArray(track.entries)
    );
}

/**
 * Pure: is this track worth caching, and small enough to safely persist?
 * A 1-point "track" isn't a line; anything over the byte guard is skipped.
 */
export function shouldCacheTrack(entryCount: number, serializedBytes: number): boolean {
    return entryCount >= 2 && serializedBytes <= MAX_BYTES;
}

/**
 * Pure: replace volatile/offline ids with stable per-voyage render ids.
 */
export function normalizeCacheIds(entries: ShipLogEntry[], voyageId: string): ShipLogEntry[] {
    return entries.map((entry, index) =>
        !entry.id || entry.id.startsWith('offline_')
            ? ({ ...entry, id: `trkc_${voyageId}_${index}` } as ShipLogEntry)
            : entry,
    );
}

/** Pure LRU eviction plan. */
export function evictionPlan(index: IndexRow[], keepId: string, max: number = MAX_CACHED_VOYAGES): string[] {
    const others = index.filter((row) => row.voyageId !== keepId).sort((a, b) => a.at - b.at);
    const excess = others.length + 1 - max;
    return excess > 0 ? others.slice(0, excess).map((row) => row.voyageId) : [];
}

async function readIndex(scope: AuthIdentityScope): Promise<IndexRow[]> {
    const { value } = await Preferences.get({ key: indexKey(scope) });
    if (!isAuthIdentityScopeCurrent(scope) || !value) return [];
    try {
        const parsed = JSON.parse(value) as Partial<CacheIndex>;
        if (
            parsed.version !== CACHE_VERSION ||
            parsed.ownerKey !== scope.key ||
            parsed.ownerUserId !== scope.userId ||
            !Array.isArray(parsed.rows)
        ) {
            return [];
        }
        return parsed.rows.filter(
            (row): row is IndexRow =>
                !!row &&
                typeof row.voyageId === 'string' &&
                typeof row.at === 'number' &&
                typeof row.points === 'number',
        );
    } catch {
        return [];
    }
}

async function writeIndex(rows: IndexRow[], scope: AuthIdentityScope): Promise<void> {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    const payload: CacheIndex = {
        version: CACHE_VERSION,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        rows,
    };
    await Preferences.set({ key: indexKey(scope), value: JSON.stringify(payload) });
}

/** Read and LRU-touch one account's cached track. */
export function getCachedVoyageTrack(
    voyageId: string | null | undefined,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<ShipLogEntry[] | null> {
    if (!voyageId) return Promise.resolve(null);
    return withScopeLock(scope, null, async () => {
        try {
            const data = (await loadLargeData(trackKey(voyageId, scope))) as unknown;
            if (!isAuthIdentityScopeCurrent(scope) || !isOwnedTrack(data, voyageId, scope)) return null;

            const rows = await readIndex(scope);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            const row = rows.find((candidate) => candidate.voyageId === voyageId);
            if (row) {
                row.at = Date.now();
                row.points = data.entries.length;
            } else {
                rows.push({ voyageId, at: Date.now(), points: data.entries.length });
            }
            for (const evictId of evictionPlan(rows, voyageId)) {
                if (!isAuthIdentityScopeCurrent(scope)) return null;
                await deleteLargeData(trackKey(evictId, scope));
                if (!isAuthIdentityScopeCurrent(scope)) return null;
                const index = rows.findIndex((candidate) => candidate.voyageId === evictId);
                if (index >= 0) rows.splice(index, 1);
            }
            await writeIndex(rows, scope);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            return data.entries.map((entry) => ({ ...entry }));
        } catch (error) {
            log.warn('read failed', error);
            return null;
        }
    });
}

/** Persist one account's track and enforce its independent LRU cap. */
export function setCachedVoyageTrack(
    voyageId: string | null | undefined,
    entries: ShipLogEntry[],
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!voyageId) return Promise.resolve();
    const normalized = normalizeCacheIds(entries, voyageId).map((entry) => ({ ...entry }));
    const payload: CachedTrack = {
        version: CACHE_VERSION,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        voyageId,
        at: Date.now(),
        entries: normalized,
    };
    const serialized = JSON.stringify(payload);
    if (!shouldCacheTrack(normalized.length, serialized.length)) return Promise.resolve();

    return withScopeLock(scope, undefined, async () => {
        try {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            await saveLargeData(trackKey(voyageId, scope), payload);
            if (!isAuthIdentityScopeCurrent(scope)) return;

            const rows = (await readIndex(scope)).filter((row) => row.voyageId !== voyageId);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            rows.push({ voyageId, at: Date.now(), points: normalized.length });

            for (const evictId of evictionPlan(rows, voyageId)) {
                if (!isAuthIdentityScopeCurrent(scope)) return;
                await deleteLargeData(trackKey(evictId, scope));
                if (!isAuthIdentityScopeCurrent(scope)) return;
                const index = rows.findIndex((row) => row.voyageId === evictId);
                if (index >= 0) rows.splice(index, 1);
            }
            await writeIndex(rows, scope);
        } catch (error) {
            log.warn('write failed', error);
        }
    });
}

/** Drop only the current account's copy of a voyage track. */
export function clearCachedVoyageTrack(
    voyageId: string | null | undefined,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!voyageId) return Promise.resolve();
    return withScopeLock(scope, undefined, async () => {
        try {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            await deleteLargeData(trackKey(voyageId, scope));
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const rows = (await readIndex(scope)).filter((row) => row.voyageId !== voyageId);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            await writeIndex(rows, scope);
        } catch (error) {
            log.warn('clear failed', error);
        }
    });
}
