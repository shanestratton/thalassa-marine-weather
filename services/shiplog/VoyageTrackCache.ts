/**
 * VoyageTrackCache — local-first persistence for voyages' recorded tracks.
 *
 * Why: viewing a voyage's track (TrackMapViewer / PassageSummaryCard)
 * re-fetches every entry from Supabase (paginated, slow on a boat link).
 * Caching tracks locally lets viewers paint instantly while the network
 * refresh happens in the background.
 *
 * v2 (2026-06-13): multi-voyage. v1 kept ONE most-recently-viewed track
 * in Capacitor Preferences; opening any other voyage still hit the
 * network cold. v2 keeps the last MAX_CACHED_VOYAGES tracks as
 * individual Filesystem payloads (nativeStorage.saveLargeData — real
 * files on device, localStorage fallback on web) with a small LRU
 * index in Preferences. The recording device also writes the cache at
 * voyage STOP (ShipLogService.stopTracking), so your own voyages view
 * instantly forever, offline included.
 *
 * The public API is unchanged from v1 — same two functions, same
 * signatures — so existing callers (PassageSummaryCard) work as-is.
 */
import { Preferences } from '@capacitor/preferences';
import type { ShipLogEntry } from '../../types';
import { saveLargeData, loadLargeData, deleteLargeData } from '../nativeStorage';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('VoyageTrackCache');

const LEGACY_KEY = 'thalassa_voyage_track_cache_v1';
const INDEX_KEY = 'thalassa_voyage_track_index_v2';
/** How many voyages' tracks to keep before evicting the least recently used. */
export const MAX_CACHED_VOYAGES = 8;
/** ~4 MB guard per voyage — skip pathologically large tracks. */
const MAX_BYTES = 4_000_000;

interface CachedTrack {
    voyageId: string;
    at: number;
    entries: ShipLogEntry[];
}

interface IndexRow {
    voyageId: string;
    at: number;
    points: number;
}

/** Filesystem key for a voyage's track payload (filename-safe). */
function trackKey(voyageId: string): string {
    return `thalassa_track_v2_${voyageId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * Pure: is this track worth caching, and small enough to safely persist?
 * A 1-point "track" isn't a line; anything over the byte guard is skipped.
 */
export function shouldCacheTrack(entryCount: number, serializedBytes: number): boolean {
    return entryCount >= 2 && serializedBytes <= MAX_BYTES;
}

/**
 * Pure: normalise entry ids for caching. `offline_*` ids are volatile
 * (mergeRecentEntries PURGES them on every refresh, so a cached track
 * carrying them would vanish from state at the next live poll) and
 * positional (two voyages' queues can both contain `offline_0`).
 * Missing ids break React keys. Both get stable per-voyage ids; real
 * DB ids pass through untouched.
 */
export function normalizeCacheIds(entries: ShipLogEntry[], voyageId: string): ShipLogEntry[] {
    return entries.map((e, i) =>
        !e.id || e.id.startsWith('offline_') ? ({ ...e, id: `trkc_${voyageId}_${i}` } as ShipLogEntry) : e,
    );
}

/**
 * Pure: which voyageIds to evict so the index fits the cap after
 * `keepId` is inserted/refreshed. Oldest `at` first; `keepId` survives.
 */
export function evictionPlan(index: IndexRow[], keepId: string, max: number = MAX_CACHED_VOYAGES): string[] {
    const others = index.filter((r) => r.voyageId !== keepId).sort((a, b) => a.at - b.at);
    const excess = others.length + 1 - max;
    return excess > 0 ? others.slice(0, excess).map((r) => r.voyageId) : [];
}

async function readIndex(): Promise<IndexRow[]> {
    try {
        const { value } = await Preferences.get({ key: INDEX_KEY });
        if (!value) return [];
        const rows = JSON.parse(value) as IndexRow[];
        return Array.isArray(rows) ? rows : [];
    } catch {
        return [];
    }
}

async function writeIndex(rows: IndexRow[]): Promise<void> {
    await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(rows) });
}

/** Read the cached track for a voyage, or null if none cached. */
export async function getCachedVoyageTrack(voyageId: string | null | undefined): Promise<ShipLogEntry[] | null> {
    if (!voyageId) return null;
    try {
        const data = (await loadLargeData(trackKey(voyageId))) as CachedTrack | null;
        if (data && data.voyageId === voyageId && Array.isArray(data.entries)) {
            // Touch the LRU timestamp (best effort, don't block the read).
            void readIndex().then((rows) => {
                const row = rows.find((r) => r.voyageId === voyageId);
                if (row) {
                    row.at = Date.now();
                    return writeIndex(rows);
                }
            });
            return data.entries;
        }

        // v1 migration: the old single-slot cache may still hold this
        // voyage (e.g. the last track viewed before the update). Serve
        // it and promote it into v2 on the way through.
        const { value } = await Preferences.get({ key: LEGACY_KEY });
        if (value) {
            const legacy = JSON.parse(value) as CachedTrack;
            if (legacy.voyageId === voyageId && Array.isArray(legacy.entries)) {
                void setCachedVoyageTrack(voyageId, legacy.entries);
                void Preferences.remove({ key: LEGACY_KEY });
                return legacy.entries;
            }
        }
        return null;
    } catch (e) {
        log.warn('read failed', e);
        return null;
    }
}

/** Persist a voyage's track. No-ops on empty/oversized tracks. */
export async function setCachedVoyageTrack(
    voyageId: string | null | undefined,
    entries: ShipLogEntry[],
): Promise<void> {
    if (!voyageId) return;
    try {
        const normalized = normalizeCacheIds(entries, voyageId);
        const payload: CachedTrack = { voyageId, at: Date.now(), entries: normalized };
        const serialized = JSON.stringify(payload);
        if (!shouldCacheTrack(normalized.length, serialized.length)) return;

        await saveLargeData(trackKey(voyageId), payload);

        // Update the LRU index + evict the oldest tracks over the cap.
        const rows = (await readIndex()).filter((r) => r.voyageId !== voyageId);
        rows.push({ voyageId, at: Date.now(), points: normalized.length });
        for (const evictId of evictionPlan(rows, voyageId)) {
            await deleteLargeData(trackKey(evictId));
            const i = rows.findIndex((r) => r.voyageId === evictId);
            if (i >= 0) rows.splice(i, 1);
        }
        await writeIndex(rows);
    } catch (e) {
        log.warn('write failed', e);
    }
}

/** Drop a voyage's cached track (e.g. after the voyage is deleted). */
export async function clearCachedVoyageTrack(voyageId: string | null | undefined): Promise<void> {
    if (!voyageId) return;
    try {
        await deleteLargeData(trackKey(voyageId));
        const rows = (await readIndex()).filter((r) => r.voyageId !== voyageId);
        await writeIndex(rows);
    } catch (e) {
        log.warn('clear failed', e);
    }
}
