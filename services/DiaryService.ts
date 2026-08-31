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
import { boundedLocalQuarantine } from '../utils/localPrivacyRetention';
import { Capacitor } from '@capacitor/core';
import { BackgroundFetch } from '@transistorsoft/capacitor-background-fetch';
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
    cancelDiaryDirect,
    cancelDiaryOnPi,
    canAttemptDiaryCloudDelivery,
    handoffDiaryToPi,
    submitDiaryDirect,
    syncPiDiaryRelayInternetPolicy,
    handoffVideoToPi,
    isPiVideoRelayAvailable,
    type DiaryRelayEnvelope,
} from './DiaryRelayTransport';
import { onConnectionChange } from './ConnectionPriorityService';
import { VoyageLogService } from './VoyageLogService';
import { ShipLogService } from './ShipLogService';
import {
    savePhoto as idbSavePhoto,
    loadPhoto as idbLoadPhoto,
    deletePhoto as idbDeletePhoto,
    isIdbPhoto,
    IDB_PHOTO_PREFIX,
    saveAudio as idbSaveAudio,
    loadAudio as idbLoadAudio,
    deleteAudio as idbDeleteAudio,
    isIdbAudio,
    saveVideo as idbSaveVideo,
    loadVideo as idbLoadVideo,
    deleteVideo as idbDeleteVideo,
    isIdbVideo,
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
    audio_url: string | null; // Voice memo URL (or idb-audio: ref while offline)
    /** Short video clip URL (or idb-video: ref while it waits for upload). */
    video_url?: string | null;
    latitude: number | null;
    longitude: number | null;
    location_name: string;
    weather_summary: string;
    weather_data?: DiaryWeatherData | null; // Structured weather at pin
    voyage_id: string | null;
    /**
     * Immutable `boats.id` selected when this note was created. It keeps a
     * delivery skipper's journal on the right vessel even after switching
     * their default fleet profile.
     */
    boat_id?: string | null;
    tags: string[];
    is_public: boolean; // Published to the public Voyage Log API
    created_at: string;
    updated_at: string;
    /**
     * Stable logical write id. It converges the direct-device and Pi-relay
     * paths on one Supabase row, and is never displayed to a punter.
     */
    client_operation_id?: string | null;
    /** Monotonic local revision used to reject late Pi snapshots. */
    client_revision?: number | null;
    /**
     * Device-only public-publish intent for an entry that has not reached
     * Supabase yet. `is_public` remains false in the UI until confirmation.
     */
    publish_requested?: boolean;
    /**
     * Immutable local queue/cache owner. Never sent to diary_entries; it
     * prevents one signed-in account from adopting another account's work.
     */
    readonly owner_user_id?: string | null;
    /** Device-only exact photo refs retired after this revision is canonical. */
    _retirePhotos?: string[];
    /** Device-only exact audio refs retired after this revision is canonical. */
    _retireAudio?: string[];
    /** Legacy server rows must bind an operation id before relay updates. */
    _requiresOperationClaim?: boolean;
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
const VIDEO_BUCKET = 'diary-video';
/**
 * How long a DIRECT video upload may take before the paired Pi takes over:
 * one second per megabyte (~8 Mbit/s effective) with a one-minute floor. A
 * solid connection finishes any clip comfortably inside this; a boat uplink
 * does not, and that is the Pi's whole job. Only applied when a Pi is
 * actually standing by — with no Pi the attempt gets open-ended patience.
 */
const directVideoBudgetMs = (sizeBytes: number): number => Math.max(60_000, Math.round(sizeBytes / 1_000_000) * 1000);
const STORAGE_REF_PREFIX = 'storage:';
const CACHE_KEY = 'thalassa_diary_entries_v2';
const PENDING_KEY = 'thalassa_diary_pending_v2';
const DELETED_KEY = 'thalassa_diary_deleted_v1';
const IDMAP_KEY = 'thalassa_diary_idmap_v1';
const MEDIA_OWNERS_KEY = 'thalassa_diary_media_owners_v1';
const MEDIA_CLEANUP_KEY = 'thalassa_diary_media_cleanup_v1';
const QUARANTINE_KEY = 'thalassa_diary_quarantine_v1';
const IDMAP_MAX = 300;
const MAX_PHOTO_SIZE = 1200;
// Voice transcription and styling should never strand the compose screen on
// a poor offshore connection. The raw dictated words remain available if an
// AI request times out.
const VOICE_AI_REQUEST_TIMEOUT_MS = 20_000;
// Storage uploads use a separate deadline because the Supabase client does
// not expose an AbortSignal for multipart uploads. A timed-out request may
// still settle in the background, so _uploadAudioBlob cleans a late object.
const AUDIO_UPLOAD_TIMEOUT_MS = 20_000;
// A delete is a safety fence, not a best-effort cache hint. It remains until
// the authoritative cloud cancellation/delete succeeds; time-based expiry
// would let a long-offshore Pi retry resurrect a diary the skipper removed.
// After a tombstone drains, keep filtering its id from reads for a grace
// window: a server refresh that was already in flight when the drain landed
// carries a pre-delete payload, and the tombstone that would have filtered
// it is gone by the time that payload is merged.
const RECENT_DRAIN_GRACE_MS = 5 * 60 * 1000;

function newDiaryOperationId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `diary_${crypto.randomUUID().replace(/-/g, '')}`;
    }
    return `diary_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

const fetchVoiceAiWithDeadline = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VOICE_AI_REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
};

/**
 * MediaRecorder commonly reports codec parameters (for example
 * `audio/webm;codecs=opus`). Storage and Gemini expect the canonical MIME
 * type, so normalise it once at the service boundary.
 */
export const normalizeDiaryAudioMimeType = (value?: string | null): string => {
    const raw = value?.split(';', 1)[0]?.trim().toLowerCase() || '';
    switch (raw) {
        case 'audio/x-wav':
            return 'audio/wav';
        case 'audio/x-m4a':
            return 'audio/mp4';
        case 'audio/webm':
        case 'audio/mp4':
        case 'audio/mpeg':
        case 'audio/wav':
        case 'audio/ogg':
        case 'audio/aac':
            return raw;
        default:
            return 'audio/mp4';
    }
};

export const diaryAudioFileExtension = (mimeType?: string | null): string => {
    switch (normalizeDiaryAudioMimeType(mimeType)) {
        case 'audio/webm':
            return 'webm';
        case 'audio/mpeg':
            return 'mp3';
        case 'audio/wav':
            return 'wav';
        case 'audio/ogg':
            return 'ogg';
        case 'audio/aac':
            return 'aac';
        default:
            return 'm4a';
    }
};

/**
 * A locally-committed delete awaiting server confirmation. `photos`/`audio`
 * snapshot the entry's storage URLs at delete time so the drain can clean
 * the buckets even after the entry is gone from every local cache.
 */
interface DiaryTombstone {
    id: string;
    /** Stable operation id, if this row may also exist in the Pi outbox. */
    client_operation_id?: string | null;
    photos: string[];
    audio?: string | null;
    video?: string | null;
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

interface DiaryMediaCleanupJob {
    id: string;
    entryId: string;
    readonly owner_user_id: string;
    refs: Array<{ bucket: typeof PHOTO_BUCKET | typeof AUDIO_BUCKET | typeof VIDEO_BUCKET; ref: string }>;
    createdAt: number;
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
    private _mediaCleanupPromise: { generation: number; promise: Promise<void> } | null = null;
    // Buffer of recently-synced entries — prevents race condition where entry
    // vanishes between pending removal and server cache arrival. `offlineId`
    // maps the original offline- id to the real server row.
    private _recentlySynced: { offlineId: string; entry: DiaryEntry; syncedAt: number }[] = [];
    // In-memory cache of photo blobs keyed by blob: URL — avoids base64 in localStorage
    private _pendingPhotoBlobs = new Map<string, { blob: Blob; scopeKey: string }>();
    // Cache mapping idb: references → short-lived blob URLs for <img> rendering.
    // Avoids re-reading IndexedDB on every render.
    private _idbRefToBlobUrl = new Map<string, string>();
    private _idbVideoRefToBlobUrl = new Map<string, string>();
    // Same cache for voice memos stored in IndexedDB while an entry waits to sync.
    private _idbAudioRefToBlobUrl = new Map<string, string>();
    private _signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
    private _backgroundRetryConfigured = false;

    constructor() {
        subscribeAuthIdentityScope((next) => {
            // New calls are allowed to start immediately in the new namespace;
            // old promises retain their captured scope and fail generation checks.
            this._syncPromise = null;
            this._refreshPromise = null;
            this._drainPromise = null;
            this._mediaCleanupPromise = null;
            this._lastRefreshTime = 0;
            this._recentlySynced = [];
            for (const url of this._idbRefToBlobUrl.values()) URL.revokeObjectURL(url);
            this._idbRefToBlobUrl.clear();
            for (const url of this._idbAudioRefToBlobUrl.values()) URL.revokeObjectURL(url);
            this._idbAudioRefToBlobUrl.clear();
            this._signedUrlCache.clear();
            if (next.userId) queueMicrotask(() => void this._drainRetiredMedia(next));
        });
        // Auto-sync when connectivity resumes
        if (typeof window !== 'undefined') {
            // The Pi has its own retry worker, so propagate the phone's
            // satellite policy as soon as the connection classifier changes
            // rather than waiting for a new diary entry to be written. This
            // is intentionally a policy update, not an assertion that the
            // phone itself has a usable internet route.
            onConnectionChange(() => {
                void syncPiDiaryRelayInternetPolicy();
                this._retryPendingVoyageLogEnablement();
            });
            window.addEventListener('online', () => {
                this.syncPending();
                this.drainDeletedTombstones();
                void this._drainRetiredMedia();
                this._retryPendingVoyageLogEnablement();
            });
            // Attempt sync on init
            setTimeout(() => {
                this.syncPending();
                this.drainDeletedTombstones();
                void this._drainRetiredMedia();
                this._retryPendingVoyageLogEnablement();
            }, 5000);
            // Periodic retry every 30s — catches stuck pending entries and
            // undrained deletes (navigator.onLine is unreliable on iOS/Capacitor).
            // A few older builds could strand an owned offline draft in the
            // cache without its pending-queue twin; treat that as retryable
            // work too so a recovered diary does not need a manual rescue.
            setInterval(() => {
                const scope = getAuthIdentityScope();
                if (
                    this._getPendingEntries(scope).length > 0 ||
                    this._recoverableCachedOfflineDrafts(scope).length > 0
                ) {
                    this.syncPending();
                }
                if (this._getTombstones().length > 0) this.drainDeletedTombstones();
                if (this._getMediaCleanupJobs(scope).length > 0) void this._drainRetiredMedia(scope);
                this._retryPendingVoyageLogEnablement();
            }, 30_000);
        }
        this._configureBackgroundRetry();
    }

    /**
     * iOS suspends browser timers in the background, so the foreground 30s
     * poll alone cannot meet the offline-outbox promise. The installed native
     * fetch plugin gives the OS a bounded (best-effort) wake-up to drain diary
     * creates, deletions, and public-log setup. iOS still controls cadence and
     * will not relaunch a user-terminated app; the durable queues remain the
     * source of truth for its next foreground launch.
     */
    private _configureBackgroundRetry(): void {
        if (this._backgroundRetryConfigured || !Capacitor.isNativePlatform()) return;
        this._backgroundRetryConfigured = true;
        void BackgroundFetch.configure(
            { minimumFetchInterval: 15 },
            async (taskId) => {
                try {
                    await this.syncPending();
                    await this.drainDeletedTombstones();
                    await this._drainRetiredMedia();
                    this._retryPendingVoyageLogEnablement();
                } catch (error) {
                    log.warn('Background diary retry failed:', error);
                } finally {
                    void BackgroundFetch.finish(taskId);
                }
            },
            async (taskId) => {
                // The OS withdrew the background budget. Finish immediately;
                // all work remains in the durable device/Pi outboxes.
                void BackgroundFetch.finish(taskId);
            },
        ).catch((error) => {
            this._backgroundRetryConfigured = false;
            log.warn('Background diary retry is unavailable:', error);
        });
    }

    /**
     * A first public Diary entry may reach Supabase through the Pi before the
     * phone can create its Voyage Log config. Retry that separate durable
     * setup intent alongside the diary outbox so the public page eventually
     * becomes reachable instead of leaving a correctly public row invisible.
     */
    private _retryPendingVoyageLogEnablement(): void {
        if (!canAttemptDiaryCloudDelivery()) return;
        void VoyageLogService.ensurePendingEnabled();
    }

    // ── Read ───────────────────────────────────────────────────

    async getEntries(limit = 50): Promise<DiaryEntry[]> {
        const scope = getAuthIdentityScope();
        // 1. Merge cached remote entries + pending offline entries + recently-synced buffer
        const cached = this._getCachedEntries(scope);
        const pending = this._getPendingEntries(scope);
        // Cache-only offline drafts are an old crash/relaunch edge case. They
        // are already owner-scoped, so recover them through the ordinary
        // pending queue in the background; never guess ownership from an
        // anonymous or quarantined legacy record.
        if (this._recoverableCachedOfflineDrafts(scope, cached, pending).length > 0) {
            void this.syncPending();
        }

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
        return merged.map((e) => this._toDisplayEntry(e));
    }

    async getEntry(id: string): Promise<DiaryEntry | null> {
        const scope = getAuthIdentityScope();
        // Deleted locally — gone, even if the server row still exists.
        if (this._tombstonedIdSet(scope).has(id) || this._isRecentlyDrained(id, scope)) return null;

        // Check pending first
        const pending = this._getPendingEntries(scope);
        const pendingMatch = pending.find((e) => e.id === id);
        if (pendingMatch) return this._toDisplayEntry(pendingMatch);

        // Check cache
        const cached = this._getCachedEntries(scope);
        const cacheMatch = cached.find((e) => e.id === id);
        if (cacheMatch) return this._toDisplayEntry(cacheMatch);

        // Fallback to network
        if (!supabase || !scope.userId) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;
        const { data } = await supabase.from(TABLE).select('*').eq('id', id).eq('user_id', scope.userId).single();
        if (!isAuthIdentityScopeCurrent(scope) || !data || (data as DiaryEntry).user_id !== scope.userId) return null;
        const owned = { ...(data as DiaryEntry), owner_user_id: scope.userId };
        this._registerEntryMedia(owned, scope);
        return this._toDisplayEntry(owned);
    }

    // ── Create (offline-first) ─────────────────────────────────

    async createEntry(entry: {
        title: string;
        body: string;
        mood: DiaryMood;
        photos?: string[];
        audio_url?: string | null;
        video_url?: string | null;
        latitude?: number | null;
        longitude?: number | null;
        location_name?: string;
        weather_summary?: string;
        weather_data?: DiaryWeatherData | null;
        voyage_id?: string | null;
        /** Internal/import compatibility: normal composer calls omit this and use the active vessel. */
        boat_id?: string | null;
        tags?: string[];
        is_public?: boolean;
    }): Promise<DiaryEntry> {
        const scope = getAuthIdentityScope();
        if (!this._submittedMediaBelongsToScope(entry.photos, entry.audio_url, scope, true, entry.video_url)) {
            throw new Error('Diary media is not owned by the active account');
        }
        const now = new Date().toISOString();
        // A caller can deliberately supply `voyage_id: null` for an
        // unassigned journal note. When it omits the field, inherit the
        // active recording voyage here — at the durable service boundary —
        // so every compose surface (including a cold launch before Log has
        // hydrated) behaves consistently.
        // `undefined` is the normal shape of an optional prop passed through a
        // compose form; only an actual id or explicit null opts out of the
        // automatic active-voyage association.
        const voyageWasExplicitlySet =
            Object.prototype.hasOwnProperty.call(entry, 'voyage_id') && entry.voyage_id !== undefined;
        const activeVoyageId = voyageWasExplicitlySet ? undefined : await ShipLogService.resolveActiveVoyageId();
        // Bind a diary note to the vessel at creation time. During a live
        // track this is the immutable boat selected at cast-off; when no
        // voyage is active it is the skipper's currently selected fleet
        // vessel. An explicitly supplied null remains a legitimate legacy /
        // unassigned note.
        const boatWasExplicitlySet =
            Object.prototype.hasOwnProperty.call(entry, 'boat_id') && entry.boat_id !== undefined;
        const activeBoatId = boatWasExplicitlySet ? undefined : await ShipLogService.resolveActiveBoatId();
        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Authentication changed while preparing the diary entry');
        }
        const localEntry: DiaryEntry = {
            id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            client_operation_id: newDiaryOperationId(),
            client_revision: 1,
            user_id: scope.userId ?? 'local',
            title: entry.title,
            body: entry.body,
            mood: entry.mood,
            photos: entry.photos || [],
            audio_url: entry.audio_url ?? null,
            video_url: entry.video_url ?? null,
            latitude: entry.latitude ?? null,
            longitude: entry.longitude ?? null,
            location_name: entry.location_name || '',
            weather_summary: entry.weather_summary || '',
            weather_data: entry.weather_data ?? null,
            voyage_id: voyageWasExplicitlySet ? (entry.voyage_id ?? null) : (activeVoyageId ?? null),
            boat_id: boatWasExplicitlySet ? (entry.boat_id ?? null) : (activeBoatId ?? null),
            tags: entry.tags || [],
            // A local row must never look public before the server confirms
            // it. Preserve an explicit caller request separately so it still
            // survives an offline save and reaches the Pi/direct outbox.
            is_public: false,
            publish_requested: entry.is_public === true ? true : undefined,
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
            log.error('Failed to persist diary entry to pending queue:', e);
            // A false success here is worse than an error: the compose sheet
            // would close even though no recoverable copy exists after a
            // restart. DiaryPage keeps the skipper's text in the editor when
            // this rejects, so it can be retried or copied safely.
            throw e;
        }

        // Fire sync in the background — don't block the UI on it.
        void this.syncPending();

        // Return entry without _offline flag — avoids persistent PENDING badge in UI.
        // The entry is now durably in pending queue AND IndexedDB; background sync
        // will upload it, and the periodic 30s retry catches transient failures.
        // Return the commit result even if the UI identity changed immediately
        // afterwards: the caller suppresses stale rendering, but still needs to
        // know that the outbox adopted its media and must not delete it.
        return { ...localEntry, _offline: false };
    }

    // ── Update ─────────────────────────────────────────────────

    async updateEntry(
        id: string,
        updates: Partial<
            Pick<
                DiaryEntry,
                | 'title'
                | 'body'
                | 'mood'
                | 'photos'
                | 'audio_url'
                // Position is editable: a photo attached during an edit can
                // re-pin the entry from its EXIF (the berth-pin repair path).
                | 'latitude'
                | 'longitude'
                | 'location_name'
                | 'weather_summary'
                | 'tags'
                | 'is_public'
            >
        >,
        options: { shouldContinue?: () => boolean } = {},
    ): Promise<{ ok: boolean; audioUrl?: string | null }> {
        const scope = getAuthIdentityScope();
        const canContinue = () => isAuthIdentityScopeCurrent(scope) && (options.shouldContinue?.() ?? true);
        const photosWereSubmitted = Object.prototype.hasOwnProperty.call(updates, 'photos');
        const audioWasSubmitted = Object.prototype.hasOwnProperty.call(updates, 'audio_url');
        if (
            !canContinue() ||
            !this._submittedMediaBelongsToScope(
                photosWereSubmitted ? updates.photos : undefined,
                updates.audio_url,
                scope,
                audioWasSubmitted,
            )
        ) {
            return { ok: false };
        }

        let targetId = id;
        let pending = this._getPendingEntries(scope);
        let current = pending.find((entry) => entry.id === targetId) ?? null;

        // A stale offline id can outlive its short in-memory sync buffer. Resolve
        // both durable and recent mappings before looking up the canonical row.
        if (!current && targetId.startsWith('offline-')) {
            const recentlySynced = this._recentlySynced.find((candidate) => candidate.offlineId === targetId);
            const mappedId = recentlySynced?.entry.id ?? this._resolveServerIdForScope(targetId, scope);
            if (mappedId) {
                targetId = mappedId;
                current = recentlySynced?.entry ?? null;
            }
        }

        current ??=
            pending.find((entry) => entry.id === targetId) ??
            this._getCachedEntries(scope).find((entry) => entry.id === targetId) ??
            this._recentlySynced.find((candidate) => candidate.entry.id === targetId)?.entry ??
            null;

        // A cache miss is allowed one owner-filtered canonical read. Nothing is
        // queued when the row does not exist, belongs to someone else, or the
        // identity changes while that read is in flight.
        if (!current && !targetId.startsWith('offline-')) current = await this.getEntry(targetId);
        if (!current || !canContinue() || current.owner_user_id !== scope.userId) return { ok: false };

        let durablePhotos = photosWereSubmitted ? (updates.photos ?? []) : current.photos;
        let promotedPhotoRefs: string[] = [];
        if (photosWereSubmitted) {
            const prepared = await this._prepareDurablePhotoRefs(durablePhotos, scope);
            if (!prepared || !canContinue()) return { ok: false };
            durablePhotos = prepared.refs;
            promotedPhotoRefs = prepared.promotedFrom;
        }

        // A sync completion may have landed while a cache miss or blob promotion
        // awaited. Prefer the latest queued revision if it still exists.
        pending = this._getPendingEntries(scope);
        current = pending.find((entry) => entry.id === targetId) ?? current;
        if (!canContinue() || current.owner_user_id !== scope.userId) return { ok: false };

        const currentRevision =
            typeof current.client_revision === 'number' &&
            Number.isSafeInteger(current.client_revision) &&
            current.client_revision >= 1
                ? current.client_revision
                : 1;
        const validOperationId =
            typeof current.client_operation_id === 'string' &&
            /^[A-Za-z0-9_-]{1,128}$/.test(current.client_operation_id)
                ? current.client_operation_id
                : null;
        const requiresOperationClaim =
            !targetId.startsWith('offline-') && (current._requiresOperationClaim === true || !validOperationId);
        const nextPhotos = photosWereSubmitted ? durablePhotos : current.photos;
        const nextAudio = audioWasSubmitted ? (updates.audio_url ?? null) : current.audio_url;
        const retirePhotos = new Set(current._retirePhotos ?? []);
        const retireAudio = new Set(current._retireAudio ?? []);
        if (photosWereSubmitted) {
            const retained = new Set(nextPhotos);
            for (const ref of current.photos) if (!retained.has(ref)) retirePhotos.add(ref);
        }
        if (audioWasSubmitted && current.audio_url && current.audio_url !== nextAudio) {
            retireAudio.add(current.audio_url);
        }

        const requestedPublic = targetId.startsWith('offline-')
            ? updates.is_public === undefined
                ? current.publish_requested
                : updates.is_public === true
                  ? true
                  : undefined
            : current.publish_requested;
        const next: DiaryEntry = {
            ...current,
            ...updates,
            id: targetId,
            user_id: scope.userId ?? 'local',
            owner_user_id: scope.userId,
            photos: nextPhotos,
            audio_url: nextAudio,
            is_public: targetId.startsWith('offline-') ? false : (updates.is_public ?? current.is_public),
            publish_requested: requestedPublic,
            client_operation_id: validOperationId ?? newDiaryOperationId(),
            client_revision: currentRevision + 1,
            updated_at: new Date().toISOString(),
            _retirePhotos: retirePhotos.size > 0 ? [...retirePhotos] : undefined,
            _retireAudio: retireAudio.size > 0 ? [...retireAudio] : undefined,
            _requiresOperationClaim: requiresOperationClaim || undefined,
            _offline: true,
        };

        const existingIndex = pending.findIndex((entry) => entry.id === targetId);
        if (existingIndex >= 0) pending[existingIndex] = next;
        else pending.unshift(next);
        if (!this._savePending(pending, scope)) return { ok: false };

        const durable = this._getPendingEntries(scope).find((entry) => entry.id === targetId);
        const mediaRoundTripped =
            !!durable &&
            durable.audio_url === next.audio_url &&
            durable.photos.length === next.photos.length &&
            durable.photos.every((ref, index) => ref === next.photos[index]);
        if (!mediaRoundTripped) return { ok: false };

        // The outbox is now the owner. Retire only the process-scoped source
        // refs that were promoted during this update; their durable IDB/data
        // replacements remain in the queue.
        for (const ref of promotedPhotoRefs) await this.discardUnsavedPhoto(ref);
        void this.syncPending();
        return { ok: true, audioUrl: durable.audio_url };
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
            // Public visibility is still server-confirmed in the UI, but an
            // explicit skipper choice must not disappear merely because the
            // device is offshore. Persist the *intent* in the durable device
            // outbox; the actual `is_public` flag remains false until the Pi
            // or direct path returns a real Supabase row.
            const pending = this._getPendingEntries(scope);
            const idx = pending.findIndex((e) => e.id === id);
            if (idx >= 0) {
                pending[idx] = {
                    ...pending[idx],
                    is_public: false,
                    publish_requested: isPublic ? true : undefined,
                    client_revision:
                        typeof pending[idx].client_revision === 'number' &&
                        Number.isSafeInteger(pending[idx].client_revision) &&
                        pending[idx].client_revision >= 1
                            ? pending[idx].client_revision + 1
                            : 2,
                    updated_at: new Date().toISOString(),
                };
                if (!this._savePending(pending, scope)) return false;
            }
            // Push it to the server now — awaits any in-flight sync too.
            await this.syncPending();
            if (!isAuthIdentityScopeCurrent(scope)) return false;

            // If it landed, force the flag on the real row directly. Covers
            // both the in-flight race (it had synced as private before this
            // call) and an app relaunched after the short-lived sync buffer
            // expired, via the durable offline→server id mapping.
            const synced = this._recentlySynced.find((r) => r.offlineId === id && r.entry.user_id === scope.userId);
            const serverId = synced?.entry.id ?? this.resolveServerId(id);
            // The new relay/direct upsert carries the explicit intent in its
            // first write. Do not issue a redundant UPDATE (and do not create
            // an avoidable offline race) when that returned row already
            // proves the requested state.
            if (synced?.entry.is_public === isPublic) return true;
            if (serverId) return this._setPublishedOnServer(serverId, isPublic, scope);

            // Still pending/offline. The public intent is now durable and the
            // periodic device/Pi retry will honour it; keep the visual state
            // private until a server row is proven.
            return false;
        }
        return this._setPublishedOnServer(id, isPublic, scope);
    }

    private async _setPublishedOnServer(id: string, isPublic: boolean, scope: AuthIdentityScope): Promise<boolean> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return false;
        // PostgREST returns `{ data: null, error: null }` for an UPDATE that
        // RLS filtered down to zero rows. A bare `!error` used to turn that
        // no-op into a false "Published" success. Asking for the exact row
        // back makes both the ownership filter and the final public flag part
        // of the success contract.
        const { data, error } = await supabase
            .from(TABLE)
            .update({ is_public: isPublic, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', scope.userId)
            .select('id, is_public')
            .maybeSingle();
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        const confirmed =
            !error &&
            !!data &&
            (data as Pick<DiaryEntry, 'id' | 'is_public'>).id === id &&
            (data as Pick<DiaryEntry, 'id' | 'is_public'>).is_public === isPublic;
        if (!confirmed) return false;

        // Keep the local read path coherent without pretending the write won
        // before confirmation. The background refresh still reconciles every
        // other field from the authoritative server row.
        const updatedAt = new Date().toISOString();
        const cached = this._getCachedEntries(scope);
        if (cached.some((entry) => entry.id === id)) {
            this._saveCachedEntries(
                cached.map((entry) =>
                    entry.id === id ? { ...entry, is_public: isPublic, updated_at: updatedAt } : entry,
                ),
                scope,
            );
        }
        this._recentlySynced = this._recentlySynced.map((recent) =>
            recent.entry.id === id
                ? {
                      ...recent,
                      entry: { ...recent.entry, is_public: isPublic, updated_at: updatedAt },
                  }
                : recent,
        );
        void this._refreshFromServer(50, scope);
        return true;
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
            if (entry?.audio_url && isIdbAudio(entry.audio_url)) {
                await this.discardUnsavedAudio(entry.audio_url);
            }
            if (entry?.video_url && isIdbVideo(entry.video_url)) {
                await this.discardUnsavedVideo(entry.video_url);
            }
            this._savePending(
                pending.filter((e) => e.id !== id),
                scope,
            );

            // Tombstone the offline id too: an in-flight syncPending() may have
            // snapshotted the queue BEFORE the filter above, in which case it
            // will still insert this entry. The post-insert tombstone check in
            // syncPending catches that and deletes the fresh server row.
            this._addTombstone(id, [], null, scope, entry?.client_operation_id);
            if (entry?.client_operation_id) void cancelDiaryOnPi(entry.client_operation_id);

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
                    synced.entry.client_operation_id,
                    synced.entry.video_url ?? null,
                );
            }
            // Synced longer ago (the 120s buffer purged, or the app relaunched):
            // the durable id-map still knows the server twin.
            const mappedId = this.resolveServerId(id);
            if (mappedId) {
                const twin = this._getCachedEntries(scope).find((e) => e.id === mappedId) ?? null;
                return this._commitLocalDelete(
                    mappedId,
                    twin?.photos ?? [],
                    twin?.audio_url,
                    scope,
                    twin?.client_operation_id,
                    twin?.video_url ?? null,
                );
            }
            return true;
        }

        // Server entry — snapshot storage URLs from local sources only (never
        // the network: the whole point is that this must succeed offline).
        const local =
            this._getCachedEntries(scope).find((e) => e.id === id) ??
            this._recentlySynced.find((r) => r.entry.id === id)?.entry ??
            null;
        return this._commitLocalDelete(
            id,
            local?.photos ?? [],
            local?.audio_url,
            scope,
            local?.client_operation_id,
            local?.video_url ?? null,
        );
    }

    /** Tombstone + scrub local caches, then push to the server best-effort. */
    private _commitLocalDelete(
        id: string,
        photos: string[],
        audio: string | null | undefined,
        scope: AuthIdentityScope,
        clientOperationId?: string | null,
        video?: string | null,
    ): boolean {
        this._addTombstone(id, photos, audio, scope, clientOperationId, video);
        if (clientOperationId) void cancelDiaryOnPi(clientOperationId);
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
        // Never spend satellite data on a deferred diary delete. The Pi has
        // its own durable cancellation queue; direct cleanup resumes only on
        // a verified ordinary Supabase path.
        // A REST HEAD probe can be blocked by Capacitor/iOS even while the
        // authenticated Edge Function is reachable. Use the strict
        // non-satellite policy as the gate and let the actual cancellation
        // response decide whether this drain should retry.
        if (!canAttemptDiaryCloudDelivery() || !isAuthIdentityScopeCurrent(scope)) return;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return;
        const tombs = this._getTombstones(scope);
        if (tombs.length === 0) return;
        let drained = 0;
        for (const tombstone of tombs) {
            if (!isAuthIdentityScopeCurrent(scope) || tombstone.owner_user_id !== scope.userId) return;
            // Legacy offline drafts have no stable operation id and therefore
            // could never have reached a Pi relay. Retain their local fence
            // rather than guessing at a cloud row to delete.
            if (tombstone.id.startsWith('offline-') && !tombstone.client_operation_id) continue;
            const ok = await this._deleteOnServer(
                tombstone.id,
                tombstone.photos,
                tombstone.audio,
                tombstone.client_operation_id,
                scope,
                tombstone.video,
            );
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
        clientOperationId: string | null | undefined,
        scope: AuthIdentityScope,
        video?: string | null,
    ): Promise<boolean> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
        try {
            let operationId = clientOperationId;
            let photoUrls = photos;
            let audioUrl = audio ?? null;
            let videoUrl = video ?? null;
            // A cold local cache can lack the operation id even though an old
            // Pi still holds the corresponding create. Learn it from the
            // authoritative row before deleting so this otherwise ordinary
            // delete still lays down the anti-resurrection tombstone.
            if (!operationId || (photoUrls.length === 0 && !audioUrl && !videoUrl)) {
                const { data } = await supabase
                    .from(TABLE)
                    .select('photos, audio_url, video_url, client_operation_id')
                    .eq('id', id)
                    .maybeSingle();
                if (!isAuthIdentityScopeCurrent(scope)) return false;
                photoUrls = photoUrls.length > 0 ? photoUrls : ((data?.photos as string[] | null) ?? []);
                audioUrl = audioUrl ?? (data?.audio_url as string | null) ?? null;
                videoUrl = videoUrl ?? (data?.video_url as string | null) ?? null;
                const fetchedOperationId = data?.client_operation_id;
                if (
                    !operationId &&
                    typeof fetchedOperationId === 'string' &&
                    /^[A-Za-z0-9_-]{1,128}$/.test(fetchedOperationId)
                ) {
                    operationId = fetchedOperationId;
                }
            }
            // The cloud tombstone is the authoritative cancellation. It must
            // land before a delayed Pi create can ever be allowed to arrive.
            if (operationId && !(await cancelDiaryDirect(operationId))) return false;
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            // Row FIRST: if this fails, nothing has been destroyed and the
            // whole tombstone retries. (Storage-first + a persistently-failing
            // row delete would resurrect the entry with dead photo URLs.)
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
            // Row is gone, but the tombstone is not acknowledged until every
            // referenced object is gone too. Storage remove is idempotent:
            // an already-absent path returns no error and is therefore safe on
            // a retry after the row delete committed.
            for (const url of photoUrls) {
                if (!isAuthIdentityScopeCurrent(scope)) return false;
                const path = this._extractStoragePath(url, PHOTO_BUCKET);
                if (!path) continue;
                const { error: storageError } = await supabase.storage.from(PHOTO_BUCKET).remove([path]);
                if (storageError) {
                    log.warn('Diary photo cleanup failed — will retry with the tombstone:', storageError.message);
                    return false;
                }
            }
            const audioPath = audioUrl ? this._extractStoragePath(audioUrl, AUDIO_BUCKET) : null;
            if (audioPath && isAuthIdentityScopeCurrent(scope)) {
                const { error: storageError } = await supabase.storage.from(AUDIO_BUCKET).remove([audioPath]);
                if (storageError) {
                    log.warn('Diary audio cleanup failed — will retry with the tombstone:', storageError.message);
                    return false;
                }
            }
            const videoPath = videoUrl ? this._extractStoragePath(videoUrl, VIDEO_BUCKET) : null;
            if (videoPath && isAuthIdentityScopeCurrent(scope)) {
                const { error: storageError } = await supabase.storage.from(VIDEO_BUCKET).remove([videoPath]);
                if (storageError) {
                    log.warn('Diary video cleanup failed — will retry with the tombstone:', storageError.message);
                    return false;
                }
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

        // Compose media is IDB-first even while online. Supabase Storage objects
        // are created only by the sync worker after the durable diary outbox has
        // adopted this ref, so abandoning a form cannot orphan a cloud object.
        // Persist the compressed Blob to IndexedDB
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
     * Discard one photo which has not been adopted by createEntry/updateEntry.
     * The compose screen owns that distinction; this method only removes the
     * exact local or private-storage reference it is given and is idempotent.
     */
    async discardUnsavedPhoto(ref: string | null | undefined): Promise<void> {
        if (!ref) return;
        if (isIdbPhoto(ref)) {
            await idbDeletePhoto(ref);
            const cachedUrl = this._idbRefToBlobUrl.get(ref);
            if (cachedUrl) {
                URL.revokeObjectURL(cachedUrl);
                this._idbRefToBlobUrl.delete(ref);
            }
            this._pendingPhotoBlobs.delete(ref);
            return;
        }
        if (ref.startsWith('blob:')) {
            this._pendingPhotoBlobs.delete(ref);
            URL.revokeObjectURL(ref);
            return;
        }
        if (ref.startsWith('data:')) return;
        await this._removeUncommittedStorageRef(ref, PHOTO_BUCKET);
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
        if (isIdbAudio(ref)) {
            const cached = this._idbAudioRefToBlobUrl.get(ref);
            if (cached) return cached;
            const blob = await idbLoadAudio(ref);
            if (!blob || !isAuthIdentityScopeCurrent(scope)) return null;
            const url = URL.createObjectURL(blob);
            this._idbAudioRefToBlobUrl.set(ref, url);
            return url;
        }
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
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope) || !canAttemptDiaryCloudDelivery())
            return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        let uploadedPath: string | null = null;
        let handedOff = false;
        try {
            const compressed = await this._compressImage(file);
            const ext = file.name.split('.').pop() || 'jpg';
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            const path = `${scope.userId}/${Date.now()}.${ext}`;

            const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, compressed, {
                contentType: `image/${ext === 'png' ? 'png' : 'jpeg'}`,
                upsert: false,
            });

            // See the note in _uploadBlob — same swallowed-cause problem.
            if (error) {
                log.warn(`[Diary] photo upload rejected (${PHOTO_BUCKET}): ${error.message}`);
                return null;
            }
            uploadedPath = path;
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            handedOff = true;
            return `${STORAGE_REF_PREFIX}${PHOTO_BUCKET}:${path}`;
        } catch (e) {
            log.error('Photo upload failed:', e);
            return null;
        } finally {
            if (uploadedPath && !handedOff) {
                await this._removeUncommittedStorageObject(PHOTO_BUCKET, uploadedPath);
            }
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
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope) || !canAttemptDiaryCloudDelivery())
            return null;
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
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope) || !canAttemptDiaryCloudDelivery())
            return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        let uploadedPath: string | null = null;
        let handedOff = false;
        try {
            const path = `${scope.userId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;

            const { error } = await supabase.storage
                .from(PHOTO_BUCKET)
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

            // SAY WHY. A failed photo upload parks its whole entry before both
            // write paths, so this error is the first domino in a permanent,
            // silent stall — and it used to be discarded unread, leaving
            // "RLS denied", "bucket rejected the type", and "the socket died"
            // indistinguishable from each other and from being offline.
            if (error) {
                log.warn(`[Diary] photo upload rejected (${PHOTO_BUCKET}): ${error.message}`);
                return null;
            }
            uploadedPath = path;
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            handedOff = true;
            return `${STORAGE_REF_PREFIX}${PHOTO_BUCKET}:${path}`;
        } catch (e) {
            log.error('Blob upload failed:', e);
            return null;
        } finally {
            if (uploadedPath && !handedOff) {
                await this._removeUncommittedStorageObject(PHOTO_BUCKET, uploadedPath);
            }
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

    /**
     * Give pre-relay offline drafts a stable id without changing their UI id.
     * Always merge into the *current* queue row: a background sync can hold a
     * stale snapshot while the skipper is still editing the compose sheet.
     */
    private _ensureClientOperationId(entry: DiaryEntry, scope: AuthIdentityScope): DiaryEntry | null {
        const pending = this._getPendingEntries(scope);
        const index = pending.findIndex((candidate) => candidate.id === entry.id);
        // A delete or a competing completion won while this sync awaited a
        // network/Pi step. Never recreate its stale snapshot in the queue.
        if (index < 0) return null;

        const latest = pending[index];
        const current = latest.client_operation_id;
        const operationId =
            typeof current === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(current) ? current : newDiaryOperationId();
        const revision =
            typeof latest.client_revision === 'number' &&
            Number.isSafeInteger(latest.client_revision) &&
            latest.client_revision >= 1
                ? latest.client_revision
                : 1;
        if (operationId === current && revision === latest.client_revision) return latest;
        const next = { ...latest, client_operation_id: operationId, client_revision: revision };
        pending[index] = next;
        return this._savePending(pending, scope) ? next : null;
    }

    /**
     * Older server rows pre-date the relay operation id. Bind one with an
     * owner/id-constrained update before any text or media revision is handed
     * to Pi/direct delivery. If that tiny claim has an ambiguous response, an
     * exact read-back reconciles it; no media is touched by this step.
     */
    private async _claimServerOperation(
        entry: DiaryEntry,
        scope: AuthIdentityScope,
        database: NonNullable<typeof supabase>,
    ): Promise<DiaryEntry | null> {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || entry.id.startsWith('offline-')) return null;

        const readCanonical = async (): Promise<Partial<DiaryEntry> | null> => {
            try {
                const { data, error } = await database
                    .from(TABLE)
                    .select('id,user_id,client_operation_id,client_revision')
                    .eq('id', entry.id)
                    .eq('user_id', scope.userId!)
                    .maybeSingle();
                if (error || !isAuthIdentityScopeCurrent(scope) || data?.user_id !== scope.userId) return null;
                return data as Partial<DiaryEntry>;
            } catch (error) {
                log.warn('Could not read a legacy diary operation claim:', error);
                return null;
            }
        };

        let canonical = await readCanonical();
        if (!canonical || !isAuthIdentityScopeCurrent(scope)) return null;
        let operationId =
            typeof canonical.client_operation_id === 'string' &&
            /^[A-Za-z0-9_-]{1,128}$/.test(canonical.client_operation_id)
                ? canonical.client_operation_id
                : null;

        if (!operationId) {
            const proposed =
                typeof entry.client_operation_id === 'string' &&
                /^[A-Za-z0-9_-]{1,128}$/.test(entry.client_operation_id)
                    ? entry.client_operation_id
                    : newDiaryOperationId();
            try {
                const { data, error } = await database
                    .from(TABLE)
                    .update({ client_operation_id: proposed })
                    .eq('id', entry.id)
                    .eq('user_id', scope.userId)
                    .select('id,user_id,client_operation_id,client_revision')
                    .maybeSingle();
                if (!isAuthIdentityScopeCurrent(scope)) return null;
                if (!error && data?.user_id === scope.userId && data.client_operation_id === proposed) {
                    canonical = data as Partial<DiaryEntry>;
                    operationId = proposed;
                }
            } catch (error) {
                log.warn('Legacy diary operation claim returned an uncertain result:', error);
            }

            // A timeout/rejected response can arrive after Postgres committed.
            // Read the exact owner row before deciding this revision is blocked.
            if (!operationId) {
                canonical = await readCanonical();
                operationId =
                    typeof canonical?.client_operation_id === 'string' &&
                    /^[A-Za-z0-9_-]{1,128}$/.test(canonical.client_operation_id)
                        ? canonical.client_operation_id
                        : null;
            }
        }
        if (!operationId || !canonical || !isAuthIdentityScopeCurrent(scope)) return null;

        const pending = this._getPendingEntries(scope);
        const index = pending.findIndex((candidate) => candidate.id === entry.id);
        if (index < 0) return null;
        const latest = pending[index];
        const localRevision =
            typeof latest.client_revision === 'number' && Number.isSafeInteger(latest.client_revision)
                ? latest.client_revision
                : 2;
        const canonicalRevision =
            typeof canonical.client_revision === 'number' && Number.isSafeInteger(canonical.client_revision)
                ? canonical.client_revision
                : 1;
        const next: DiaryEntry = {
            ...latest,
            client_operation_id: operationId,
            client_revision: Math.max(localRevision, canonicalRevision + 1),
            _requiresOperationClaim: undefined,
        };
        pending[index] = next;
        if (!this._savePending(pending, scope)) return null;
        const durable = this._getPendingEntries(scope).find((candidate) => candidate.id === entry.id);
        return durable?.client_operation_id === operationId && durable._requiresOperationClaim !== true
            ? durable
            : null;
    }

    private _relayEnvelope(
        entry: DiaryEntry,
        photos = entry.photos,
        audioUrl = entry.audio_url,
        videoUrl = entry.video_url ?? null,
    ): DiaryRelayEnvelope {
        return {
            client_operation_id: entry.client_operation_id || newDiaryOperationId(),
            client_revision:
                typeof entry.client_revision === 'number' &&
                Number.isSafeInteger(entry.client_revision) &&
                entry.client_revision >= 1
                    ? entry.client_revision
                    : 1,
            title: entry.title,
            body: entry.body,
            mood: entry.mood,
            photos,
            audio_url: audioUrl,
            video_url: videoUrl,
            latitude: entry.latitude,
            longitude: entry.longitude,
            location_name: entry.location_name,
            weather_summary: entry.weather_summary,
            // DiaryWeatherData is deliberately a narrow application type;
            // the relay transports a JSON record. Spreading produces the
            // serialisable wire shape without weakening either contract.
            weather_data: entry.weather_data ? { ...entry.weather_data } : null,
            voyage_id: entry.voyage_id,
            boat_id: entry.boat_id ?? null,
            tags: entry.tags,
            // `publish_requested` is a device-only intent. It becomes the
            // real public flag only at the authenticated/relay boundary.
            is_public: entry.publish_requested === true || entry.is_public === true,
            created_at: entry.created_at,
        };
    }

    /**
     * The Pi relay stores JSON, not the phone's IndexedDB/blob bytes. Never
     * let it acknowledge an early envelope that points at phone-only media:
     * the device keeps that draft until it can upload the media, then hands
     * the Pi the finished storage references as one safe envelope.
     */
    private _hasPhoneOnlyRelayMedia(entry: DiaryEntry): boolean {
        const isPhoneOnly = (value: string | null | undefined) =>
            Boolean(value) &&
            (isIdbPhoto(value!) ||
                isIdbAudio(value!) ||
                isIdbVideo(value!) ||
                value!.startsWith('blob:') ||
                value!.startsWith('data:'));
        return (
            entry.photos.some((photo) => isPhoneOnly(photo)) ||
            isPhoneOnly(entry.audio_url) ||
            isPhoneOnly(entry.video_url)
        );
    }

    private _mediaRefKey(ref: string, bucket: typeof PHOTO_BUCKET | typeof AUDIO_BUCKET | typeof VIDEO_BUCKET): string {
        const path = this._extractStoragePath(ref, bucket);
        return path ? `${bucket}:${path}` : `${bucket}:${ref}`;
    }

    private _cleanupRefBelongsToScope(
        ref: string,
        bucket: typeof PHOTO_BUCKET | typeof AUDIO_BUCKET | typeof VIDEO_BUCKET,
        scope: AuthIdentityScope,
    ): boolean {
        if (bucket === PHOTO_BUCKET && isIdbPhoto(ref)) return true;
        if (bucket === AUDIO_BUCKET && isIdbAudio(ref)) return true;
        if (bucket === VIDEO_BUCKET && isIdbVideo(ref)) return true;
        if (ref.startsWith('blob:') || ref.startsWith('data:')) return true;
        return this._managedStorageRefBelongsToScope(ref, bucket, scope) === true;
    }

    private _getMediaCleanupJobs(scope: AuthIdentityScope = getAuthIdentityScope()): DiaryMediaCleanupJob[] {
        if (!scope.userId) return [];
        try {
            const raw = localStorage.getItem(this._storageKey(MEDIA_CLEANUP_KEY, scope));
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            return parsed.flatMap((value): DiaryMediaCleanupJob[] => {
                if (!value || typeof value !== 'object') return [];
                const candidate = value as Partial<DiaryMediaCleanupJob>;
                if (
                    typeof candidate.id !== 'string' ||
                    typeof candidate.entryId !== 'string' ||
                    candidate.owner_user_id !== scope.userId ||
                    typeof candidate.createdAt !== 'number' ||
                    !Array.isArray(candidate.refs)
                ) {
                    return [];
                }
                const refs = candidate.refs.filter(
                    (item): item is DiaryMediaCleanupJob['refs'][number] =>
                        !!item &&
                        typeof item === 'object' &&
                        (item.bucket === PHOTO_BUCKET || item.bucket === AUDIO_BUCKET) &&
                        typeof item.ref === 'string' &&
                        this._cleanupRefBelongsToScope(item.ref, item.bucket, scope),
                );
                return refs.length > 0 ? [{ ...(candidate as DiaryMediaCleanupJob), refs }] : [];
            });
        } catch (error) {
            log.warn('Diary media cleanup queue read failed:', error);
            return [];
        }
    }

    private _saveMediaCleanupJobs(jobs: DiaryMediaCleanupJob[], scope: AuthIdentityScope): boolean {
        if (!scope.userId || jobs.some((job) => job.owner_user_id !== scope.userId)) return false;
        const key = this._storageKey(MEDIA_CLEANUP_KEY, scope);
        try {
            localStorage.setItem(key, JSON.stringify(jobs));
            const roundTrip: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
            return (
                Array.isArray(roundTrip) &&
                roundTrip.length === jobs.length &&
                jobs.every((job) =>
                    roundTrip.some(
                        (value) =>
                            !!value &&
                            typeof value === 'object' &&
                            (value as DiaryMediaCleanupJob).id === job.id &&
                            (value as DiaryMediaCleanupJob).refs?.length === job.refs.length,
                    ),
                )
            );
        } catch (error) {
            log.warn('Diary media cleanup queue write failed:', error);
            return false;
        }
    }

    /** Persist exact old refs before retiring the revision which remembers them. */
    private _queueRetiredMediaCleanup(local: DiaryEntry, canonical: DiaryEntry, scope: AuthIdentityScope): boolean {
        if (!scope.userId) return false;
        const canonicalKeys = new Set([
            ...(canonical.photos ?? []).map((ref) => this._mediaRefKey(ref, PHOTO_BUCKET)),
            ...(canonical.audio_url ? [this._mediaRefKey(canonical.audio_url, AUDIO_BUCKET)] : []),
            ...(canonical.video_url ? [this._mediaRefKey(canonical.video_url, VIDEO_BUCKET)] : []),
        ]);
        const refs = [
            ...(local._retirePhotos ?? []).map((ref) => ({ bucket: PHOTO_BUCKET, ref }) as const),
            ...(local._retireAudio ?? []).map((ref) => ({ bucket: AUDIO_BUCKET, ref }) as const),
        ].filter(
            (item) =>
                this._cleanupRefBelongsToScope(item.ref, item.bucket, scope) &&
                !canonicalKeys.has(this._mediaRefKey(item.ref, item.bucket)),
        );
        if (refs.length === 0) return true;

        const jobs = this._getMediaCleanupJobs(scope);
        const id = `${local.id}:${local.client_operation_id ?? 'legacy'}:${local.client_revision ?? 1}`;
        const existing = jobs.find((job) => job.id === id);
        if (existing) {
            const seen = new Set(existing.refs.map((item) => this._mediaRefKey(item.ref, item.bucket)));
            for (const item of refs) {
                const key = this._mediaRefKey(item.ref, item.bucket);
                if (!seen.has(key)) existing.refs.push(item);
            }
        } else {
            jobs.push({ id, entryId: canonical.id, owner_user_id: scope.userId, refs, createdAt: Date.now() });
        }
        return this._saveMediaCleanupJobs(jobs, scope);
    }

    private async _drainRetiredMedia(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
        const active = this._mediaCleanupPromise;
        if (active?.generation === scope.generation) return active.promise;
        const promise = this._doDrainRetiredMedia(scope);
        this._mediaCleanupPromise = { generation: scope.generation, promise };
        try {
            await promise;
        } finally {
            if (this._mediaCleanupPromise?.promise === promise) this._mediaCleanupPromise = null;
        }
    }

    private async _doDrainRetiredMedia(scope: AuthIdentityScope): Promise<void> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        const jobs = this._getMediaCleanupJobs(scope);
        if (jobs.length === 0) return;

        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return;
        let serverRows: Array<Pick<DiaryEntry, 'photos' | 'audio_url' | 'video_url'>>;
        try {
            const { data, error } = await supabase
                .from(TABLE)
                .select('photos,audio_url,video_url')
                .eq('user_id', scope.userId);
            if (error || !isAuthIdentityScopeCurrent(scope)) return;
            serverRows = (data ?? []) as Array<Pick<DiaryEntry, 'photos' | 'audio_url' | 'video_url'>>;
        } catch (error) {
            log.warn('Could not reconcile retired diary media:', error);
            return;
        }

        const referenced = new Set<string>();
        for (const row of serverRows) {
            for (const ref of row.photos ?? []) referenced.add(this._mediaRefKey(ref, PHOTO_BUCKET));
            if (row.audio_url) referenced.add(this._mediaRefKey(row.audio_url, AUDIO_BUCKET));
            if (row.video_url) referenced.add(this._mediaRefKey(row.video_url, VIDEO_BUCKET));
        }

        const remaining: DiaryMediaCleanupJob[] = [];
        for (const job of jobs) {
            const retainedRefs: DiaryMediaCleanupJob['refs'] = [];
            for (const item of job.refs) {
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (referenced.has(this._mediaRefKey(item.ref, item.bucket))) {
                    retainedRefs.push(item);
                    continue;
                }

                try {
                    if (item.bucket === PHOTO_BUCKET && isIdbPhoto(item.ref)) {
                        await idbDeletePhoto(item.ref);
                    } else if (item.bucket === VIDEO_BUCKET && isIdbVideo(item.ref)) {
                        await idbDeleteVideo(item.ref);
                    } else if (item.bucket === AUDIO_BUCKET && isIdbAudio(item.ref)) {
                        await idbDeleteAudio(item.ref);
                    } else if (item.ref.startsWith('blob:')) {
                        this._pendingPhotoBlobs.delete(item.ref);
                        URL.revokeObjectURL(item.ref);
                    } else if (!item.ref.startsWith('data:')) {
                        const path = this._extractStoragePath(item.ref, item.bucket);
                        if (!path || !path.startsWith(`${scope.userId}/`)) continue;
                        const { error } = await supabase.storage.from(item.bucket).remove([path]);
                        if (error) retainedRefs.push(item);
                    }
                } catch (error) {
                    log.warn('Retired diary media cleanup failed; it will retry:', error);
                    retainedRefs.push(item);
                }
                if (!isAuthIdentityScopeCurrent(scope)) return;
            }
            if (retainedRefs.length > 0) remaining.push({ ...job, refs: retainedRefs });
        }
        if (isAuthIdentityScopeCurrent(scope)) this._saveMediaCleanupJobs(remaining, scope);
    }

    /**
     * Atomically retire a device draft only after a verified Supabase row has
     * been returned by either the direct client or the Pi relay.
     */
    private _completePendingWithServer(entry: DiaryEntry, value: unknown, scope: AuthIdentityScope): boolean {
        if (!scope.userId || !value || typeof value !== 'object') return false;
        const data = value as DiaryEntry;
        if (typeof data.id !== 'string' || !data.id || data.user_id !== scope.userId) return false;
        const pending = this._getPendingEntries(scope);
        const latest = pending.find((candidate) => candidate.id === entry.id);
        // The row can disappear while a Pi/direct request is in flight (for
        // example after Delete). Its stale success response must not rebuild
        // mappings or alter the tombstone that won locally.
        if (!latest) return false;
        const expectedOperationId = latest.client_operation_id;
        if (
            typeof expectedOperationId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(expectedOperationId) ||
            data.client_operation_id !== expectedOperationId
        ) {
            return false;
        }
        const localRevision =
            typeof latest.client_revision === 'number' && Number.isSafeInteger(latest.client_revision)
                ? latest.client_revision
                : 1;
        const canonicalRevision =
            typeof data.client_revision === 'number' && Number.isSafeInteger(data.client_revision)
                ? data.client_revision
                : 1;
        // A delayed Pi response is useful only if it is at least as new as
        // the draft still held on this device. Keep the local revision queued
        // otherwise; the Pi/Edge protocol will replace the stale snapshot.
        if (canonicalRevision < localRevision) return false;

        if (!this._queueRetiredMediaCleanup(latest, data, scope)) return false;
        const remaining = pending.filter((candidate) => candidate.id !== entry.id);
        if (!this._savePending(remaining, scope)) return false;
        this._recordIdMapping(latest.id, data.id, scope);

        // A delete can race a successful local/Pi write. Preserve the delete
        // contract rather than allowing the newly-returned server row to
        // resurrect in the timeline.
        if (this._tombstonedIdSet(scope).has(latest.id)) {
            const serverRow = { ...data, owner_user_id: scope.userId };
            this._addTombstone(
                serverRow.id,
                serverRow.photos ?? [],
                serverRow.audio_url,
                scope,
                latest.client_operation_id,
            );
            this._removeTombstone(latest.id, scope);
            this._markRecentlyDrained(latest.id, scope);
            void this.drainDeletedTombstones();
            void this._drainRetiredMedia(scope);
            return true;
        }

        this._recentlySynced.push({
            offlineId: latest.id,
            entry: { ...data, owner_user_id: scope.userId },
            syncedAt: Date.now(),
        });
        void this._drainRetiredMedia(scope);
        return true;
    }

    private async _runSyncPending(scope: AuthIdentityScope): Promise<void> {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        let pending = this._getPendingEntries(scope);
        // Recover first: this is local-only and lets a Pi take a second durable
        // copy even while the public internet is down.
        pending = this._recoverCachedOfflineDrafts(scope, pending);
        if (pending.length === 0 || !isAuthIdentityScopeCurrent(scope)) return;

        // Do not make a REST HEAD probe a prerequisite for direct delivery:
        // Capacitor/iOS can reject that probe while the authenticated Edge
        // Function itself remains perfectly usable. The non-satellite policy
        // is the hard gate; the actual direct write is the reachability test.
        const database = canAttemptDiaryCloudDelivery() ? supabase : null;

        log.info(
            `Syncing ${pending.length} pending entries${database ? ' (Pi + direct cloud)' : ' (Pi/local relay only)'}…`,
        );

        // Resolve cloud auth only when a direct write is actually permitted.
        // This avoids an expensive doomed auth refresh on satellite/offline
        // links, while the local Pi outbox remains available.
        let userId: string | undefined;
        if (database) {
            const userResp = await database.auth.getUser();
            userId = userResp.data.user?.id;
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (!userId) {
                const sessionResp = await database.auth.getSession();
                userId = sessionResp.data.session?.user?.id;
            }
            if (!userId) {
                // Last resort: force a token refresh — handles expired JWT edge case
                log.warn('Auth stale — attempting token refresh...');
                try {
                    const refreshResp = await database.auth.refreshSession();
                    userId = refreshResp.data.session?.user?.id;
                    if (userId) {
                        log.info('Token refresh succeeded — resuming sync');
                    }
                } catch (refreshErr) {
                    log.warn('Token refresh failed:', refreshErr);
                }
            }
            if (!userId) {
                log.warn('No authenticated user after all attempts — direct diary sync deferred');
            } else if (userId !== scope.userId) {
                log.warn('Diary sync refused direct work owned by a different authenticated account');
                userId = undefined;
            }
        }

        let syncedCount = 0;

        for (let entry of pending) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (entry.owner_user_id !== scope.userId) {
                log.error('Diary sync quarantined a pending entry with a mismatched owner');
                this._quarantine(PENDING_KEY, 'pending owner did not match active sync scope', entry);
                continue;
            }
            const uncommittedStorageRefs: Array<{ bucket: string; ref: string }> = [];
            const transientIdbPhotoRefs = new Set<string>();
            const trackStorageRef = (bucket: string, ref: string): void => {
                uncommittedStorageRefs.push({ bucket, ref });
            };
            const adoptStorageRefs = (bucket: string, refs: string[]): void => {
                const adopted = new Set(refs);
                for (let index = uncommittedStorageRefs.length - 1; index >= 0; index--) {
                    const candidate = uncommittedStorageRefs[index];
                    if (candidate.bucket === bucket && adopted.has(candidate.ref)) {
                        uncommittedStorageRefs.splice(index, 1);
                    }
                }
            };
            try {
                const currentEntry = this._ensureClientOperationId(entry, scope);
                if (!currentEntry) continue;
                entry = currentEntry;

                // A legacy server row is not a create. Never hand its newly
                // generated operation id to Pi as though it were one, or the
                // relay could create a duplicate row. Claim/reconcile first.
                if (entry._requiresOperationClaim) {
                    if (!database || !userId) continue;
                    const claimed = await this._claimServerOperation(entry, scope, database);
                    if (!claimed || !isAuthIdentityScopeCurrent(scope)) continue;
                    entry = claimed;
                }

                // Device -> Pi is safe on the boat LAN even without WAN. The
                // device keeps its own outbox until a returned server row
                // proves that either Pi -> Supabase or device -> Supabase won.
                if (!this._hasPhoneOnlyRelayMedia(entry)) {
                    const initialPiResult = await handoffDiaryToPi(this._relayEnvelope(entry));
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    if (
                        initialPiResult?.status === 'synced' &&
                        this._completePendingWithServer(entry, initialPiResult.entry, scope)
                    ) {
                        syncedCount++;
                        log.info(`✅ Synced diary entry via Pi: ${entry.title || entry.id}`);
                        continue;
                    }
                }

                // The Pi has now retained the entry if it was present. If
                // proper internet is unavailable, stop here: periodic retries
                // will re-hand the same id to Pi until it or the device can
                // obtain an ordinary (non-satellite) cloud path.
                if (!database || !userId) continue;

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
                const freshPhotoStorageRefs: string[] = [];
                const replacedLocalPhotos: Array<{
                    originalRef: string;
                    replacementRef: string;
                    kind: 'idb' | 'blob';
                }> = [];
                let allPhotosUploaded = true;
                let failedPhotoUploads = 0;
                for (const photo of entry.photos) {
                    if (isIdbPhoto(photo)) {
                        const blob = await idbLoadPhoto(photo);
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                        if (blob) {
                            const url = await this._uploadBlob(blob, scope);
                            if (url) {
                                trackStorageRef(PHOTO_BUCKET, url);
                                if (!isAuthIdentityScopeCurrent(scope)) return;
                                uploadedPhotos.push(url);
                                freshPhotoStorageRefs.push(url);
                                replacedLocalPhotos.push({ originalRef: photo, replacementRef: url, kind: 'idb' });
                            } else {
                                // Upload failed — keep the idb ref so we retry.
                                uploadedPhotos.push(photo);
                                allPhotosUploaded = false;
                                failedPhotoUploads++;
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
                                trackStorageRef(PHOTO_BUCKET, url);
                                if (!isAuthIdentityScopeCurrent(scope)) return;
                                uploadedPhotos.push(url);
                                freshPhotoStorageRefs.push(url);
                                replacedLocalPhotos.push({ originalRef: photo, replacementRef: url, kind: 'blob' });
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
                                    transientIdbPhotoRefs.add(idbRef);
                                    replacedLocalPhotos.push({
                                        originalRef: photo,
                                        replacementRef: idbRef,
                                        kind: 'blob',
                                    });
                                } catch {
                                    uploadedPhotos.push(photo);
                                }
                                allPhotosUploaded = false;
                                failedPhotoUploads++;
                            }
                        } else {
                            allPhotosUploaded = false;
                            failedPhotoUploads++;
                        }
                        // If blob not in Map → app was restarted and it's gone.
                    } else if (photo.startsWith('data:')) {
                        const url = await this._uploadDataUri(photo, scope);
                        if (url) {
                            trackStorageRef(PHOTO_BUCKET, url);
                            if (!isAuthIdentityScopeCurrent(scope)) return;
                            uploadedPhotos.push(url);
                            freshPhotoStorageRefs.push(url);
                        } else {
                            // Keep the data URI for retry.
                            uploadedPhotos.push(photo);
                            allPhotosUploaded = false;
                            failedPhotoUploads++;
                        }
                    } else {
                        uploadedPhotos.push(photo);
                    }
                }

                // A storage URL is not owned by the diary until the transformed
                // queue row can be read back. Persist this handoff even when all
                // uploads succeeded: otherwise a crash before the database write
                // leaves an orphaned object and an IDB ref whose source was
                // already discarded.
                const photosChanged =
                    uploadedPhotos.length !== entry.photos.length ||
                    uploadedPhotos.some((photo, index) => photo !== entry.photos[index]);
                if (photosChanged) {
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    const pendingNow = this._getPendingEntries(scope);
                    const idx = pendingNow.findIndex((candidate) => candidate.id === entry.id);
                    if (idx < 0) continue;
                    pendingNow[idx] = { ...pendingNow[idx], photos: uploadedPhotos };
                    this._savePending(pendingNow, scope);
                    const durableEntry = this._getPendingEntries(scope).find((candidate) => candidate.id === entry.id);
                    const durablePhotos = durableEntry?.photos ?? [];

                    // Never clean an object which a partially-successful queue
                    // write already references. The durable outbox, not the
                    // helper return value, is the media commit point.
                    const durableStorageRefs = freshPhotoStorageRefs.filter((ref) => durablePhotos.includes(ref));
                    adoptStorageRefs(PHOTO_BUCKET, durableStorageRefs);
                    for (const ref of [...transientIdbPhotoRefs]) {
                        if (durablePhotos.includes(ref)) transientIdbPhotoRefs.delete(ref);
                    }

                    // Each original can be retired independently once its exact
                    // replacement appears in the durable queue, even if another
                    // photo in the same row still needs a retry.
                    for (const replacement of replacedLocalPhotos) {
                        if (!durablePhotos.includes(replacement.replacementRef)) continue;
                        if (replacement.kind === 'idb') {
                            await idbDeletePhoto(replacement.originalRef);
                            if (!isAuthIdentityScopeCurrent(scope)) return;
                            const cachedUrl = this._idbRefToBlobUrl.get(replacement.originalRef);
                            if (cachedUrl) {
                                URL.revokeObjectURL(cachedUrl);
                                this._idbRefToBlobUrl.delete(replacement.originalRef);
                            }
                            this._pendingPhotoBlobs.delete(replacement.originalRef);
                        } else {
                            this._pendingPhotoBlobs.delete(replacement.originalRef);
                            URL.revokeObjectURL(replacement.originalRef);
                        }
                    }

                    const transformedRowIsDurable =
                        !!durableEntry &&
                        durablePhotos.length === uploadedPhotos.length &&
                        durablePhotos.every((photo, index) => photo === uploadedPhotos[index]);
                    if (!transformedRowIsDurable) {
                        log.warn(
                            `[Diary] entry "${entry.title || entry.id}" deferred — ` +
                                'uploaded photo references were not durably adopted by the device outbox.',
                        );
                        continue;
                    }

                    entry = durableEntry;
                }

                // If any photo failed to upload, skip the entry insert for
                // this round — we'll retry on the next sync. Any successful
                // replacements above are already durable and will be reused.
                if (!allPhotosUploaded) {
                    // warn(), not info(): createLogger no-ops info in production
                    // builds, so on a device this deferral said NOTHING. An entry
                    // can sit here across every 30 s retry, every reconnect and
                    // every app launch — indefinitely, because there is no
                    // attempt ceiling and the IDB blob is only discarded on
                    // success, so each retry re-attempts the identical upload.
                    // A week of that is invisible unless the line is a warn.
                    //
                    // Still a `continue`, deliberately. Both the Pi handoff and
                    // the direct write live below, so this parks the whole entry
                    // — but publishing a diary row that references a photo which
                    // does not exist in Storage would be worse than waiting: the
                    // public page would render a broken image with no way back.
                    // The escape hatch is making the CAUSE visible (the upload
                    // errors above now name themselves) rather than shipping a
                    // half-entry.
                    log.warn(
                        `[Diary] entry "${entry.title || entry.id}" deferred — ` +
                            `${failedPhotoUploads} of ${entry.photos.length} photo(s) not uploaded. ` +
                            `It will retry, and stays local until they land.`,
                    );
                    continue;
                }

                // 2. Upload pending audio if needed. Keep IDB/data refs in
                // the pending queue until storage succeeds; never insert an
                // unresolved base64 or local reference into the server row.
                let audioUrl = entry.audio_url;
                let audioStillPending = false;
                if (audioUrl && isIdbAudio(audioUrl)) {
                    const idbRef = audioUrl;
                    const blob = await idbLoadAudio(idbRef);
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    if (!blob) {
                        log.warn('IDB audio missing, saving diary text without the memo:', idbRef);
                        audioUrl = null;
                    } else {
                        const uploaded = await this._uploadAudioBlob(blob, scope);
                        if (uploaded) {
                            trackStorageRef(AUDIO_BUCKET, uploaded);
                            if (!isAuthIdentityScopeCurrent(scope)) return;
                            // Make the durable queue point to storage before
                            // inserting the row. If the row insert retries,
                            // it reuses this object instead of orphaning a
                            // fresh upload on every attempt.
                            const pendingNow = this._getPendingEntries(scope);
                            const idx = pendingNow.findIndex((e) => e.id === entry.id);
                            if (idx >= 0) {
                                pendingNow[idx] = { ...pendingNow[idx], audio_url: uploaded };
                                this._savePending(pendingNow, scope);
                                const durableEntry = this._getPendingEntries(scope).find(
                                    (candidate) => candidate.id === entry.id,
                                );
                                if (durableEntry?.audio_url === uploaded) {
                                    adoptStorageRefs(AUDIO_BUCKET, [uploaded]);
                                    entry = durableEntry;
                                    audioUrl = uploaded;
                                    await this.discardUnsavedAudio(idbRef);
                                    if (!isAuthIdentityScopeCurrent(scope)) return;
                                } else {
                                    audioStillPending = true;
                                }
                            } else {
                                audioStillPending = true;
                            }
                        } else {
                            audioStillPending = true;
                        }
                    }
                } else if (audioUrl && audioUrl.startsWith('data:')) {
                    const uploaded = await this._uploadAudioDataUri(audioUrl, scope);
                    if (uploaded) {
                        trackStorageRef(AUDIO_BUCKET, uploaded);
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                        const pendingNow = this._getPendingEntries(scope);
                        const idx = pendingNow.findIndex((candidate) => candidate.id === entry.id);
                        if (idx >= 0) {
                            pendingNow[idx] = { ...pendingNow[idx], audio_url: uploaded };
                            this._savePending(pendingNow, scope);
                            const durableEntry = this._getPendingEntries(scope).find(
                                (candidate) => candidate.id === entry.id,
                            );
                            if (durableEntry?.audio_url === uploaded) {
                                adoptStorageRefs(AUDIO_BUCKET, [uploaded]);
                                entry = durableEntry;
                                audioUrl = uploaded;
                            } else {
                                audioStillPending = true;
                            }
                        } else {
                            audioStillPending = true;
                        }
                    } else audioStillPending = true;
                }
                if (!isAuthIdentityScopeCurrent(scope)) return;

                // 2b. Upload a parked video clip the same way. IDB-only: video
                // is never a data: URI (a 200MB base64 string would kill the
                // WebView long before it killed the uplink).
                let videoUrl = entry.video_url ?? null;
                let videoStillPending = false;
                if (videoUrl && isIdbVideo(videoUrl)) {
                    const idbRef = videoUrl;
                    const blob = await idbLoadVideo(idbRef);
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    if (!blob) {
                        log.warn('IDB video missing, saving diary text without the clip:', idbRef);
                        videoUrl = null;
                    } else {
                        // The phone first: on real internet the clip is
                        // public in seconds and the entry never points at a
                        // video that has not come ashore. The Pi is the
                        // BAD-uplink path, not the default (Shane,
                        // 2026-08-31: "if the phone can upload direct, all
                        // the better. but if it cant, then pi first, as
                        // always. if it exists") — so when a Pi is paired
                        // the direct attempt gets a size-scaled budget and
                        // the Pi catches whatever cannot finish inside it.
                        // With no Pi the attempt keeps its old open-ended
                        // patience, and a clip that still fails stays in IDB
                        // for the next drain — it sits on the phone until
                        // internet is solid.
                        const piStandingBy = isPiVideoRelayAvailable(scope);
                        const uploaded =
                            (await this._uploadVideoBlob(
                                blob,
                                scope,
                                piStandingBy ? directVideoBudgetMs(blob.size) : null,
                            )) ?? (await this._parkVideoOnPi(blob, entry.client_operation_id ?? '', scope));
                        if (uploaded) {
                            trackStorageRef(VIDEO_BUCKET, uploaded);
                            if (!isAuthIdentityScopeCurrent(scope)) return;
                            const pendingNow = this._getPendingEntries(scope);
                            const idx = pendingNow.findIndex((e) => e.id === entry.id);
                            if (idx >= 0) {
                                pendingNow[idx] = { ...pendingNow[idx], video_url: uploaded };
                                this._savePending(pendingNow, scope);
                                const durableEntry = this._getPendingEntries(scope).find(
                                    (candidate) => candidate.id === entry.id,
                                );
                                if (durableEntry?.video_url === uploaded) {
                                    adoptStorageRefs(VIDEO_BUCKET, [uploaded]);
                                    entry = durableEntry;
                                    videoUrl = uploaded;
                                    await this.discardUnsavedVideo(idbRef);
                                    if (!isAuthIdentityScopeCurrent(scope)) return;
                                } else {
                                    videoStillPending = true;
                                }
                            } else {
                                videoStillPending = true;
                            }
                        } else {
                            videoStillPending = true;
                        }
                    }
                }
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (videoStillPending) {
                    log.warn(
                        `[Diary] entry "${entry.title || entry.id}" deferred — ` +
                            `video not uploaded. It will retry, and stays local until it lands.`,
                    );
                    continue;
                }
                if (audioStillPending) {
                    // Same silent-park shape as the photo gate above, and until
                    // 20260728120000 this was reachable on format alone: the
                    // bucket rejected audio/mpeg and audio/aac, both of which
                    // the recorder is entitled to produce. Say so out loud.
                    log.warn(
                        `[Diary] entry "${entry.title || entry.id}" deferred — ` +
                            `voice memo not uploaded. It will retry, and stays local until it lands.`,
                    );
                    const pendingNow = this._getPendingEntries(scope);
                    const idx = pendingNow.findIndex((e) => e.id === entry.id);
                    if (idx >= 0) this._savePending(pendingNow, scope);
                    continue;
                }

                // 3. Re-hand the media-complete envelope to Pi before the
                // direct write. If the device loses WAN after storage upload,
                // the Pi now has the final text + storage refs and can finish
                // the database write when ordinary internet returns.
                const finalPiResult = await handoffDiaryToPi(
                    this._relayEnvelope(entry, uploadedPhotos, audioUrl || null, videoUrl || null),
                );
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (
                    finalPiResult?.status === 'synced' &&
                    this._completePendingWithServer(entry, finalPiResult.entry, scope)
                ) {
                    syncedCount++;
                    log.info(`✅ Synced diary entry via Pi: ${entry.title || entry.id}`);
                    continue;
                }

                // 4. Direct device -> Supabase. This shares the relay Edge
                // Function's revision/tombstone boundary, so a direct retry
                // and a late Pi retry can never overwrite one another.
                const data = await submitDiaryDirect(
                    this._relayEnvelope(entry, uploadedPhotos, audioUrl || null, videoUrl || null),
                );

                if (!isAuthIdentityScopeCurrent(scope)) return;

                if (data && this._completePendingWithServer(entry, data, scope)) {
                    syncedCount++;
                    log.info(`✅ Synced entry: ${entry.title || entry.id}`);
                } else if (!data) {
                    log.warn(`[Diary] Direct delivery deferred for "${entry.title}"`);
                }
            } catch (e) {
                log.error('Sync failed for entry:', entry.id, e);
                // Leave in pending queue — will retry next sync
            } finally {
                // Re-check the durable queue before deleting. A storage write
                // can succeed immediately before localStorage reports a quota
                // or verification error; any reference which did land is now
                // owned and must survive this attempt's cleanup.
                const durableEntry = this._getPendingEntries(scope).find((candidate) => candidate.id === entry.id);
                for (const candidate of uncommittedStorageRefs) {
                    const isDurable =
                        candidate.bucket === PHOTO_BUCKET
                            ? durableEntry?.photos.includes(candidate.ref) === true
                            : durableEntry?.audio_url === candidate.ref;
                    if (!isDurable) await this._removeUncommittedStorageRef(candidate.ref, candidate.bucket);
                }
                for (const ref of transientIdbPhotoRefs) await idbDeletePhoto(ref);
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
        for (const photo of entry.photos ?? []) {
            if (this._managedStorageRefBelongsToScope(photo, PHOTO_BUCKET, scope) !== false) {
                this._registerMediaRef(photo, scope);
            }
        }
        if (entry.audio_url && this._managedStorageRefBelongsToScope(entry.audio_url, AUDIO_BUCKET, scope) !== false) {
            this._registerMediaRef(entry.audio_url, scope);
        }
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

    /**
     * `null` means the value is not a managed Supabase Storage reference.
     * Managed refs are accepted only when their exact object path is rooted in
     * the authenticated owner's folder; a token in localStorage can never turn
     * another skipper's object into ours.
     */
    private _managedStorageRefBelongsToScope(
        ref: string,
        bucket: typeof PHOTO_BUCKET | typeof AUDIO_BUCKET | typeof VIDEO_BUCKET,
        scope: AuthIdentityScope,
    ): boolean | null {
        const path = this._extractStoragePath(ref, bucket);
        if (path) return Boolean(scope.userId && path.startsWith(`${scope.userId}/`));
        return ref.startsWith(STORAGE_REF_PREFIX) ? false : null;
    }

    private _photoRefBelongsToScope(ref: string, scope: AuthIdentityScope): boolean {
        if (!ref) return false;
        const managed = this._managedStorageRefBelongsToScope(ref, PHOTO_BUCKET, scope);
        if (managed !== null) return managed;
        if (isIdbPhoto(ref) || ref.startsWith('blob:') || ref.startsWith('data:')) {
            return this._ownsMediaRef(ref, scope);
        }
        return ref.startsWith('https://') || ref.startsWith('http://');
    }

    private _audioRefBelongsToScope(ref: string, scope: AuthIdentityScope): boolean {
        if (!ref) return false;
        const managed = this._managedStorageRefBelongsToScope(ref, AUDIO_BUCKET, scope);
        if (managed !== null) return managed;
        if (isIdbAudio(ref) || ref.startsWith('blob:') || ref.startsWith('data:')) {
            return this._ownsMediaRef(ref, scope);
        }
        return ref.startsWith('https://') || ref.startsWith('http://');
    }

    private _submittedMediaBelongsToScope(
        photos: string[] | undefined,
        audioUrl: string | null | undefined,
        scope: AuthIdentityScope,
        validateAudio: boolean,
        videoUrl?: string | null,
    ): boolean {
        if (photos && !photos.every((ref) => this._photoRefBelongsToScope(ref, scope))) return false;
        if (validateAudio && audioUrl && !this._audioRefBelongsToScope(audioUrl, scope)) return false;
        // A video ref is either the phone's own IDB clip or a storage/public
        // URL judged by the same ownership rule as the other buckets.
        if (videoUrl && !(isIdbVideo(videoUrl) || this._cleanupRefBelongsToScope(videoUrl, VIDEO_BUCKET, scope)))
            return false;
        return true;
    }

    private _quarantine(sourceKey: string, reason: string, value: unknown): boolean {
        try {
            const raw = localStorage.getItem(QUARANTINE_KEY);
            let parsed: unknown = [];
            if (raw) {
                try {
                    parsed = JSON.parse(raw) as unknown;
                } catch {
                    parsed = {
                        sourceKey: QUARANTINE_KEY,
                        reason: 'unreadable prior diary quarantine',
                        quarantinedAt: Date.now(),
                        value: raw,
                    } satisfies QuarantinedDiaryBytes;
                }
            }
            const retained = boundedLocalQuarantine(parsed, [
                { sourceKey, reason, quarantinedAt: Date.now(), value } satisfies QuarantinedDiaryBytes,
            ]);
            if (retained.length === 0) localStorage.removeItem(QUARANTINE_KEY);
            else localStorage.setItem(QUARANTINE_KEY, JSON.stringify(retained));
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

    /**
     * Client-only ids are safe recovery candidates only when their cache
     * namespace and immutable owner marker both belong to the current signed-in
     * skipper. Never reinterpret a server id, a tombstoned draft, or an id
     * already mapped to a completed server insert as unsynced work.
     */
    private _recoverableCachedOfflineDrafts(
        scope: AuthIdentityScope,
        cached: DiaryEntry[] = this._getCachedEntries(scope),
        pending: DiaryEntry[] = this._getPendingEntries(scope),
    ): DiaryEntry[] {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return [];
        const pendingIds = new Set(pending.map((entry) => entry.id));
        const tombstonedIds = this._tombstonedIdSet(scope);
        return cached.filter(
            (entry) =>
                entry.id.startsWith('offline-') &&
                entry.owner_user_id === scope.userId &&
                !pendingIds.has(entry.id) &&
                !tombstonedIds.has(entry.id) &&
                !this._resolveServerIdForScope(entry.id, scope),
        );
    }

    /**
     * Move cache-only, owner-verified offline drafts back to the durable queue.
     * The cache is cleared only after the queue write can be read back, so a
     * localStorage quota failure cannot discard the user's words.
     */
    private _recoverCachedOfflineDrafts(scope: AuthIdentityScope, pending: DiaryEntry[]): DiaryEntry[] {
        const cached = this._getCachedEntries(scope);
        const recoverable = this._recoverableCachedOfflineDrafts(scope, cached, pending);
        if (recoverable.length === 0 || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return pending;

        const recovered = recoverable.map((entry) => ({
            ...entry,
            user_id: scope.userId!,
            owner_user_id: scope.userId,
            // The rehydrated row must begin visually private. A separately
            // stored publish_requested intent is preserved for later relay.
            is_public: false,
            client_operation_id: entry.client_operation_id || newDiaryOperationId(),
            client_revision:
                typeof entry.client_revision === 'number' &&
                Number.isSafeInteger(entry.client_revision) &&
                entry.client_revision >= 1
                    ? entry.client_revision
                    : 1,
            _offline: true,
        }));
        const nextPending = [...pending, ...recovered];
        this._savePending(nextPending, scope);

        const stored = this._getPendingEntries(scope);
        const storedIds = new Set(stored.map((entry) => entry.id));
        if (!recovered.every((entry) => storedIds.has(entry.id))) return pending;

        const recoveredIds = new Set(recovered.map((entry) => entry.id));
        this._saveCachedEntries(
            cached.filter((entry) => !recoveredIds.has(entry.id)),
            scope,
        );
        log.info(
            `Recovered ${recovered.length} cache-only offline diary ${recovered.length === 1 ? 'entry' : 'entries'}`,
        );
        return stored;
    }

    /** Keep local public visibility honest until a server row exists. */
    private _toDisplayEntry(entry: DiaryEntry): DiaryEntry {
        return {
            ...entry,
            // An `offline-*` id has not yet been confirmed as a server row.
            // Older app builds could leave an optimistic `is_public: true` in
            // local storage; never let that intent look like a live public
            // diary entry. A confirmed server id is the only source of truth.
            is_public: entry.id.startsWith('offline-') ? false : entry.is_public,
            _offline: false,
        };
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
                    persisted.push({
                        id: rec.id,
                        client_operation_id:
                            typeof rec.client_operation_id === 'string' &&
                            /^[A-Za-z0-9_-]{1,128}$/.test(rec.client_operation_id)
                                ? rec.client_operation_id
                                : null,
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
        const memory = (this._memTombstones.get(scope.key) ?? []).filter((t) => t.owner_user_id === scope.userId);
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
        clientOperationId?: string | null,
        video?: string | null,
    ): void {
        const tomb: DiaryTombstone = {
            id,
            client_operation_id:
                typeof clientOperationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(clientOperationId)
                    ? clientOperationId
                    : null,
            photos,
            audio: audio ?? null,
            video: video ?? null,
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
        return this._resolveServerIdForScope(offlineId, scope);
    }

    private _resolveServerIdForScope(offlineId: string, scope: AuthIdentityScope): string | null {
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

    /**
     * Persist the device outbox and verify its durable round trip. A diary
     * save is only successful once this returns true; otherwise the composer
     * must remain open instead of promising a draft that will vanish at the
     * next iOS process suspension.
     */
    private _savePending(entries: DiaryEntry[], scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
        const owned = entries.filter((entry) => this._entryOwner(entry, false) === scope.userId);
        if (owned.length !== entries.length) {
            const rejected = entries.filter((entry) => this._entryOwner(entry, false) !== scope.userId);
            this._quarantine(PENDING_KEY, 'refused cross-owner pending write', rejected);
            log.error('Refusing to persist diary drafts under a different owner');
            return false;
        }
        const key = this._storageKey(PENDING_KEY, scope);
        const persisted = (candidate: DiaryEntry[]): boolean => {
            localStorage.setItem(key, JSON.stringify(candidate));
            const raw = localStorage.getItem(key);
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            if (!Array.isArray(parsed) || parsed.length !== candidate.length) return false;
            const byId = new Map(
                parsed
                    .filter((value): value is DiaryEntry => Boolean(value) && typeof value === 'object')
                    .map((value) => [value.id, value]),
            );
            return candidate.every((entry) => {
                const roundTripped = byId.get(entry.id);
                return (
                    roundTripped?.owner_user_id === scope.userId &&
                    roundTripped.client_operation_id === entry.client_operation_id &&
                    roundTripped.client_revision === entry.client_revision
                );
            });
        };
        try {
            // Strip blob: URLs — they're process-scoped and can't survive a
            // restart anyway. KEEP idb: refs (tiny strings pointing to Blobs
            // in IndexedDB) and data: URIs (legacy entries).
            const cleaned = owned.map((e) => ({
                ...e,
                photos: e.photos.filter((p) => !p.startsWith('blob:')),
            }));
            for (const entry of cleaned) this._registerEntryMedia(entry, scope);
            if (persisted(cleaned)) return true;
            throw new Error('Pending diary read-back verification failed');
        } catch (e) {
            // localStorage full — most likely cause is a legacy entry with
            // data: URIs. Strip all non-URL and non-idb photos as a last
            // resort so at least the text content survives.
            log.error('Pending write failed, retrying with photos stripped:', e);
            try {
                const minimal = owned.map((en) => ({
                    ...en,
                    photos: en.photos.filter(
                        (p) =>
                            p.startsWith('http://') ||
                            p.startsWith('https://') ||
                            p.startsWith(IDB_PHOTO_PREFIX) ||
                            p.startsWith(STORAGE_REF_PREFIX),
                    ),
                }));
                for (const entry of minimal) this._registerEntryMedia(entry, scope);
                if (persisted(minimal)) return true;
                throw new Error('Minimal pending diary read-back verification failed');
            } catch (e2) {
                log.error('Pending write CRITICALLY failed — entries may be lost:', e2);
                return false;
            }
        }
    }

    /**
     * Add a pending entry. Photos are expected to be durable references
     * (idb: refs, data: URIs, or http[s]: URLs) — see uploadPhoto(). Legacy
     * blob: URLs that somehow reach here get promoted to idb: refs so they
     * survive WKWebView process suspend.
     */
    private async _prepareDurablePhotoRefs(
        photos: string[],
        scope: AuthIdentityScope,
    ): Promise<{ refs: string[]; promotedFrom: string[] } | null> {
        const refs: string[] = [];
        const promotedFrom: string[] = [];
        for (const photo of photos) {
            if (!photo.startsWith('blob:')) {
                refs.push(photo);
                continue;
            }

            const pendingBlob = this._pendingPhotoBlobs.get(photo);
            if (pendingBlob?.scopeKey !== scope.key) return null;
            let durableRef: string | null = null;
            try {
                durableRef = await idbSavePhoto(pendingBlob.blob);
                if (!isAuthIdentityScopeCurrent(scope)) {
                    await idbDeletePhoto(durableRef);
                    return null;
                }
            } catch {
                durableRef = await this._blobToCompressedDataUri(pendingBlob.blob);
                if (!isAuthIdentityScopeCurrent(scope)) return null;
            }
            if (!durableRef) return null;
            this._registerMediaRef(durableRef, scope);
            refs.push(durableRef);
            promotedFrom.push(photo);
        }
        return { refs, promotedFrom };
    }

    private async _addPending(entry: DiaryEntry, scope: AuthIdentityScope): Promise<void> {
        if (entry.owner_user_id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Diary entry owner changed before persistence');
        }
        if (!this._submittedMediaBelongsToScope(entry.photos, entry.audio_url, scope, true, entry.video_url)) {
            throw new Error('Diary media is not owned by the active account');
        }
        const prepared = await this._prepareDurablePhotoRefs(entry.photos, scope);
        if (!prepared) throw new Error('Diary photos could not be durably prepared');

        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Authentication changed before diary persistence completed');
        }
        const persistedEntry = { ...entry, photos: prepared.refs, owner_user_id: scope.userId };
        const pending = this._getPendingEntries(scope);
        pending.unshift(persistedEntry);
        if (!this._savePending(pending, scope)) {
            throw new Error('Diary entry could not be durably persisted on this device');
        }
        const durable = this._getPendingEntries(scope).find((candidate) => candidate.id === entry.id);
        if (
            !durable ||
            durable.audio_url !== persistedEntry.audio_url ||
            durable.photos.length !== persistedEntry.photos.length ||
            durable.photos.some((ref, index) => ref !== persistedEntry.photos[index])
        ) {
            throw new Error('Diary media was not adopted by the durable outbox');
        }
        for (const ref of prepared.promotedFrom) await this.discardUnsavedPhoto(ref);
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
                // A background refresh can race the cache-recovery sync above.
                // Keep any owner-verified cache-only offline drafts in this
                // merge until the recovery has durably re-queued them; an
                // empty server response must never erase the skipper's words.
                const cacheOnlyDrafts = this._recoverableCachedOfflineDrafts(
                    scope,
                    this._getCachedEntries(scope),
                    pending,
                );

                // Purge stale entries from recently-synced buffer (>30s)
                const now = Date.now();
                this._recentlySynced = this._recentlySynced.filter((r) => now - r.syncedAt < 120_000);

                // Collect all IDs already in server data
                const serverIds = new Set(serverEntries.map((e) => e.id));

                // Merge: server data + pending entries + recently-synced buffer
                // (pending and recently-synced win on collision with server data)
                const localDrafts = [...pending, ...cacheOnlyDrafts].filter(
                    (entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index,
                );
                const pendingNotOnServer = localDrafts.filter((e) => !serverIds.has(e.id));
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

    /**
     * Both positions the app can honestly claim, for the compose pin.
     *
     * The two disagree exactly when the skipper is near the boat but not ON
     * it — dinghied ashore, phone on the pub table, boat WiFi still in range.
     * An entry written there is ABOUT the pub, and pinning it at the boat is
     * wrong; an entry written mid-passage must pin at the boat even when the
     * phone's own fix is a stale berth cache. Neither device can decide that —
     * only the skipper knows which story the entry tells, so the compose UI
     * asks precisely when the answer is ambiguous and never otherwise.
     *
     * The vessel candidate is LIVE NMEA only — the boat's actual electronics,
     * reachable only on the boat network. The ship-log fix is deliberately not
     * used here: while recording it follows whatever device feeds the track,
     * which may be this same phone wearing a different hat.
     */
    async getPositionCandidates(): Promise<{
        vessel: { lat: number; lon: number } | null;
        phone: { lat: number; lon: number } | null;
    }> {
        let vessel: { lat: number; lon: number } | null = null;
        try {
            const { NmeaGpsProvider } = await import('./NmeaGpsProvider');
            const fix = NmeaGpsProvider.getPosition();
            if (fix) vessel = { lat: fix.latitude, lon: fix.longitude };
        } catch {
            /* no NMEA aboard — phone-only is the ordinary shoreside case */
        }
        let phone: { lat: number; lon: number } | null = null;
        try {
            const { GpsService } = await import('./GpsService');
            const pos = await GpsService.requestCurrentForegroundPosition({
                staleLimitMs: 10_000,
                timeoutSec: 15,
            });
            if (pos) phone = { lat: pos.latitude, lon: pos.longitude };
        } catch (e) {
            log.warn('Phone GPS failed for diary candidates:', e);
        }
        return { vessel, phone };
    }

    async getCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
        // While a voyage is RECORDING, the track's own last accepted fix is
        // the most-trustworthy position in the app — it cleared the full
        // shiplog acceptance gate (accuracy + monotonic own-timestamp +
        // anti-replay). The 31-July bug: an entry composed 6.6 km out in
        // Moreton Bay pinned at the Newport berth because the one-shot
        // platform fetch handed back a cached berth fix — while the ship's
        // log had a live bay fix six seconds earlier.
        try {
            const { ShipLogService } = await import('./ShipLogService');
            if (ShipLogService.isTracking()) {
                const fix = ShipLogService.getLastAcceptedFix();
                if (fix && Date.now() - fix.timestamp < 60_000) {
                    return { lat: fix.latitude, lon: fix.longitude };
                }
            }
        } catch {
            /* shiplog unavailable — fall through to the one-shot fetch */
        }
        try {
            // Diary compose/save is an explicit foreground action. Keep it on
            // Capacitor Geolocation so attaching a position cannot also wake the
            // background tracker or raise an unrelated Motion prompt.
            const { GpsService } = await import('./GpsService');
            const pos = await GpsService.requestCurrentForegroundPosition({
                staleLimitMs: 10_000,
                timeoutSec: 15,
            });
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
        if (!canAttemptDiaryCloudDelivery()) return null;

        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            if (!supabaseUrl) return null;
            const headers = await getAuthenticatedFunctionHeaders();
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            const res = await fetchVoiceAiWithDeadline(`${supabaseUrl}/functions/v1/gemini-diary`, {
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

    /**
     * Persist a new voice memo locally without inflating the diary pending
     * queue with base64. The returned ref becomes owned only when a caller
     * saves it as part of a diary entry, so Cancel can discard it cleanly.
     */
    async saveAudioForEntry(blob: Blob): Promise<string | null> {
        if (!blob.size) return null;
        const scope = getAuthIdentityScope();
        try {
            const ref = await idbSaveAudio(blob);
            if (!isAuthIdentityScopeCurrent(scope)) {
                await idbDeleteAudio(ref);
                return null;
            }
            this._registerMediaRef(ref, scope);
            return ref;
        } catch (error) {
            log.warn('Could not persist diary audio locally:', error);
            return null;
        }
    }

    /** Discard an unsaved IndexedDB voice memo (safe to call repeatedly). */
    /**
     * Park a freshly-picked video clip locally. IDB-first for the same reason
     * as photos and memos: the durable outbox owns the ref before any Storage
     * object exists, so abandoning the compose form cannot orphan a cloud
     * object — and at ~200MB a minute, an orphaned video is the expensive kind.
     */
    async saveVideoForEntry(blob: Blob): Promise<string | null> {
        if (!blob.size) return null;
        const scope = getAuthIdentityScope();
        try {
            const ref = await idbSaveVideo(blob);
            if (!isAuthIdentityScopeCurrent(scope)) {
                await idbDeleteVideo(ref);
                return null;
            }
            this._registerMediaRef(ref, scope);
            return ref;
        } catch (error) {
            log.warn('Could not persist diary video locally:', error);
            return null;
        }
    }

    async discardUnsavedVideo(ref: string | null | undefined): Promise<void> {
        if (!ref || !isIdbVideo(ref)) return;
        await idbDeleteVideo(ref);
        const cachedUrl = this._idbVideoRefToBlobUrl.get(ref);
        if (cachedUrl) {
            URL.revokeObjectURL(cachedUrl);
            this._idbVideoRefToBlobUrl.delete(ref);
        }
    }

    /** Resolve a diary video reference to something a <video src> can play. */
    async resolveVideoUrl(ref: string): Promise<string | null> {
        const scope = getAuthIdentityScope();
        if (!ref) return null;
        if (!this._ownsMediaRef(ref, scope)) return null;
        if (ref.startsWith('blob:')) return ref;
        if (isIdbVideo(ref)) {
            const cached = this._idbVideoRefToBlobUrl.get(ref);
            if (cached) return cached;
            const blob = await idbLoadVideo(ref);
            if (!blob || !isAuthIdentityScopeCurrent(scope)) return null;
            const url = URL.createObjectURL(blob);
            this._idbVideoRefToBlobUrl.set(ref, url);
            return url;
        }
        const storagePath = this._extractStoragePath(ref, VIDEO_BUCKET);
        if (storagePath && supabase) {
            return this._createSignedStorageUrl(VIDEO_BUCKET, storagePath, ref, scope);
        }
        if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
        return null;
    }

    /**
     * Lend the clip to the Pi and return the public URL it WILL have.
     *
     * The URL is minted before the object exists: the Pi holds a
     * checksum-verified copy and uploads it when the boat has WAN, so the row
     * can sync now and the video becomes playable when the Pi lands it. That
     * window — entry visible, clip still in transit aboard — is the deliberate
     * trade for "the phone can go over the side and the diary still completes".
     */
    private async _parkVideoOnPi(
        blob: Blob,
        clientOperationId: string,
        scope: AuthIdentityScope,
    ): Promise<string | null> {
        if (!supabase || !scope.userId || !clientOperationId) return null;
        try {
            const path = `${scope.userId}/${Date.now()}.mp4`;
            const parked = await handoffVideoToPi(blob, clientOperationId, path);
            if (!parked || !isAuthIdentityScopeCurrent(scope)) return null;
            const publicUrl = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(path).data.publicUrl;
            log.info(`[Diary] video parked on the Pi (${(blob.size / 1048576).toFixed(1)} MB) → ${path}`);
            return publicUrl;
        } catch (error) {
            log.warn('[Diary] Pi video park failed; using the direct upload', error);
            return null;
        }
    }

    /**
     * With a budget (a paired Pi standing by), an attempt that cannot finish
     * in time is abandoned: the fetch cannot be cancelled from here, so the
     * in-flight request is left to its fate, but a late success deletes its
     * own object — exactly one copy of the clip ever survives, and it is
     * the one the entry references.
     */
    private async _uploadVideoBlob(
        blob: Blob,
        scope: AuthIdentityScope,
        budgetMs: number | null = null,
    ): Promise<string | null> {
        const abandoned = { value: false };
        const attempt = this._directVideoUpload(blob, scope, abandoned);
        if (budgetMs == null) return attempt;
        const winner = await Promise.race([
            attempt,
            new Promise<'budget'>((resolve) => setTimeout(() => resolve('budget'), budgetMs)),
        ]);
        if (winner !== 'budget') return winner;
        log.info(
            `[Diary] direct video upload over budget (${Math.round(budgetMs / 1000)}s) — the Pi takes it from here`,
        );
        abandoned.value = true;
        return null;
    }

    private async _directVideoUpload(
        blob: Blob,
        scope: AuthIdentityScope,
        abandoned: { value: boolean },
    ): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope) || !canAttemptDiaryCloudDelivery())
            return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        let uploadedPath: string | null = null;
        let handedOff = false;
        try {
            // iPhone hands over video/quicktime (.mov) or video/mp4; the bucket
            // allows exactly those two, so anything else is refused here with
            // the type in the message rather than dying opaquely at the bucket.
            const mimeType = blob.type === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
            const ext = mimeType === 'video/quicktime' ? 'mov' : 'mp4';
            const path = `${scope.userId}/${Date.now()}.${ext}`;
            // No Promise.race timeout here, unlike audio: a 200MB clip on a
            // boat uplink legitimately takes minutes, and abandoning a live
            // upload half-way just to retry it from zero is how a passage
            // burns its data allowance twice.
            const { error } = await supabase.storage
                .from(VIDEO_BUCKET)
                .upload(path, blob, { contentType: mimeType, upsert: false });
            if (error) {
                log.warn(`[Diary] video upload rejected (${VIDEO_BUCKET}, ${mimeType}): ${error.message}`);
                return null;
            }
            uploadedPath = path;
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            // Abandoned while uploading: the Pi owns the clip now. Fall
            // through to the finally, which deletes this stray copy.
            if (abandoned.value) return null;
            handedOff = true;
            const publicUrl = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(path).data.publicUrl;
            log.info(`[Diary] video uploaded: ${(blob.size / 1048576).toFixed(1)} MB → ${path}`);
            return publicUrl;
        } catch (e) {
            log.error('Video blob upload failed:', e);
            return null;
        } finally {
            if (uploadedPath && !handedOff) {
                await this._removeUncommittedStorageObject(VIDEO_BUCKET, uploadedPath);
            }
        }
    }

    async discardUnsavedAudio(ref: string | null | undefined): Promise<void> {
        if (!ref || !isIdbAudio(ref)) return;
        await idbDeleteAudio(ref);
        const cachedUrl = this._idbAudioRefToBlobUrl.get(ref);
        if (cachedUrl) {
            URL.revokeObjectURL(cachedUrl);
            this._idbAudioRefToBlobUrl.delete(ref);
        }
    }

    /**
     * Make a local, offline-safe representation of a freshly-recorded memo.
     * Callers should add it to a diary entry before it is registered as owned
     * media; this makes abandoning a compose form genuinely discard the memo.
     */
    async createAudioDataUri(blob: Blob): Promise<string | null> {
        if (!blob.size) return null;
        const scope = getAuthIdentityScope();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const ref = typeof reader.result === 'string' ? reader.result : null;
                if (!ref || !isAuthIdentityScopeCurrent(scope)) {
                    resolve(null);
                    return;
                }
                this._registerMediaRef(ref, scope);
                resolve(ref);
            };
            reader.onerror = () => {
                log.warn('Could not prepare diary audio for saving');
                resolve(null);
            };
            reader.onabort = () => resolve(null);
            try {
                reader.readAsDataURL(blob);
            } catch (error) {
                log.warn('Could not start diary audio preparation:', error);
                resolve(null);
            }
        });
    }

    async uploadAudio(blob: Blob): Promise<string | null> {
        const scope = getAuthIdentityScope();
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        // As with photos, a fresh memo becomes an IndexedDB ref first. The
        // durable outbox owns it before any Storage upload can begin.
        return this.saveAudioForEntry(blob);
    }

    private async _uploadAudioBlob(blob: Blob, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope) || !canAttemptDiaryCloudDelivery())
            return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;

        let uploadedPath: string | null = null;
        let handedOff = false;
        try {
            const mimeType = normalizeDiaryAudioMimeType(blob.type);
            const path = `${scope.userId}/${Date.now()}.${diaryAudioFileExtension(mimeType)}`;
            const uploadPromise = supabase.storage
                .from(AUDIO_BUCKET)
                .upload(path, blob, { contentType: mimeType, upsert: false });

            let timedOut = false;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = new Promise<null>((resolve) => {
                timeout = setTimeout(() => {
                    timedOut = true;
                    resolve(null);
                }, AUDIO_UPLOAD_TIMEOUT_MS);
            });
            const uploadResult = await Promise.race([uploadPromise, timeoutPromise]);
            if (timeout) clearTimeout(timeout);
            if (timedOut || uploadResult === null) {
                // Storage-js does not yet accept an AbortSignal. Do not leave
                // a late successful upload orphaned after the UI has moved on.
                void uploadPromise
                    .then(({ error }) => {
                        if (!error) void this._removeUncommittedStorageObject(AUDIO_BUCKET, path);
                    })
                    .catch((error) => log.warn('Late diary audio upload failed:', error));
                log.warn('Diary audio upload timed out; keeping the local memo for retry');
                return null;
            }

            const { error } = uploadResult;

            // Naming the MIME type matters here specifically: the bucket's
            // allowed_mime_types is the one rejection this path cannot retry
            // its way out of, and without the type in the message the failure
            // is indistinguishable from a network drop.
            if (error) {
                log.warn(`[Diary] audio upload rejected (${AUDIO_BUCKET}, ${mimeType}): ${error.message}`);
                return null;
            }
            uploadedPath = path;
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            handedOff = true;
            return `${STORAGE_REF_PREFIX}${AUDIO_BUCKET}:${path}`;
        } catch (e) {
            log.error('Audio blob upload failed:', e);
            return null;
        } finally {
            if (uploadedPath && !handedOff) {
                await this._removeUncommittedStorageObject(AUDIO_BUCKET, uploadedPath);
            }
        }
    }

    /** Remove an uploaded diary-audio object which no entry has adopted. */
    private async _removeAudioStorageRef(ref: string): Promise<void> {
        const path = this._extractStoragePath(ref, AUDIO_BUCKET);
        if (path) await this._removeUncommittedStorageObject(AUDIO_BUCKET, path);
    }

    private async _removeUncommittedStorageRef(ref: string, bucket: string): Promise<void> {
        const path = this._extractStoragePath(ref, bucket);
        if (path) await this._removeUncommittedStorageObject(bucket, path);
    }

    /**
     * Remove only the exact object created by a pre-commit upload attempt.
     * Never list an owner folder: after an identity transition that could expose
     * or mutate the next account's media. Storage RLS safely rejects the exact
     * old-account path if the previous credentials are already unavailable.
     */
    private async _removeUncommittedStorageObject(bucket: string, path: string): Promise<void> {
        if (!supabase) return;
        try {
            const { error } = await supabase.storage.from(bucket).remove([path]);
            if (error) log.warn(`Could not clean up uncommitted ${bucket} object:`, error.message);
        } catch (error) {
            log.warn(`Could not clean up uncommitted ${bucket} object:`, error);
        }
    }

    private async _uploadAudioDataUri(dataUri: string, scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope) || !canAttemptDiaryCloudDelivery())
            return null;
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
        if (!canAttemptDiaryCloudDelivery()) return null;

        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            if (!supabaseUrl) return null;
            const headers = await getAuthenticatedFunctionHeaders();
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            // Fetch audio as base64. Private bucket refs are signed only for
            // the current authenticated owner and expire after one hour. A
            // just-recorded data URI or IDB memo intentionally has no
            // persisted ownership token until Save, but can safely be sent
            // for this signed-in caller's immediate transcription.
            let audioBlob: Blob | null = null;
            if (isIdbAudio(audioUrl)) {
                audioBlob = await idbLoadAudio(audioUrl);
            } else {
                const resolvedAudioUrl = audioUrl.startsWith('data:') ? audioUrl : await this.resolveAudioUrl(audioUrl);
                if (!resolvedAudioUrl || !isAuthIdentityScopeCurrent(scope)) return null;
                const audioRes = await fetchVoiceAiWithDeadline(resolvedAudioUrl, {});
                audioBlob = await audioRes.blob();
            }
            if (!audioBlob) return null;
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            // MediaRecorder can include codec parameters in its MIME value
            // (for example `audio/webm;codecs=opus`). Send the canonical type
            // accepted by the transcription edge function.
            const detectedMime = normalizeDiaryAudioMimeType(mimeType || audioBlob.type);
            const base64 = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    resolve(result.split(',')[1] || result);
                };
                reader.readAsDataURL(audioBlob);
            });

            const res = await fetchVoiceAiWithDeadline(`${supabaseUrl}/functions/v1/gemini-diary`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    action: 'transcribe',
                    audio_base64: base64,
                    mime_type: detectedMime,
                }),
            });

            if (!res.ok || !isAuthIdentityScopeCurrent(scope)) {
                if (!res.ok) log.warn(`Audio transcription failed with status ${res.status}`);
                return null;
            }
            const data = await res.json();
            // Preserve an explicit empty transcript. Callers use `null` to
            // distinguish an unavailable transcription service from a valid
            // response where the recording contained no detectable speech.
            return typeof data?.transcript === 'string' ? data.transcript : null;
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
