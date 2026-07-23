/**
 * Diary Service — Captain's Journal
 *
 * OFFLINE-FIRST architecture:
 *   - All entries saved to localStorage immediately
 *   - Syncs to Supabase when network is available
 *   - Photos stored as base64 data URIs offline, uploaded on sync
 *   - Pending entries show instantly in the timeline
 *   - Background sync on connectivity change
 *
 * Table: diary_entries
 * Storage bucket: diary-photos
 */

import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
import { supabase } from './supabase';
import { getAuthenticatedFunctionHeaders } from './supabaseAuth';
import {
    savePhoto as idbSavePhoto,
    loadPhoto as idbLoadPhoto,
    deletePhoto as idbDeletePhoto,
    isIdbPhoto,
    IDB_PHOTO_PREFIX,
} from './diaryPhotoStore';
const log = createLogger('Diary');

// ── Types ──────────────────────────────────────────────────────

/** Structured weather snapshot captured at a pin-drop location */
export interface DiaryWeatherData {
    description?: string; // e.g. "Partly Cloudy"
    airTemp?: number; // °C
    seaTemp?: number; // °C
    windSpeed?: number; // kts
    windDir?: string; // e.g. "NNE"
    humidity?: number; // %
    rain?: number; // mm
}

export interface DiaryEntry {
    id: string;
    user_id: string;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[]; // Public URLs (or data: URIs when offline)
    audio_url: string | null; // Voice memo URL (or data: URI when offline)
    latitude: number | null;
    longitude: number | null;
    location_name: string;
    weather_summary: string;
    weather_data?: DiaryWeatherData | null; // Structured weather at pin
    voyage_id: string | null;
    tags: string[];
    is_public: boolean; // Published to the public Voyage Log API
    created_at: string;
    updated_at: string;
    /**
     * Immutable local queue/cache owner. Never sent to diary_entries; it
     * prevents one signed-in account from adopting another account's work.
     */
    readonly owner_user_id?: string | null;
    _offline?: boolean; // Client-only flag — not persisted to DB
    _pendingPhotos?: string[]; // Base64 photos awaiting upload
}

export type DiaryMood = 'epic' | 'good' | 'neutral' | 'rough' | 'storm';

export const MOOD_CONFIG: Record<DiaryMood, { emoji: string; label: string; color: string }> = {
    epic: { emoji: '🌅', label: 'Epic', color: 'text-amber-400' },
    good: { emoji: '⛵', label: 'Good', color: 'text-emerald-400' },
    neutral: { emoji: '🌊', label: 'Neutral', color: 'text-sky-400' },
    rough: { emoji: '💨', label: 'Rough', color: 'text-orange-400' },
    storm: { emoji: '⛈️', label: 'Storm', color: 'text-red-400' },
};

// ── Constants ──────────────────────────────────────────────────

const TABLE = 'diary_entries';
const PHOTO_BUCKET = 'diary-photos';
const AUDIO_BUCKET = 'diary-audio';
const STORAGE_REF_PREFIX = 'storage:';
const CACHE_KEY = 'thalassa_diary_entries_v2';
const PENDING_KEY = 'thalassa_diary_pending_v2';
const DELETED_KEY = 'thalassa_diary_deleted_v1';
const IDMAP_KEY = 'thalassa_diary_idmap_v1';
const MEDIA_OWNERS_KEY = 'thalassa_diary_media_owners_v1';
const QUARANTINE_KEY = 'thalassa_diary_quarantine_v1';
const IDMAP_MAX = 300;
const MAX_PHOTO_SIZE = 1200;
// Tombstones older than this are abandoned — long enough for any realistic
// offline stretch, short enough that a failed server delete can't haunt the
// store forever.
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// After a tombstone drains, keep filtering its id from reads for a grace
// window: a server refresh that was already in flight when the drain landed
// carries a pre-delete payload, and the tombstone that would have filtered
// it is gone by the time that payload is merged.
const RECENT_DRAIN_GRACE_MS = 5 * 60 * 1000;

/**
 * A locally-committed delete awaiting server confirmation. `photos`/`audio`
 * snapshot the entry's storage URLs at delete time so the drain can clean
 * the buckets even after the entry is gone from every local cache.
 */
interface DiaryTombstone {
    id: string;
    photos: string[];
    audio?: string | null;
    deletedAt: number;
    readonly owner_user_id: string | null;
}

interface DiaryIdMapping {
    offlineId: string;
    serverId: string;
    readonly owner_user_id: string | null;
}

interface QuarantinedDiaryBytes {
    sourceKey: string;
    reason: string;
    quarantinedAt: number;
    value: unknown;
}

// ── Service ────────────────────────────────────────────────────

class DiaryServiceClass {
    // Quota-fallback tombstones: when localStorage rejects the write, the
    // delete is still honoured for this session (and drainable) via memory.
    private _memTombstones = new Map<string, DiaryTombstone[]>();
    // Ids whose tombstone drained recently — see RECENT_DRAIN_GRACE_MS.
    private _recentlyDrained = new Map<string, Map<string, number>>();
    // In-flight sync promise — lets callers (e.g. setEntryPublished) await an
    // already-running sync instead of racing past it.
    private _syncPromise: { generation: number; promise: Promise<void> } | null = null;
    private _lastRefreshTime = 0;
    private _refreshPromise: { generation: number; promise: Promise<void> } | null = null;
    private _drainPromise: { generation: number; promise: Promise<void> } | null = null;
    // Buffer of recently-synced entries — prevents race condition where entry
    // vanishes between pending removal and server cache arrival. `offlineId`
    // maps the original offline- id to the real server row.
    private _recentlySynced: { offlineId: string; entry: DiaryEntry; syncedAt: number }[] = [];
    // In-memory cache of photo blobs keyed by blob: URL — avoids base64 in localStorage
    private _pendingPhotoBlobs = new Map<string, { blob: Blob; scopeKey: string }>();
    // Cache mapping idb: references → short-lived blob URLs for <img> rendering.
    // Avoids re-reading IndexedDB on every render.
    private _idbRefToBlobUrl = new Map<string, string>();
    private _signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

    constructor() {
        subscribeAuthIdentityScope(() => {
            // New calls are allowed to start immediately in the new namespace;
            // old promises retain their captured scope and fail generation checks.
            this._syncPromise = null;
            this._refreshPromise = null;
            this._drainPromise = null;
            this._lastRefreshTime = 0;
            this._recentlySynced = [];
            for (const url of this._idbRefToBlobUrl.values()) URL.revokeObjectURL(url);
            this._idbRefToBlobUrl.clear();
            this._signedUrlCache.clear();
        });
        // Auto-sync when connectivity resumes
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                this.syncPending();
                this.drainDeletedTombstones();
            });
            // Attempt sync on init
            setTimeout(() => {
                this.syncPending();
                this.drainDeletedTombstones();
            }, 5000);
            // Periodic retry every 30s — catches stuck pending entries and
            // undrained deletes (navigator.onLine is unreliable on iOS/Capacitor)
            setInterval(() => {
                // Only probe network if there is actually work queued
                if (this._getPendingEntries().length > 0) this.syncPending();
                if (this._getTombstones().length > 0) this.drainDeletedTombstones();
            }, 30_000);
        }
    }

    // ── Read ───────────────────────────────────────────────────

    async getEntries(limit = 50): Promise<DiaryEntry[]> {
        const scope = getAuthIdentityScope();
        // 1. Merge cached remote entries + pending offline entries + recently-synced buffer
        const cached = this._getCachedEntries(scope);
        const pending = this._getPendingEntries(scope);

        // Purge stale entries from recently-synced buffer (>30s)
        const now = Date.now();
        this._recentlySynced = this._recentlySynced.filter((r) => now - r.syncedAt < 120_000);
        const recentlySyncedEntries = this._recentlySynced.map((r) => r.entry);

        // Combine: pending first, then recently-synced, then cached (deduped)
        // This closes the gap where an entry has exited pending (sync succeeded)
        // but hasn't yet appeared in the cache (server refresh pending).
        // Tombstoned ids are locally-committed deletes awaiting server drain —
        // they must never surface, whichever source still holds a copy.
        const deletedIds = this._tombstonedIdSet(scope);
        const seenIds = new Set<string>();
        const allSources = [...pending, ...recentlySyncedEntries, ...cached];
        const deduped: DiaryEntry[] = [];
        for (const e of allSources) {
            if (!seenIds.has(e.id) && !deletedIds.has(e.id) && !this._isRecentlyDrained(e.id, scope)) {
                seenIds.add(e.id);
                deduped.push(e);
            }
        }
        const merged = deduped
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, limit);

        // Background refresh from Supabase (non-blocking) — but throttle to max once per 5s
        // to prevent stale overwrites during rapid create/read cycles
        if (now - this._lastRefreshTime > 5000) {
            void this._refreshFromServer(limit, scope);
        }

        // Strip _offline flag — background sync handles persistence transparently.
        // Showing PENDING badges confuses users when sync is slow or auth is stale.
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        return merged.map((e) => ({ ...e, _offline: false }));
    }

    async getEntry(id: string): Promise<DiaryEntry | null> {
        const scope = getAuthIdentityScope();
        // Deleted locally — gone, even if the server row still exists.
        if (this._tombstonedIdSet(scope).has(id) || this._isRecentlyDrained(id, scope)) return null;

        // Check pending first
        const pending = this._getPendingEntries(scope);
        const pendingMatch = pending.find((e) => e.id === id);
        if (pendingMatch) return pendingMatch;

        // Check cache
        const cached = this._getCachedEntries(scope);
        const cacheMatch = cached.find((e) => e.id === id);
        if (cacheMatch) return cacheMatch;

        // Fallback to network
        if (!supabase || !scope.userId) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;
        const { data } = await supabase.from(TABLE).select('*').eq('id', id).eq('user_id', scope.userId).single();
        if (!isAuthIdentityScopeCurrent(scope) || !data || (data as DiaryEntry).user_id !== scope.userId) return null;
        const owned = { ...(data as DiaryEntry), owner_user_id: scope.userId };
        this._registerEntryMedia(owned, scope);
        return owned;
    }

    // ── Create (offline-first) ─────────────────────────────────

    async createEntry(entry: {
        title: string;
        body: string;
        mood: DiaryMood;
        photos?: string[];
        audio_url?: string | null;
        latitude?: number | null;
        longitude?: number | null;
        location_name?: string;
        weather_summary?: string;
        weather_data?: DiaryWeatherData | null;
        voyage_id?: string | null;
        tags?: string[];
        is_public?: boolean;
    }): Promise<DiaryEntry> {
        const scope = getAuthIdentityScope();
        const now = new Date().toISOString();
        const localEntry: DiaryEntry = {
            id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            user_id: scope.userId ?? 'local',
            title: entry.title,
            body: entry.body,
            mood: entry.mood,
            photos: entry.photos || [],
            audio_url: entry.audio_url ?? null,
            latitude: entry.latitude ?? null,
            longitude: entry.longitude ?? null,
            location_name: entry.location_name || '',
            weather_summary: entry.weather_summary || '',
            weather_data: entry.weather_data ?? null,
            voyage_id: entry.voyage_id ?? null,
            tags: entry.tags || [],
            is_public: entry.is_public ?? false,
            created_at: now,
            updated_at: now,
            owner_user_id: scope.userId,
            _offline: true,
            _pendingPhotos: (entry.photos || []).filter((p) => p.startsWith('data:')),
        };

        // AWAIT persistence before returning. The previous fire-and-forget
        // pattern lost entries if the app was backgrounded between the Save
        // tap and the async write completing (iOS WKWebView process suspend
        // is aggressive on low-memory devices). With the IDB-based photo
        // store, _addPending is fast — just a localStorage write + a couple
        // of IDB promotions at worst — so this is safe to await.
        try {
            await this._addPending(localEntry, scope);
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(scope)) throw e;
            log.error('Failed to persist diary entry to pending queue:', e);
            // Don't throw — the entry is still in React state for the user to
            // see and retry. But flag it as offline so the UI shows a warning.
            return { ...localEntry, _offline: true };
        }

        // Fire sync in the background — don't block the UI on it.
        void this.syncPending();

        // Return entry without _offline flag — avoids persistent PENDING badge in UI.
        // The entry is now durably in pending queue AND IndexedDB; background sync
        // will upload it, and the periodic 30s retry catches transient failures.
        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Authentication changed while saving the diary entry');
        }
        return { ...localEntry, _offline: false };
    }

    // ── Update ─────────────────────────────────────────────────

    async updateEntry(
        id: string,
        updates: Partial<
            Pick<
                DiaryEntry,
                'title' | 'body' | 'mood' | 'photos' | 'location_name' | 'weather_summary' | 'tags' | 'is_public'
            >
        >,
    ): Promise<boolean> {
        const scope = getAuthIdentityScope();
        // Update in pending queue if offline entry
        if (id.startsWith('offline-')) {
            const pending = this._getPendingEntries(scope);
            const idx = pending.findIndex((e) => e.id === id);
            if (idx >= 0) {
                Object.assign(pending[idx], updates, { updated_at: new Date().toISOString() });
                this._savePending(pending, scope);
                return true;
            }
            // Not in the pending queue — it likely synced already. Resolve the
            // offline id to the real server id so the Supabase update below hits.
            const synced = this._recentlySynced.find((r) => r.offlineId === id);
            if (synced) id = synced.entry.id;
        }

        // Update in Supabase
        if (!supabase || !scope.userId) return false;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return false;
        const { error } = await supabase
            .from(TABLE)
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', scope.userId);

        if (!isAuthIdentityScopeCurrent(scope)) return false;
        if (!error) void this._refreshFromServer(50, scope);
        return !error;
    }

    // ── Publish ────────────────────────────────────────────────

    /**
     * Publish (or unpublish) an entry to the public Voyage Log.
     *
     * Robust against the offline-first race: a freshly-created entry might
     * still be in the pending queue, mid-sync, or already on the server
     * under a real id by the time the user taps "Publish". This walks all
     * three cases so the server row reliably ends up with the right flag.
     */
    async setEntryPublished(id: string, isPublic: boolean): Promise<boolean> {
        const scope = getAuthIdentityScope();
        if (id.startsWith('offline-')) {
            // Set the flag on the pending entry so it goes up correctly if it
            // hasn't synced yet.
            const pending = this._getPendingEntries(scope);
            const idx = pending.findIndex((e) => e.id === id);
            if (idx >= 0) {
                pending[idx].is_public = isPublic;
                this._savePending(pending, scope);
            }
            // Push it to the server now — awaits any in-flight sync too.
            await this.syncPending();
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            // If it landed, force the flag on the real row directly. Covers the
            // race where it had already synced as not-public before this call.
            const synced = this._recentlySynced.find((r) => r.offlineId === id);
            if (synced) return this._setPublishedOnServer(synced.entry.id, isPublic, scope);
            // Still offline — the flag is on the pending entry and syncs with it.
            return this._getPendingEntries(scope).some((e) => e.id === id);
        }
        return this._setPublishedOnServer(id, isPublic, scope);
    }

    private async _setPublishedOnServer(id: string, isPublic: boolean, scope: AuthIdentityScope): Promise<boolean> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return false;
        const { error } = await supabase
            .from(TABLE)
            .update({ is_public: isPublic, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', scope.userId);
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        if (!error) void this._refreshFromServer(50, scope);
        return !error;
    }

    // ── Delete (offline-first) ─────────────────────────────────
    //
    // Deletes commit LOCALLY first — tombstone written, every local source
    // scrubbed — and return true immediately. The server delete is pushed
    // best-effort now and drained by drainDeletedTombstones() on the online
    // event / 30s timer when it fails. Creates have been offline-first since
    // day one; deletes used to hard-require the network, which made entries
    // undeletable (and self-resurrecting) on the water.

    async deleteEntry(id: string): Promise<boolean> {
        const scope = getAuthIdentityScope();
        // Offline-created entry — remove from the pending queue before it syncs.
        if (id.startsWith('offline-')) {
            const pending = this._getPendingEntries(scope);
            const entry = pending.find((e) => e.id === id);
            // Clean up any IDB-backed photos so they don't leak bytes
            if (entry?.photos) {
                for (const p of entry.photos) {
                    if (isIdbPhoto(p)) {
                        void idbDeletePhoto(p);
                        const cachedUrl = this._idbRefToBlobUrl.get(p);
                        if (cachedUrl) {
                            URL.revokeObjectURL(cachedUrl);
                            this._idbRefToBlobUrl.delete(p);
                        }
                    }
                }
            }
            this._savePending(
                pending.filter((e) => e.id !== id),
                scope,
            );

            // Tombstone the offline id too: an in-flight syncPending() may have
            // snapshotted the queue BEFORE the filter above, in which case it
            // will still insert this entry. The post-insert tombstone check in
            // syncPending catches that and deletes the fresh server row.
            this._addTombstone(id, [], null, scope);

            // Already synced? Then the pending filter was a no-op and the entry
            // lives on the server under a real id — commit a delete for that too.
            const synced = this._recentlySynced.find((r) => r.offlineId === id);
            if (synced) {
                this._recentlySynced = this._recentlySynced.filter((r) => r.offlineId !== id);
                return this._commitLocalDelete(
                    synced.entry.id,
                    synced.entry.photos ?? [],
                    synced.entry.audio_url,
                    scope,
                );
            }
            // Synced longer ago (the 120s buffer purged, or the app relaunched):
            // the durable id-map still knows the server twin.
            const mappedId = this.resolveServerId(id);
            if (mappedId) {
                const twin = this._getCachedEntries(scope).find((e) => e.id === mappedId) ?? null;
                return this._commitLocalDelete(mappedId, twin?.photos ?? [], twin?.audio_url, scope);
            }
            return true;
        }

        // Server entry — snapshot storage URLs from local sources only (never
        // the network: the whole point is that this must succeed offline).
        const local =
            this._getCachedEntries(scope).find((e) => e.id === id) ??
            this._recentlySynced.find((r) => r.entry.id === id)?.entry ??
            null;
        return this._commitLocalDelete(id, local?.photos ?? [], local?.audio_url, scope);
    }

    /** Tombstone + scrub local caches, then push to the server best-effort. */
    private _commitLocalDelete(
        id: string,
        photos: string[],
        audio: string | null | undefined,
        scope: AuthIdentityScope,
    ): boolean {
        this._addTombstone(id, photos, audio, scope);
        this._saveCachedEntries(
            this._getCachedEntries(scope).filter((e) => e.id !== id),
            scope,
        );
        this._recentlySynced = this._recentlySynced.filter((r) => r.entry.id !== id);
        if (isAuthIdentityScopeCurrent(scope)) void this.drainDeletedTombstones();
        return true;
    }

    /**
     * Push locally-committed deletes to the server. Serialised; safe to call
     * opportunistically (init, online event, 30s timer, after each delete).
     */
    async drainDeletedTombstones(): Promise<void> {
        const scope = getAuthIdentityScope();
        const active = this._drainPromise;
        if (active?.generation === scope.generation) return active.promise;
        const promise = this._runDrainDeletedTombstones(scope);
        this._drainPromise = { generation: scope.generation, promise };
        try {
            await promise;
        } finally {
            if (this._drainPromise?.promise === promise) this._drainPromise = null;
        }
    }

    private async _runDrainDeletedTombstones(scope: AuthIdentityScope): Promise<void> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return;
        const tombs = this._getTombstones(scope);
        if (tombs.length === 0) return;
        let drained = 0;
        for (const tombstone of tombs) {
            if (!isAuthIdentityScopeCurrent(scope) || tombstone.owner_user_id !== scope.userId) return;
            // offline- tombstones never reached the server under that id;
            // their only job is the mid-flight check in syncPending. They
            // expire via TTL.
            if (tombstone.id.startsWith('offline-')) continue;
            const ok = await this._deleteOnServer(tombstone.id, tombstone.photos, tombstone.audio, scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (ok) {
                this._removeTombstone(tombstone.id, scope);
                // Grace filter: a pre-delete server payload may still be in
                // flight, and the tombstone that would have caught it is gone.
                this._markRecentlyDrained(tombstone.id, scope);
                drained++;
            }
        }
        if (drained > 0) void this._refreshFromServer(50, scope);
    }

    /** Server-side row + storage removal. False = retry on next drain. */
    private async _deleteOnServer(
        id: string,
        photos: string[],
        audio: string | null | undefined,
        scope: AuthIdentityScope,
    ): Promise<boolean> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
        try {
            let photoUrls = photos;
            let audioUrl = audio ?? null;
            if (photoUrls.length === 0 && !audioUrl) {
                // Delete committed without a local snapshot — ask the server
                // BEFORE the row goes, so bucket objects don't orphan.
                const { data } = await supabase.from(TABLE).select('photos, audio_url').eq('id', id).maybeSingle();
                if (!isAuthIdentityScopeCurrent(scope)) return false;
                photoUrls = (data?.photos as string[] | null) ?? [];
                audioUrl = (data?.audio_url as string | null) ?? null;
            }
            // Row FIRST: if this fails, nothing has been destroyed and the
            // whole tombstone retries. (Storage-first + a persistently-failing
            // row delete + TTL expiry would resurrect the entry with dead
            // photo URLs.)
            // .select('id') so an RLS-BLOCKED delete is detectable: Supabase
            // returns NO error and zero rows when the policy filters the row
            // out — counting that as success dropped the tombstone and the
            // next refresh resurrected the entry.
            const { data: deleted, error } = await supabase.from(TABLE).delete().eq('id', id).select('id');
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            if (error) {
                log.warn('Server delete failed — will retry on next drain:', error.message);
                return false;
            }
            if (!deleted || deleted.length === 0) {
                // Zero rows: either already gone (fine) or RLS hid it. Probe —
                // still readable means blocked, keep the tombstone so the entry
                // at least stays hidden locally and the drain retries.
                const { data: still } = await supabase.from(TABLE).select('id').eq('id', id).maybeSingle();
                if (!isAuthIdentityScopeCurrent(scope)) return false;
                if (still) {
                    log.warn(
                        `Server delete BLOCKED for ${id} — row visible but not deletable (ownership?). Keeping tombstone.`,
                    );
                    return false;
                }
            }
            // Row is gone — storage cleanup is best-effort from here.
            try {
                for (const url of photoUrls) {
                    if (!isAuthIdentityScopeCurrent(scope)) return false;
                    const path = this._extractStoragePath(url, PHOTO_BUCKET);
                    if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
                }
                const audioPath = audioUrl ? this._extractStoragePath(audioUrl, AUDIO_BUCKET) : null;
                if (audioPath && isAuthIdentityScopeCurrent(scope)) {
                    await supabase.storage.from(AUDIO_BUCKET).remove([audioPath]);
                }
            } catch (e) {
                log.warn('Storage cleanup after delete failed (objects orphaned):', e);
            }
            return true;
        } catch (e) {
            log.warn('Server delete failed — will retry on next drain:', e);
            return false;
        }
    }

    // ── Photos ─────────────────────────────────────────────────

    async uploadPhoto(file: File): Promise<string | null> {
        const scope = getAuthIdentityScope();
        // Compress first (always — trims upload bandwidth and local storage).
        const compressed = await this._compressImage(file);
        if (!isAuthIdentityScopeCurrent(scope)) return null;

        // Try direct upload if connectivity looks viable.
        if (supabase && navigator.onLine && scope.userId) {
            const url = await this._uploadPhotoToStorage(file, scope);
            if (url && isAuthIdentityScopeCurrent(scope)) {
                this._registerMediaRef(url, scope);
                return url;
            }
        }

        // Offline (or upload failed): persist the compressed Blob to IndexedDB
        // and return an idb: reference. IndexedDB survives WKWebView process
        // suspend, unlike the in-memory _pendingPhotoBlobs Map, so the photo
        // won't vanish if iOS backgrounds the app between pick and save.
        try {
            const idbRef = await idbSavePhoto(compressed);
            if (!isAuthIdentityScopeCurrent(scope)) {
                await idbDeletePhoto(idbRef);
                return null;
            }
            // Also stash in the legacy in-memory cache so the UI can render
            // immediately via a blob: URL without a round-trip through IDB.
            // The idbRef is the source of truth for persistence.
            const blobUrl = URL.createObjectURL(compressed);
            this._pendingPhotoBlobs.set(idbRef, { blob: compressed, scopeKey: scope.key });
            this._idbRefToBlobUrl.set(idbRef, blobUrl);
            this._registerMediaRef(idbRef, scope);
            return idbRef;
        } catch (e) {
            log.error('IndexedDB savePhoto failed, falling back to blob: URL:', e);
            // Last resort: in-memory blob URL (may be lost on suspend, but
            // better than dropping the photo entirely).
            const blobUrl = URL.createObjectURL(compressed);
            if (!isAuthIdentityScopeCurrent(scope)) {
                URL.revokeObjectURL(blobUrl);
                return null;
            }
            this._pendingPhotoBlobs.set(blobUrl, { blob: compressed, scopeKey: scope.key });
            this._registerMediaRef(blobUrl, scope);
            return blobUrl;
        }
    }

    /**
     * Given a photo reference, return a URL the UI can pass to an image.
     * Private Supabase objects are resolved to short-lived signed URLs.
     * the UI can pass to an <img src>. For idb: refs this creates a short-
     * lived blob URL (cached to avoid duplicates across renders).
     */
    async resolvePhotoUrl(ref: string): Promise<string | null> {
        const scope = getAuthIdentityScope();
        if (!ref) return null;
        if (!this._ownsMediaRef(ref, scope)) return null;
        if (ref.startsWith('data:') || ref.startsWith('blob:')) return ref;
        if (isIdbPhoto(ref)) {
            // Cached blob URL?
            const cached = this._idbRefToBlobUrl.get(ref);
            if (cached) return cached;
            const blob = await idbLoadPhoto(ref);
            if (!blob || !isAuthIdentityScopeCurrent(scope)) return null;
            const url = URL.createObjectURL(blob);
            this._idbRefToBlobUrl.set(ref, url);
            return url;
        }
        const storagePath = this._extractStoragePath(ref, PHOTO_BUCKET);
        if (storagePath && supabase) {
            return this._createSignedStorageUrl(PHOTO_BUCKET, storagePath, ref, scope);
        }
        if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
        return null;
    }

    /** Resolve a private diary audio reference before playback/transcription. */
    async resolveAudioUrl(ref: string): Promise<string | null> {
        const scope = getAuthIdentityScope();
        if (!ref) return null;
        if (!this._ownsMediaRef(ref, scope)) return null;
        if (ref.startsWith('data:') || ref.startsWith('blob:')) return ref;
        const storagePath = this._extractStoragePath(ref, AUDIO_BUCKET);
        if (storagePath && supabase) {
            return this._createSignedStorageUrl(AUDIO_BUCKET, storagePath, ref, scope);
        }
        if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
        return ref;
    }

    private async _createSignedStorageUrl(
        bucket: string,
        path: string,
        cacheKey: string,
        scope: AuthIdentityScope,
    ): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        if (!path.startsWith(`${scope.userId}/`)) return null;
        const cached = this._signedUrlCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.url;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (error || !data?.signedUrl) {
            log.warn(`Could not sign private ${bucket} object:`, error?.message);
            return null;
        }
        this._signedUrlCache.set(cacheKey, { url: data.signedUrl, expiresAt: Date.now() + 55 * 60 * 1000 });
        return data.signedUrl;
    }

    private async _uploadPhotoToStorage(file: File, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        try {
            const compressed = await this._compressImage(file);
            const ext = file.name.split('.').pop() || 'jpg';
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            const path = `${scope.userId}/${Date.now()}.${ext}`;

            const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, compressed, {
                contentType: `image/${ext === 'png' ? 'png' : 'jpeg'}`,
                upsert: false,
            });

            if (error || !isAuthIdentityScopeCurrent(scope)) return null;

            return `${STORAGE_REF_PREFIX}${PHOTO_BUCKET}:${path}`;
        } catch (e) {
            log.error('Photo upload failed:', e);
            return null;
        }
    }

    private async _fileToDataUri(file: File): Promise<string> {
        // Compress first, then convert to data URI
        const compressed = await this._compressImage(file);
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(compressed);
        });
    }

    private async _uploadDataUri(dataUri: string, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        try {
            // Convert data URI to blob
            const res = await fetch(dataUri);
            const blob = await res.blob();
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            return this._uploadBlob(blob, scope);
        } catch (e) {
            log.error('Data URI upload failed:', e);
            return null;
        }
    }

    private async _uploadBlob(blob: Blob, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        try {
            const path = `${scope.userId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;

            const { error } = await supabase.storage
                .from(PHOTO_BUCKET)
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

            if (error || !isAuthIdentityScopeCurrent(scope)) return null;

            return `${STORAGE_REF_PREFIX}${PHOTO_BUCKET}:${path}`;
        } catch (e) {
            log.error('Blob upload failed:', e);
            return null;
        }
    }

    // ── Sync Engine ────────────────────────────────────────────

    async syncPending(): Promise<void> {
        const scope = getAuthIdentityScope();
        // If a sync is already running, await it rather than bailing — callers
        // like setEntryPublished need to know when the entry has actually landed.
        const active = this._syncPromise;
        if (active?.generation === scope.generation) {
            await active.promise;
            return;
        }
        const promise = this._runSyncPending(scope);
        this._syncPromise = { generation: scope.generation, promise };
        try {
            await promise;
        } finally {
            if (this._syncPromise?.promise === promise) this._syncPromise = null;
        }
    }

    private async _runSyncPending(scope: AuthIdentityScope): Promise<void> {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        // On native (Capacitor), navigator.onLine can lie — probe the network instead
        const isOnline = await this._checkConnectivity();
        if (!isAuthIdentityScopeCurrent(scope) || !isOnline || !supabase) return;

        const pending = this._getPendingEntries(scope);
        if (pending.length === 0) return;

        log.info(`Syncing ${pending.length} pending entries…`);

        // Try getUser first, fall back to getSession, then try refreshSession
        // (Capacitor can have stale user cache / expired JWT)
        let userId: string | undefined;
        const userResp = await supabase.auth.getUser();
        userId = userResp.data.user?.id;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (!userId) {
            const sessionResp = await supabase.auth.getSession();
            userId = sessionResp.data.session?.user?.id;
        }
        if (!userId) {
            // Last resort: force a token refresh — handles expired JWT edge case
            log.warn('Auth stale — attempting token refresh...');
            try {
                const refreshResp = await supabase.auth.refreshSession();
                userId = refreshResp.data.session?.user?.id;
                if (userId) {
                    log.info('Token refresh succeeded — resuming sync');
                }
            } catch (refreshErr) {
                log.warn('Token refresh failed:', refreshErr);
            }
        }
        if (!userId) {
            log.warn('No authenticated user after all attempts — skipping sync (will retry in 30s)');
            return;
        }
        if (!isAuthIdentityScopeCurrent(scope) || userId !== scope.userId) {
            log.warn('Diary sync refused work owned by a different authenticated account');
            return;
        }

        let syncedCount = 0;

        for (const entry of pending) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (entry.owner_user_id !== scope.userId) {
                log.error('Diary sync quarantined a pending entry with a mismatched owner');
                this._quarantine(PENDING_KEY, 'pending owner did not match active sync scope', entry);
                continue;
            }
            try {
                // 1. Upload any pending photos. Three offline schemes can appear:
                //    - idb:<key>     → Blob in IndexedDB (durable; preferred path)
                //    - blob:<uuid>   → legacy in-memory Blob (pre-IDB entries)
                //    - data:...      → legacy base64 data URI (older entries)
                // Anything else (http/https) is treated as already uploaded.
                //
                // CRITICAL: if a photo upload fails (e.g., transient network
                // error mid-sync), we re-add the original reference so it
                // gets retried on the next sync — rather than silently
                // dropping the photo the way the legacy code did.
                const uploadedPhotos: string[] = [];
                let allPhotosUploaded = true;
                for (const photo of entry.photos) {
                    if (isIdbPhoto(photo)) {
                        const blob = await idbLoadPhoto(photo);
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                        if (blob) {
                            const url = await this._uploadBlob(blob, scope);
                            if (url) {
                                uploadedPhotos.push(url);
                                // Success — clean up IDB copy and any cached blob URL.
                                await idbDeletePhoto(photo);
                                if (!isAuthIdentityScopeCurrent(scope)) return;
                                const cachedUrl = this._idbRefToBlobUrl.get(photo);
                                if (cachedUrl) {
                                    URL.revokeObjectURL(cachedUrl);
                                    this._idbRefToBlobUrl.delete(photo);
                                }
                                this._pendingPhotoBlobs.delete(photo);
                            } else {
                                // Upload failed — keep the idb ref so we retry.
                                uploadedPhotos.push(photo);
                                allPhotosUploaded = false;
                            }
                        } else {
                            // Blob missing in IDB (cleared/corrupted) — can't recover.
                            log.warn('IDB photo missing, dropping reference:', photo);
                        }
                    } else if (photo.startsWith('blob:')) {
                        const pendingBlob = this._pendingPhotoBlobs.get(photo);
                        if (pendingBlob?.scopeKey === scope.key) {
                            const url = await this._uploadBlob(pendingBlob.blob, scope);
                            if (url) {
                                uploadedPhotos.push(url);
                                this._pendingPhotoBlobs.delete(photo);
                                URL.revokeObjectURL(photo);
                            } else {
                                // Keep retrying — but blob: URLs die on app restart,
                                // so promote to IDB for durability across restarts.
                                try {
                                    const idbRef = await idbSavePhoto(pendingBlob.blob);
                                    if (!isAuthIdentityScopeCurrent(scope)) {
                                        await idbDeletePhoto(idbRef);
                                        return;
                                    }
                                    this._registerMediaRef(idbRef, scope);
                                    uploadedPhotos.push(idbRef);
                                } catch {
                                    uploadedPhotos.push(photo);
                                }
                                allPhotosUploaded = false;
                            }
                        }
                        // If blob not in Map → app was restarted and it's gone.
                    } else if (photo.startsWith('data:')) {
                        const url = await this._uploadDataUri(photo, scope);
                        if (url) {
                            uploadedPhotos.push(url);
                        } else {
                            // Keep the data URI for retry.
                            uploadedPhotos.push(photo);
                            allPhotosUploaded = false;
                        }
                    } else {
                        uploadedPhotos.push(photo);
                    }
                }

                // If any photo failed to upload, skip the entry insert for
                // this round — we'll retry on the next sync. Persist the
                // current state of the photos array so any blob:→idb:
                // promotions aren't lost on next sync attempt.
                if (!allPhotosUploaded) {
                    log.info('Deferring entry insert — photos still pending upload');
                    const pendingNow = this._getPendingEntries(scope);
                    const idx = pendingNow.findIndex((e) => e.id === entry.id);
                    if (idx >= 0) {
                        pendingNow[idx] = { ...pendingNow[idx], photos: uploadedPhotos };
                        this._savePending(pendingNow, scope);
                    }
                    continue;
                }

                // 2. Upload pending audio if needed
                let audioUrl = entry.audio_url;
                if (audioUrl && audioUrl.startsWith('data:')) {
                    const uploaded = await this._uploadAudioDataUri(audioUrl, scope);
                    if (uploaded) audioUrl = uploaded;
                }
                if (!isAuthIdentityScopeCurrent(scope)) return;

                // 3. Insert entry to Supabase
                const { data, error } = await supabase
                    .from(TABLE)
                    .insert({
                        user_id: scope.userId,
                        title: entry.title,
                        body: entry.body,
                        mood: entry.mood,
                        photos: uploadedPhotos,
                        audio_url: audioUrl || null,
                        latitude: entry.latitude,
                        longitude: entry.longitude,
                        location_name: entry.location_name,
                        weather_summary: entry.weather_summary,
                        weather_data: entry.weather_data ?? null,
                        voyage_id: entry.voyage_id,
                        tags: entry.tags,
                        is_public: entry.is_public ?? false,
                        created_at: entry.created_at,
                    })
                    .select()
                    .single();

                if (!isAuthIdentityScopeCurrent(scope)) return;

                if (!error && data) {
                    // Remove this entry from pending immediately (crash-safe)
                    const remaining = this._getPendingEntries(scope).filter((e) => e.id !== entry.id);
                    this._savePending(remaining, scope);

                    // Durable offline→server mapping: lets a much-later
                    // delete aimed at the stale offline- id still find the
                    // server row (the _recentlySynced buffer only lives 120s).
                    this._recordIdMapping(entry.id, (data as DiaryEntry).id, scope);

                    // Deleted while this sync was in flight? The user killed
                    // it after we snapshotted the queue — honour the delete
                    // instead of resurrecting it under its new server id.
                    if (this._tombstonedIdSet(scope).has(entry.id)) {
                        const serverRow = { ...(data as DiaryEntry), owner_user_id: scope.userId };
                        this._addTombstone(serverRow.id, serverRow.photos ?? [], serverRow.audio_url, scope);
                        this._removeTombstone(entry.id, scope);
                        this._markRecentlyDrained(entry.id, scope);
                        void this.drainDeletedTombstones();
                        continue;
                    }

                    // Keep the server-returned entry in a short-lived buffer so it
                    // survives the gap between pending removal and server cache refresh
                    this._recentlySynced.push({
                        offlineId: entry.id,
                        entry: { ...(data as DiaryEntry), owner_user_id: scope.userId },
                        syncedAt: Date.now(),
                    });
                    syncedCount++;
                    log.info(`✅ Synced entry: ${entry.title || entry.id}`);
                } else if (error) {
                    log.error(
                        `[Diary] ❌ Supabase error for "${entry.title}":`,
                        error.message,
                        error.code,
                        error.details,
                    );
                    // If it's a duplicate (unique constraint), remove from pending — it's already synced
                    if (error.code === '23505') {
                        log.warn(`Duplicate detected — removing from pending queue`);
                        const remaining = this._getPendingEntries(scope).filter((e) => e.id !== entry.id);
                        this._savePending(remaining, scope);
                        syncedCount++;
                    }
                }
            } catch (e) {
                log.error('Sync failed for entry:', entry.id, e);
                // Leave in pending queue — will retry next sync
            }
        }

        if (syncedCount > 0) {
            // DON'T call _refreshFromServer here — it creates a race condition:
            // the server may not have replicated the newly inserted row yet, so
            // the refresh would overwrite the cache with stale data (missing the
            // just-synced entry). The _recentlySynced buffer + natural 8s polling
            // in DiaryPage handles this safely.
            log.info(`Sync complete — ${syncedCount} entries synced`);
        }
    }

    /** Reliable connectivity check — navigator.onLine is unreliable on iOS/Capacitor */
    private async _checkConnectivity(): Promise<boolean> {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            // If browser says offline, trust it
            return false;
        }
        // Probe Supabase with a lightweight request
        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            if (!supabaseUrl) return navigator?.onLine ?? true;
            const res = await fetch(`${supabaseUrl}/rest/v1/`, {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000),
            });
            return res.ok || res.status === 401 || res.status === 403; // reachable
        } catch (e) {
            // HEAD can fail due to CORS on iOS/Capacitor — be optimistic and try anyway
            log.warn('Connectivity probe failed (proceeding optimistically):', e);
            return true;
        }
    }

    // ── Local Storage ──────────────────────────────────────────

    private _storageKey(baseKey: string, scope: AuthIdentityScope = getAuthIdentityScope()): string {
        return authScopedStorageKey(baseKey, scope);
    }

    private _ownerScope(userId: string | null): AuthIdentityScope {
        return {
            key: userId ? `user:${userId}` : 'anonymous',
            userId,
            // Storage namespacing does not depend on generation.
            generation: getAuthIdentityScope().generation,
        };
    }

    private _entryOwner(entry: unknown, allowLegacyUserId: boolean): string | null | undefined {
        if (!entry || typeof entry !== 'object') return undefined;
        const record = entry as Partial<DiaryEntry>;
        if (Object.prototype.hasOwnProperty.call(record, 'owner_user_id')) {
            if (record.owner_user_id === null) return null;
            if (typeof record.owner_user_id === 'string' && record.owner_user_id.trim()) {
                return record.owner_user_id.trim();
            }
            return undefined;
        }
        if (allowLegacyUserId && typeof record.user_id === 'string' && record.user_id !== 'local' && record.user_id) {
            return record.user_id;
        }
        return undefined;
    }

    private _mediaToken(ref: string): string {
        // FNV-1a-style non-cryptographic fingerprint. The token prevents large
        // data URIs from being duplicated into localStorage; it is an ownership
        // index, not an authentication secret.
        let hash = 0x811c9dc5;
        for (let index = 0; index < ref.length; index++) {
            hash ^= ref.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return `${ref.length}:${(hash >>> 0).toString(36)}`;
    }

    private _registerMediaRef(ref: string | null | undefined, scope: AuthIdentityScope): void {
        if (!ref) return;
        try {
            const key = this._storageKey(MEDIA_OWNERS_KEY, scope);
            const raw = localStorage.getItem(key);
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            const tokens = new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []);
            tokens.add(this._mediaToken(ref));
            localStorage.setItem(key, JSON.stringify([...tokens]));
        } catch (error) {
            log.warn('Diary media ownership write failed:', error);
        }
    }

    private _registerEntryMedia(entry: DiaryEntry, scope: AuthIdentityScope): void {
        for (const photo of entry.photos ?? []) this._registerMediaRef(photo, scope);
        this._registerMediaRef(entry.audio_url, scope);
    }

    private _ownsMediaRef(ref: string, scope: AuthIdentityScope): boolean {
        try {
            const raw = localStorage.getItem(this._storageKey(MEDIA_OWNERS_KEY, scope));
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) && parsed.includes(this._mediaToken(ref));
        } catch {
            return false;
        }
    }

    private _quarantine(sourceKey: string, reason: string, value: unknown): boolean {
        try {
            const raw = localStorage.getItem(QUARANTINE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            const current = Array.isArray(parsed) ? (parsed as QuarantinedDiaryBytes[]) : [];
            current.push({ sourceKey, reason, quarantinedAt: Date.now(), value });
            localStorage.setItem(QUARANTINE_KEY, JSON.stringify(current));
            return true;
        } catch (error) {
            log.warn('Could not quarantine legacy diary bytes; leaving source untouched:', error);
            return false;
        }
    }

    /**
     * Move pre-isolation keys once. Remote cache rows can be attributed by
     * their server user_id. Legacy pending rows used user_id="local", while
     * tombstones/id maps had no owner at all; those bytes are quarantined
     * instead of being guessed into whichever account happens to sign in.
     */
    private _migrateLegacyStorage(): void {
        this._migrateLegacyEntries(CACHE_KEY, true);
        this._migrateLegacyEntries(PENDING_KEY, false);
        this._migrateLegacyTombstones();
        this._migrateLegacyIdMappings();
    }

    private _migrateLegacyEntries(sourceKey: string, allowLegacyUserId: boolean): void {
        const raw = localStorage.getItem(sourceKey);
        if (raw === null) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            if (this._quarantine(sourceKey, 'invalid JSON', raw)) localStorage.removeItem(sourceKey);
            return;
        }
        if (!Array.isArray(parsed)) {
            if (this._quarantine(sourceKey, 'unexpected legacy shape', parsed)) localStorage.removeItem(sourceKey);
            return;
        }

        const grouped = new Map<string, { scope: AuthIdentityScope; entries: DiaryEntry[] }>();
        const ambiguous: unknown[] = [];
        for (const value of parsed) {
            const owner = this._entryOwner(value, allowLegacyUserId);
            if (owner === undefined) {
                ambiguous.push(value);
                continue;
            }
            const scope = this._ownerScope(owner);
            const group = grouped.get(scope.key) ?? { scope, entries: [] };
            const entry = { ...(value as DiaryEntry), owner_user_id: owner };
            group.entries.push(entry);
            grouped.set(scope.key, group);
        }

        try {
            for (const { scope, entries } of grouped.values()) {
                const targetKey = this._storageKey(sourceKey, scope);
                const targetRaw = localStorage.getItem(targetKey);
                const targetParsed: unknown = targetRaw ? JSON.parse(targetRaw) : [];
                const existing = Array.isArray(targetParsed) ? (targetParsed as DiaryEntry[]) : [];
                const byId = new Map(existing.map((entry) => [entry.id, entry]));
                for (const entry of entries) {
                    byId.set(entry.id, entry);
                    this._registerEntryMedia(entry, scope);
                }
                localStorage.setItem(targetKey, JSON.stringify([...byId.values()]));
            }
            if (
                ambiguous.length === 0 ||
                this._quarantine(sourceKey, 'legacy records had no validated owner', ambiguous)
            ) {
                localStorage.removeItem(sourceKey);
            }
        } catch (error) {
            // Copy-before-remove: the legacy bytes stay recoverable on quota or
            // malformed target failures and remain invisible to scoped reads.
            log.warn('Legacy diary entry migration deferred:', error);
        }
    }

    private _migrateLegacyTombstones(): void {
        const raw = localStorage.getItem(DELETED_KEY);
        if (raw === null) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            if (this._quarantine(DELETED_KEY, 'invalid JSON', raw)) localStorage.removeItem(DELETED_KEY);
            return;
        }
        if (!Array.isArray(parsed)) {
            if (this._quarantine(DELETED_KEY, 'unexpected legacy shape', parsed)) localStorage.removeItem(DELETED_KEY);
            return;
        }

        const grouped = new Map<string, { scope: AuthIdentityScope; tombstones: DiaryTombstone[] }>();
        const ambiguous: unknown[] = [];
        for (const value of parsed) {
            if (!value || typeof value !== 'object') {
                ambiguous.push(value);
                continue;
            }
            const record = value as Partial<DiaryTombstone>;
            const owner = Object.prototype.hasOwnProperty.call(record, 'owner_user_id')
                ? record.owner_user_id
                : undefined;
            if (owner !== null && (typeof owner !== 'string' || !owner.trim())) {
                ambiguous.push(value);
                continue;
            }
            const scope = this._ownerScope(owner);
            const group = grouped.get(scope.key) ?? { scope, tombstones: [] };
            group.tombstones.push({ ...(record as DiaryTombstone), owner_user_id: owner });
            grouped.set(scope.key, group);
        }
        try {
            for (const { scope, tombstones } of grouped.values()) {
                const targetKey = this._storageKey(DELETED_KEY, scope);
                const existingRaw = localStorage.getItem(targetKey);
                const existingParsed: unknown = existingRaw ? JSON.parse(existingRaw) : [];
                const existing = Array.isArray(existingParsed) ? (existingParsed as DiaryTombstone[]) : [];
                const byId = new Map(existing.map((tombstone) => [tombstone.id, tombstone]));
                for (const tombstone of tombstones) byId.set(tombstone.id, tombstone);
                localStorage.setItem(targetKey, JSON.stringify([...byId.values()]));
            }
            if (
                ambiguous.length === 0 ||
                this._quarantine(DELETED_KEY, 'legacy tombstones had no validated owner', ambiguous)
            ) {
                localStorage.removeItem(DELETED_KEY);
            }
        } catch (error) {
            log.warn('Legacy diary tombstone migration deferred:', error);
        }
    }

    private _migrateLegacyIdMappings(): void {
        const raw = localStorage.getItem(IDMAP_KEY);
        if (raw === null) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            if (this._quarantine(IDMAP_KEY, 'invalid JSON', raw)) localStorage.removeItem(IDMAP_KEY);
            return;
        }
        if (!Array.isArray(parsed)) {
            if (this._quarantine(IDMAP_KEY, 'unexpected legacy shape', parsed)) localStorage.removeItem(IDMAP_KEY);
            return;
        }

        const grouped = new Map<string, { scope: AuthIdentityScope; mappings: DiaryIdMapping[] }>();
        const ambiguous: unknown[] = [];
        for (const value of parsed) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                ambiguous.push(value);
                continue;
            }
            const record = value as Partial<DiaryIdMapping>;
            const owner = Object.prototype.hasOwnProperty.call(record, 'owner_user_id')
                ? record.owner_user_id
                : undefined;
            if (
                (owner !== null && (typeof owner !== 'string' || !owner.trim())) ||
                typeof record.offlineId !== 'string' ||
                typeof record.serverId !== 'string'
            ) {
                ambiguous.push(value);
                continue;
            }
            const scope = this._ownerScope(owner);
            const group = grouped.get(scope.key) ?? { scope, mappings: [] };
            group.mappings.push(record as DiaryIdMapping);
            grouped.set(scope.key, group);
        }
        try {
            for (const { scope, mappings } of grouped.values()) {
                const targetKey = this._storageKey(IDMAP_KEY, scope);
                const existingRaw = localStorage.getItem(targetKey);
                const existingParsed: unknown = existingRaw ? JSON.parse(existingRaw) : [];
                const existing = Array.isArray(existingParsed) ? (existingParsed as DiaryIdMapping[]) : [];
                const byOfflineId = new Map(existing.map((mapping) => [mapping.offlineId, mapping]));
                for (const mapping of mappings) byOfflineId.set(mapping.offlineId, mapping);
                localStorage.setItem(targetKey, JSON.stringify([...byOfflineId.values()].slice(-IDMAP_MAX)));
            }
            if (
                ambiguous.length === 0 ||
                this._quarantine(IDMAP_KEY, 'legacy id mappings had no validated owner', ambiguous)
            ) {
                localStorage.removeItem(IDMAP_KEY);
            }
        } catch (error) {
            log.warn('Legacy diary id-map migration deferred:', error);
        }
    }

    private _getCachedEntries(scope: AuthIdentityScope = getAuthIdentityScope()): DiaryEntry[] {
        this._migrateLegacyStorage();
        try {
            const raw = localStorage.getItem(this._storageKey(CACHE_KEY, scope));
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            return (parsed as DiaryEntry[]).filter((entry) => this._entryOwner(entry, false) === scope.userId);
        } catch (e) {
            log.warn('Cache read failed:', e);
            return [];
        }
    }

    private _saveCachedEntries(entries: DiaryEntry[], scope: AuthIdentityScope = getAuthIdentityScope()): void {
        try {
            const owned = entries.map((entry) => ({ ...entry, owner_user_id: scope.userId }));
            for (const entry of owned) this._registerEntryMedia(entry, scope);
            localStorage.setItem(this._storageKey(CACHE_KEY, scope), JSON.stringify(owned));
        } catch (e) {
            log.warn('Cache write failed:', e);
        }
    }

    // ── Tombstone store ────────────────────────────────────────

    private _getTombstones(scope: AuthIdentityScope = getAuthIdentityScope()): DiaryTombstone[] {
        this._migrateLegacyStorage();
        const now = Date.now();
        const persisted: DiaryTombstone[] = [];
        try {
            const raw = localStorage.getItem(this._storageKey(DELETED_KEY, scope));
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed)) {
                for (const t of parsed) {
                    if (!t || typeof t !== 'object') continue;
                    const rec = t as Partial<DiaryTombstone>;
                    if (typeof rec.id !== 'string') continue;
                    if (rec.owner_user_id !== scope.userId) continue;
                    const deletedAt = typeof rec.deletedAt === 'number' ? rec.deletedAt : 0;
                    if (now - deletedAt >= TOMBSTONE_TTL_MS) continue;
                    persisted.push({
                        id: rec.id,
                        photos: Array.isArray(rec.photos) ? rec.photos.filter((p) => typeof p === 'string') : [],
                        audio: typeof rec.audio === 'string' ? rec.audio : null,
                        deletedAt,
                        owner_user_id: scope.userId,
                    });
                }
                if (persisted.length !== parsed.length) this._saveTombstones(persisted, scope);
            }
        } catch (e) {
            log.warn('Tombstone read failed:', e);
        }
        // Merge quota-fallback tombstones that never made it to disk.
        const memory = (this._memTombstones.get(scope.key) ?? []).filter(
            (t) => t.owner_user_id === scope.userId && now - t.deletedAt < TOMBSTONE_TTL_MS,
        );
        this._memTombstones.set(scope.key, memory);
        if (memory.length === 0) return persisted;
        const persistedIds = new Set(persisted.map((t) => t.id));
        return [...persisted, ...memory.filter((t) => !persistedIds.has(t.id))];
    }

    /** True if the write actually landed — quota failures return false. */
    private _saveTombstones(tombs: DiaryTombstone[], scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
        try {
            if (tombs.some((tombstone) => tombstone.owner_user_id !== scope.userId)) {
                log.error('Refusing to persist a diary tombstone under the wrong owner');
                return false;
            }
            localStorage.setItem(this._storageKey(DELETED_KEY, scope), JSON.stringify(tombs));
            return true;
        } catch (e) {
            log.warn('Tombstone write failed:', e);
            return false;
        }
    }

    private _addTombstone(
        id: string,
        photos: string[],
        audio?: string | null,
        scope: AuthIdentityScope = getAuthIdentityScope(),
    ): void {
        const tomb: DiaryTombstone = {
            id,
            photos,
            audio: audio ?? null,
            deletedAt: Date.now(),
            owner_user_id: scope.userId,
        };
        const all = this._getTombstones(scope).filter((t) => t.id !== id);
        all.push(tomb);
        if (this._saveTombstones(all, scope)) {
            // Everything (including any earlier quota-fallback records merged
            // in by _getTombstones) is on disk now.
            this._memTombstones.set(scope.key, []);
        } else {
            // Quota-degraded: the delete stays honoured for this session, and
            // drainable, via memory. Lost on relaunch — best effort.
            const memory = (this._memTombstones.get(scope.key) ?? []).filter((t) => t.id !== id);
            memory.push(tomb);
            this._memTombstones.set(scope.key, memory);
        }
    }

    private _removeTombstone(id: string, scope: AuthIdentityScope = getAuthIdentityScope()): void {
        this._memTombstones.set(
            scope.key,
            (this._memTombstones.get(scope.key) ?? []).filter((t) => t.id !== id),
        );
        this._saveTombstones(
            this._getTombstones(scope).filter((t) => t.id !== id),
            scope,
        );
    }

    private _tombstonedIdSet(scope: AuthIdentityScope = getAuthIdentityScope()): Set<string> {
        return new Set(this._getTombstones(scope).map((t) => t.id));
    }

    /** Drained-tombstone grace filter — see RECENT_DRAIN_GRACE_MS. */
    private _isRecentlyDrained(id: string, scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
        const recent = this._recentlyDrained.get(scope.key);
        const at = recent?.get(id);
        if (at === undefined) return false;
        if (Date.now() - at > RECENT_DRAIN_GRACE_MS) {
            recent?.delete(id);
            return false;
        }
        return true;
    }

    private _markRecentlyDrained(id: string, scope: AuthIdentityScope): void {
        const recent = this._recentlyDrained.get(scope.key) ?? new Map<string, number>();
        recent.set(id, Date.now());
        this._recentlyDrained.set(scope.key, recent);
    }

    // ── Offline→server id map ──────────────────────────────────
    // Written at sync time; lets a delete aimed at a STALE offline- id (the
    // 120s _recentlySynced buffer long gone, or the app relaunched) still
    // find and kill the entry's real server row.

    private _recordIdMapping(
        offlineId: string,
        serverId: string,
        scope: AuthIdentityScope = getAuthIdentityScope(),
    ): void {
        this._migrateLegacyStorage();
        try {
            const key = this._storageKey(IDMAP_KEY, scope);
            const raw = localStorage.getItem(key);
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            const list = Array.isArray(parsed)
                ? (parsed.filter(
                      (mapping): mapping is DiaryIdMapping =>
                          !!mapping &&
                          typeof mapping === 'object' &&
                          typeof (mapping as DiaryIdMapping).offlineId === 'string' &&
                          typeof (mapping as DiaryIdMapping).serverId === 'string' &&
                          (mapping as DiaryIdMapping).owner_user_id === scope.userId,
                  ) as DiaryIdMapping[])
                : [];
            const next = list.filter((mapping) => mapping.offlineId !== offlineId);
            next.push({ offlineId, serverId, owner_user_id: scope.userId });
            localStorage.setItem(key, JSON.stringify(next.slice(-IDMAP_MAX)));
        } catch (e) {
            log.warn('Id-map write failed:', e);
        }
    }

    /** Server id an offline- entry synced as, if known. Public: DiaryPage uses it to spot shadowed offline copies. */
    resolveServerId(offlineId: string): string | null {
        const scope = getAuthIdentityScope();
        this._migrateLegacyStorage();
        try {
            const raw = localStorage.getItem(this._storageKey(IDMAP_KEY, scope));
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return null;
            const hit = parsed.find(
                (mapping) =>
                    !!mapping &&
                    typeof mapping === 'object' &&
                    (mapping as DiaryIdMapping).offlineId === offlineId &&
                    (mapping as DiaryIdMapping).owner_user_id === scope.userId,
            ) as DiaryIdMapping | undefined;
            return hit && typeof hit.serverId === 'string' ? hit.serverId : null;
        } catch {
            return null;
        }
    }

    private _getPendingEntries(scope: AuthIdentityScope = getAuthIdentityScope()): DiaryEntry[] {
        this._migrateLegacyStorage();
        try {
            const raw = localStorage.getItem(this._storageKey(PENDING_KEY, scope));
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            return (parsed as DiaryEntry[]).filter((entry) => this._entryOwner(entry, false) === scope.userId);
        } catch (e) {
            log.warn('Pending read failed:', e);
            return [];
        }
    }

    private _savePending(entries: DiaryEntry[], scope: AuthIdentityScope = getAuthIdentityScope()): void {
        const owned = entries.filter((entry) => this._entryOwner(entry, false) === scope.userId);
        if (owned.length !== entries.length) {
            const rejected = entries.filter((entry) => this._entryOwner(entry, false) !== scope.userId);
            this._quarantine(PENDING_KEY, 'refused cross-owner pending write', rejected);
            log.error('Refusing to persist diary drafts under a different owner');
        }
        try {
            // Strip blob: URLs — they're process-scoped and can't survive a
            // restart anyway. KEEP idb: refs (tiny strings pointing to Blobs
            // in IndexedDB) and data: URIs (legacy entries).
            const cleaned = owned.map((e) => ({
                ...e,
                photos: e.photos.filter((p) => !p.startsWith('blob:')),
            }));
            for (const entry of cleaned) this._registerEntryMedia(entry, scope);
            localStorage.setItem(this._storageKey(PENDING_KEY, scope), JSON.stringify(cleaned));
        } catch (e) {
            // localStorage full — most likely cause is a legacy entry with
            // data: URIs. Strip all non-URL and non-idb photos as a last
            // resort so at least the text content survives.
            log.error('Pending write failed, retrying with photos stripped:', e);
            try {
                const minimal = owned.map((en) => ({
                    ...en,
                    photos: en.photos.filter(
                        (p) => p.startsWith('http://') || p.startsWith('https://') || p.startsWith(IDB_PHOTO_PREFIX),
                    ),
                }));
                for (const entry of minimal) this._registerEntryMedia(entry, scope);
                localStorage.setItem(this._storageKey(PENDING_KEY, scope), JSON.stringify(minimal));
            } catch (e2) {
                log.error('Pending write CRITICALLY failed — entries may be lost:', e2);
            }
        }
    }

    /**
     * Add a pending entry. Photos are expected to be durable references
     * (idb: refs, data: URIs, or http[s]: URLs) — see uploadPhoto(). Legacy
     * blob: URLs that somehow reach here get promoted to idb: refs so they
     * survive WKWebView process suspend.
     */
    private async _addPending(entry: DiaryEntry, scope: AuthIdentityScope): Promise<void> {
        if (entry.owner_user_id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Diary entry owner changed before persistence');
        }
        const persistedPhotos: string[] = [];
        for (const photo of entry.photos) {
            if (photo.startsWith('blob:')) {
                // Legacy — promote to IndexedDB for durability.
                const pendingBlob = this._pendingPhotoBlobs.get(photo);
                if (pendingBlob?.scopeKey === scope.key) {
                    try {
                        const idbRef = await idbSavePhoto(pendingBlob.blob);
                        if (!isAuthIdentityScopeCurrent(scope)) {
                            await idbDeletePhoto(idbRef);
                            throw new Error('Authentication changed while persisting a diary photo');
                        }
                        this._registerMediaRef(idbRef, scope);
                        persistedPhotos.push(idbRef);
                        continue;
                    } catch {
                        // Fall back to data URI if IDB write fails.
                        const dataUri = await this._blobToCompressedDataUri(pendingBlob.blob);
                        if (!isAuthIdentityScopeCurrent(scope)) {
                            throw new Error('Authentication changed while persisting a diary photo');
                        }
                        if (dataUri) {
                            this._registerMediaRef(dataUri, scope);
                            persistedPhotos.push(dataUri);
                            continue;
                        }
                    }
                }
                // No recoverable bytes for this blob — drop the reference.
            } else {
                persistedPhotos.push(photo);
            }
        }

        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Authentication changed before diary persistence completed');
        }
        const persistedEntry = { ...entry, photos: persistedPhotos, owner_user_id: scope.userId };
        const pending = this._getPendingEntries(scope);
        pending.unshift(persistedEntry);
        this._savePending(pending, scope);
    }

    /** Compress a blob to a small base64 data URI (600px max) for localStorage persistence */
    private async _blobToCompressedDataUri(blob: Blob): Promise<string | null> {
        try {
            const PERSIST_MAX = 600; // Smaller than normal photos to fit in localStorage
            return new Promise((resolve) => {
                const img = new Image();
                const objectUrl = URL.createObjectURL(blob);
                img.onload = () => {
                    URL.revokeObjectURL(objectUrl);
                    const canvas = document.createElement('canvas');
                    let { width, height } = img;
                    if (width > PERSIST_MAX || height > PERSIST_MAX) {
                        const ratio = Math.min(PERSIST_MAX / width, PERSIST_MAX / height);
                        width *= ratio;
                        height *= ratio;
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d')!;
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.6));
                };
                img.onerror = () => {
                    URL.revokeObjectURL(objectUrl);
                    resolve(null);
                };
                img.src = objectUrl;
            });
        } catch {
            return null;
        }
    }

    private _invalidateCache(): void {
        try {
            localStorage.removeItem(this._storageKey(CACHE_KEY));
        } catch (e) {
            log.warn('Cache invalidation failed:', e);
        }
    }

    private async _refreshFromServer(limit: number, scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
        // Deduplicate concurrent calls — reuse in-flight promise
        const active = this._refreshPromise;
        if (active?.generation === scope.generation) return active.promise;
        const promise = this._doRefreshFromServer(limit, scope);
        this._refreshPromise = { generation: scope.generation, promise };
        try {
            await promise;
        } finally {
            if (this._refreshPromise?.promise === promise) this._refreshPromise = null;
        }
    }

    private async _doRefreshFromServer(limit: number, scope: AuthIdentityScope): Promise<void> {
        // NOTE: Don't gate on navigator.onLine — it's unreliable on Capacitor.
        // Let the fetch fail gracefully in the try/catch below instead.
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return;

            const { data } = await supabase
                .from(TABLE)
                .select('*')
                .eq('user_id', scope.userId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (!isAuthIdentityScopeCurrent(scope)) return;
            this._lastRefreshTime = Date.now();

            if (data) {
                const serverEntries = (data as DiaryEntry[])
                    .filter((entry) => entry.user_id === scope.userId)
                    .map((entry) => ({ ...entry, owner_user_id: scope.userId }));
                // IMPORTANT: Always save whatever the server returns (even empty).
                // This ensures deleted entries are properly removed from the cache.
                // But we must ALSO preserve any still-pending entries so they don't
                // vanish from the UI while waiting for sync.
                const pending = this._getPendingEntries(scope);

                // Purge stale entries from recently-synced buffer (>30s)
                const now = Date.now();
                this._recentlySynced = this._recentlySynced.filter((r) => now - r.syncedAt < 120_000);

                // Collect all IDs already in server data
                const serverIds = new Set(serverEntries.map((e) => e.id));

                // Merge: server data + pending entries + recently-synced buffer
                // (pending and recently-synced win on collision with server data)
                const pendingNotOnServer = pending.filter((e) => !serverIds.has(e.id));
                const recentNotOnServer = this._recentlySynced.map((r) => r.entry).filter((e) => !serverIds.has(e.id));

                // Locally-deleted entries whose server delete hasn't drained yet
                // still come back in the server payload — keep them out of the
                // cache or the delete appears to "undo" itself.
                const deletedIds = this._tombstonedIdSet(scope);
                const merged = [...pendingNotOnServer, ...recentNotOnServer, ...serverEntries]
                    .filter((e) => !deletedIds.has(e.id) && !this._isRecentlyDrained(e.id, scope))
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
                if (!isAuthIdentityScopeCurrent(scope)) return;
                this._saveCachedEntries(merged, scope);
            }
        } catch (e) {
            log.error('Server refresh failed:', e);
        }
    }

    // ── Image Compression ──────────────────────────────────────

    private async _compressImage(file: File): Promise<Blob> {
        return new Promise((resolve) => {
            const img = new Image();
            const reader = new FileReader();
            reader.onload = (e) => {
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let { width, height } = img;
                    if (width > MAX_PHOTO_SIZE || height > MAX_PHOTO_SIZE) {
                        const ratio = Math.min(MAX_PHOTO_SIZE / width, MAX_PHOTO_SIZE / height);
                        width *= ratio;
                        height *= ratio;
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d')!;
                    ctx.drawImage(img, 0, 0, width, height);
                    canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.82);
                };
                img.src = e.target?.result as string;
            };
            reader.readAsDataURL(file);
        });
    }

    private _extractStoragePath(url: string, bucket: string): string | null {
        try {
            const privatePrefix = `${STORAGE_REF_PREFIX}${bucket}:`;
            if (url.startsWith(privatePrefix)) return url.slice(privatePrefix.length);
            const match = url.match(new RegExp(`${bucket}/(.+)$`));
            return match ? decodeURIComponent(match[1].split('?')[0]) : null;
        } catch (e) {
            log.warn('Storage path extraction failed:', e);
            return null;
        }
    }

    // ── GPS ────────────────────────────────────────────────────

    async getCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
        try {
            // Use GpsService which handles web (navigator.geolocation with permission
            // prompt) vs native (BgGeoManager/Transistorsoft) automatically
            const { GpsService } = await import('./GpsService');
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 10_000, timeoutSec: 15 });
            if (pos) return { lat: pos.latitude, lon: pos.longitude };
            return null;
        } catch (e) {
            log.warn('GPS location failed:', e);
            return null;
        }
    }

    /** Reverse geocode lat/lon to a human-readable place name via Nominatim */
    async reverseGeocode(lat: number, lon: number): Promise<string | null> {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&addressdetails=1`,
                { headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' } },
            );
            if (!res.ok) return null;
            const data = await res.json();
            // Build a concise location name from address parts
            const addr = data.address || {};
            const parts: string[] = [];
            if (addr.harbour || addr.marina) parts.push(addr.harbour || addr.marina);
            else if (addr.beach) parts.push(addr.beach);
            else if (addr.locality || addr.suburb || addr.town || addr.city || addr.village) {
                parts.push(addr.locality || addr.suburb || addr.town || addr.city || addr.village);
            }
            if (addr.state) parts.push(addr.state);
            else if (addr.county) parts.push(addr.county);
            return parts.length > 0
                ? parts.join(', ')
                : data.display_name?.split(',').slice(0, 2).join(',').trim() || null;
        } catch (e) {
            log.warn('Reverse geocode failed:', e);
            return null;
        }
    }

    // ── Gemini AI ──────────────────────────────────────────────

    async enhanceWithGemini(
        body: string,
        context: {
            mood: DiaryMood;
            location?: string;
            weather?: string;
            intensity?: number; // 0=clean grammar, 100=shakespearean
        },
    ): Promise<string | null> {
        const scope = getAuthIdentityScope();
        if (!navigator.onLine) return null;

        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            if (!supabaseUrl) return null;
            const headers = await getAuthenticatedFunctionHeaders();
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            const res = await fetch(`${supabaseUrl}/functions/v1/gemini-diary`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    action: 'enhance',
                    text: body,
                    mood: context.mood,
                    location: context.location || '',
                    weather: context.weather || '',
                    intensity: context.intensity ?? 30,
                }),
            });

            if (!res.ok || !isAuthIdentityScopeCurrent(scope)) return null;
            const data = await res.json();
            return data?.enhanced || null;
        } catch (e) {
            log.error('Gemini enhance failed:', e);
            return null;
        }
    }

    // ── Audio ──────────────────────────────────────────────────

    async uploadAudio(blob: Blob): Promise<string | null> {
        const scope = getAuthIdentityScope();
        // Convert to data URI for offline storage
        const dataUri = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
        });
        if (!isAuthIdentityScopeCurrent(scope)) return null;

        // Try upload if online
        if (supabase && navigator.onLine && scope.userId) {
            const url = await this._uploadAudioBlob(blob, scope);
            if (url && isAuthIdentityScopeCurrent(scope)) {
                this._registerMediaRef(url, scope);
                return url;
            }
        }

        // Return data URI — will be uploaded during sync
        this._registerMediaRef(dataUri, scope);
        return dataUri;
    }

    private async _uploadAudioBlob(blob: Blob, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        try {
            const path = `${scope.userId}/${Date.now()}.webm`;
            const { error } = await supabase.storage
                .from(AUDIO_BUCKET)
                .upload(path, blob, { contentType: 'audio/webm', upsert: false });

            if (error || !isAuthIdentityScopeCurrent(scope)) return null;

            return `${STORAGE_REF_PREFIX}${AUDIO_BUCKET}:${path}`;
        } catch (e) {
            log.error('Audio blob upload failed:', e);
            return null;
        }
    }

    private async _uploadAudioDataUri(dataUri: string, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        try {
            const res = await fetch(dataUri);
            const blob = await res.blob();
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            return this._uploadAudioBlob(blob, scope);
        } catch (e) {
            log.error('Audio data URI upload failed:', e);
            return null;
        }
    }

    async transcribeAudio(audioUrl: string, mimeType?: string): Promise<string | null> {
        const scope = getAuthIdentityScope();
        if (!navigator.onLine) return null;

        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            if (!supabaseUrl) return null;
            const headers = await getAuthenticatedFunctionHeaders();
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            // Fetch audio as base64. Private bucket refs are signed only for
            // the current authenticated owner and expire after one hour.
            const resolvedAudioUrl = await this.resolveAudioUrl(audioUrl);
            if (!resolvedAudioUrl || !isAuthIdentityScopeCurrent(scope)) return null;
            const audioRes = await fetch(resolvedAudioUrl);
            const audioBlob = await audioRes.blob();
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            // Detect MIME type: explicit param > blob type > fallback
            const detectedMime = mimeType || audioBlob.type || 'audio/mp4';
            const base64 = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    resolve(result.split(',')[1] || result);
                };
                reader.readAsDataURL(audioBlob);
            });

            const res = await fetch(`${supabaseUrl}/functions/v1/gemini-diary`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    action: 'transcribe',
                    audio_base64: base64,
                    mime_type: detectedMime,
                }),
            });

            if (!res.ok || !isAuthIdentityScopeCurrent(scope)) return null;
            const data = await res.json();
            return data?.transcript || null;
        } catch (e) {
            log.error('Audio transcription failed:', e);
            return null;
        }
    }

    // ── Status ─────────────────────────────────────────────────

    getPendingCount(): number {
        return this._getPendingEntries().length;
    }
}

// Singleton
export const DiaryService = new DiaryServiceClass();
