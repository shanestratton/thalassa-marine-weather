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
import { supabase } from './supabase';
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
    created_at: string;
    updated_at: string;
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
const CACHE_KEY = 'thalassa_diary_entries_v2';
const PENDING_KEY = 'thalassa_diary_pending_v2';
const MAX_PHOTO_SIZE = 1200;

// ── Service ────────────────────────────────────────────────────

class DiaryServiceClass {
    private _syncInProgress = false;
    private _lastRefreshTime = 0;
    private _refreshPromise: Promise<void> | null = null;
    // Buffer of recently-synced entries — prevents race condition where entry
    // vanishes between pending removal and server cache arrival
    private _recentlySynced: { entry: DiaryEntry; syncedAt: number }[] = [];
    // In-memory cache of photo blobs keyed by blob: URL — avoids base64 in localStorage
    private _pendingPhotoBlobs = new Map<string, Blob>();

    constructor() {
        // Auto-sync when connectivity resumes
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this.syncPending());
            // Attempt sync on init
            setTimeout(() => this.syncPending(), 5000);
            // Periodic retry every 30s — catches stuck pending entries
            // (navigator.onLine is unreliable on iOS/Capacitor)
            setInterval(() => {
                // Only probe network if there are actually pending entries
                if (this._getPendingEntries().length > 0) this.syncPending();
            }, 30_000);
        }
    }

    // ── Read ───────────────────────────────────────────────────

    async getEntries(limit = 50): Promise<DiaryEntry[]> {
        // 1. Merge cached remote entries + pending offline entries + recently-synced buffer
        const cached = this._getCachedEntries();
        const pending = this._getPendingEntries();

        // Purge stale entries from recently-synced buffer (>30s)
        const now = Date.now();
        this._recentlySynced = this._recentlySynced.filter((r) => now - r.syncedAt < 120_000);
        const recentlySyncedEntries = this._recentlySynced.map((r) => r.entry);

        // Combine: pending first, then recently-synced, then cached (deduped)
        // This closes the gap where an entry has exited pending (sync succeeded)
        // but hasn't yet appeared in the cache (server refresh pending).
        const seenIds = new Set<string>();
        const allSources = [...pending, ...recentlySyncedEntries, ...cached];
        const deduped: DiaryEntry[] = [];
        for (const e of allSources) {
            if (!seenIds.has(e.id)) {
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
            this._refreshFromServer(limit);
        }

        // Strip _offline flag — background sync handles persistence transparently.
        // Showing PENDING badges confuses users when sync is slow or auth is stale.
        return merged.map((e) => ({ ...e, _offline: false }));
    }

    async getEntry(id: string): Promise<DiaryEntry | null> {
        // Check pending first
        const pending = this._getPendingEntries();
        const pendingMatch = pending.find((e) => e.id === id);
        if (pendingMatch) return pendingMatch;

        // Check cache
        const cached = this._getCachedEntries();
        const cacheMatch = cached.find((e) => e.id === id);
        if (cacheMatch) return cacheMatch;

        // Fallback to network
        if (!supabase) return null;
        const { data } = await supabase.from(TABLE).select('*').eq('id', id).single();
        return data as DiaryEntry | null;
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
    }): Promise<DiaryEntry> {
        const now = new Date().toISOString();
        const localEntry: DiaryEntry = {
            id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            user_id: 'local',
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
            created_at: now,
            updated_at: now,
            _offline: true,
            _pendingPhotos: (entry.photos || []).filter((p) => p.startsWith('data:')),
        };

        // Save to pending queue immediately (survives app crash).
        // _addPending is async (converts blob: photos to data URIs) but we
        // fire-and-forget to avoid blocking the UI — the entry is already
        // in React state for immediate display.
        this._addPending(localEntry).then(() => {
            // Try to sync immediately after pending save completes
            this.syncPending();
        });

        // Return entry without _offline flag — avoids persistent PENDING badge in UI.
        // The entry is in the pending queue (localStorage) so it won't be lost.
        // Background sync will upload it; if it fails, the periodic 30s retry catches it.
        return { ...localEntry, _offline: false };
    }

    // ── Update ─────────────────────────────────────────────────

    async updateEntry(
        id: string,
        updates: Partial<
            Pick<DiaryEntry, 'title' | 'body' | 'mood' | 'photos' | 'location_name' | 'weather_summary' | 'tags'>
        >,
    ): Promise<boolean> {
        // Update in pending queue if offline entry
        if (id.startsWith('offline-')) {
            const pending = this._getPendingEntries();
            const idx = pending.findIndex((e) => e.id === id);
            if (idx >= 0) {
                Object.assign(pending[idx], updates, { updated_at: new Date().toISOString() });
                this._savePending(pending);
                return true;
            }
        }

        // Update in Supabase
        if (!supabase) return false;
        const { error } = await supabase
            .from(TABLE)
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', id);

        if (!error) this._refreshFromServer(50);
        return !error;
    }

    // ── Delete ─────────────────────────────────────────────────

    async deleteEntry(id: string): Promise<boolean> {
        // Delete from pending if offline entry
        if (id.startsWith('offline-')) {
            const pending = this._getPendingEntries();
            this._savePending(pending.filter((e) => e.id !== id));
            return true;
        }

        if (!supabase) return false;

        // Delete photos from storage
        const entry = await this.getEntry(id);
        if (entry?.photos?.length) {
            for (const url of entry.photos) {
                const path = this._extractStoragePath(url);
                if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
            }
        }

        const { error } = await supabase.from(TABLE).delete().eq('id', id);
        if (!error) this._refreshFromServer(50);
        return !error;
    }

    // ── Photos ─────────────────────────────────────────────────

    async uploadPhoto(file: File): Promise<string | null> {
        // Compress first
        const compressed = await this._compressImage(file);

        // Try upload if online
        if (supabase && navigator.onLine) {
            const url = await this._uploadPhotoToStorage(file);
            if (url) return url;
        }

        // Offline: create a blob URL (tiny string) instead of a massive base64 data URI.
        // The blob displays the photo in the UI; the actual data stays in memory.
        const blobUrl = URL.createObjectURL(compressed);
        this._pendingPhotoBlobs.set(blobUrl, compressed);
        return blobUrl;
    }

    private async _uploadPhotoToStorage(file: File): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            const compressed = await this._compressImage(file);
            const ext = file.name.split('.').pop() || 'jpg';
            const path = `${user.id}/${Date.now()}.${ext}`;

            const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, compressed, {
                contentType: `image/${ext === 'png' ? 'png' : 'jpeg'}`,
                upsert: false,
            });

            if (error) return null;

            const { data: urlData } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);

            return urlData?.publicUrl || null;
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

    private async _uploadDataUri(dataUri: string): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            // Convert data URI to blob
            const res = await fetch(dataUri);
            const blob = await res.blob();
            return this._uploadBlob(blob);
        } catch (e) {
            log.error('Data URI upload failed:', e);
            return null;
        }
    }

    private async _uploadBlob(blob: Blob): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;

            const { error } = await supabase.storage
                .from(PHOTO_BUCKET)
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

            if (error) return null;

            const { data: urlData } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);

            return urlData?.publicUrl || null;
        } catch (e) {
            log.error('Blob upload failed:', e);
            return null;
        }
    }

    // ── Sync Engine ────────────────────────────────────────────

    async syncPending(): Promise<void> {
        if (this._syncInProgress) return;
        // On native (Capacitor), navigator.onLine can lie — probe the network instead
        const isOnline = await this._checkConnectivity();
        if (!isOnline || !supabase) return;
        this._syncInProgress = true;

        try {
            const pending = this._getPendingEntries();
            if (pending.length === 0) return;

            log.info(`Syncing ${pending.length} pending entries…`);

            // Try getUser first, fall back to getSession, then try refreshSession
            // (Capacitor can have stale user cache / expired JWT)
            let userId: string | undefined;
            const userResp = await supabase.auth.getUser();
            userId = userResp.data.user?.id;
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

            let syncedCount = 0;

            for (const entry of pending) {
                try {
                    // 1. Upload any pending photos (blob: URLs or data: URIs → public URLs)
                    const uploadedPhotos: string[] = [];
                    for (const photo of entry.photos) {
                        if (photo.startsWith('blob:')) {
                            // Upload from in-memory blob cache
                            const blob = this._pendingPhotoBlobs.get(photo);
                            if (blob) {
                                const url = await this._uploadBlob(blob);
                                if (url) {
                                    uploadedPhotos.push(url);
                                    this._pendingPhotoBlobs.delete(photo);
                                    URL.revokeObjectURL(photo);
                                }
                            }
                        } else if (photo.startsWith('data:')) {
                            const url = await this._uploadDataUri(photo);
                            if (url) uploadedPhotos.push(url);
                            // If upload fails, skip this photo but save the entry
                        } else {
                            uploadedPhotos.push(photo);
                        }
                    }

                    // 2. Upload pending audio if needed
                    let audioUrl = entry.audio_url;
                    if (audioUrl && audioUrl.startsWith('data:')) {
                        const uploaded = await this._uploadAudioDataUri(audioUrl);
                        if (uploaded) audioUrl = uploaded;
                    }

                    // 3. Insert entry to Supabase
                    const { data, error } = await supabase
                        .from(TABLE)
                        .insert({
                            user_id: userId,
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
                            created_at: entry.created_at,
                        })
                        .select()
                        .single();

                    if (!error && data) {
                        // Remove this entry from pending immediately (crash-safe)
                        const remaining = this._getPendingEntries().filter((e) => e.id !== entry.id);
                        this._savePending(remaining);
                        // Keep the server-returned entry in a short-lived buffer so it
                        // survives the gap between pending removal and server cache refresh
                        this._recentlySynced.push({ entry: data as DiaryEntry, syncedAt: Date.now() });
                        syncedCount++;
                        log.info(`✅ Synced entry: ${entry.title || entry.id}`);
                    } else if (error) {
                        console.error(
                            `[Diary] ❌ Supabase error for "${entry.title}":`,
                            error.message,
                            error.code,
                            error.details,
                        );
                        // If it's a duplicate (unique constraint), remove from pending — it's already synced
                        if (error.code === '23505') {
                            log.warn(`Duplicate detected — removing from pending queue`);
                            const remaining = this._getPendingEntries().filter((e) => e.id !== entry.id);
                            this._savePending(remaining);
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
        } finally {
            this._syncInProgress = false;
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

    private _getCachedEntries(): DiaryEntry[] {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            log.warn('Cache read failed:', e);
            return [];
        }
    }

    private _saveCachedEntries(entries: DiaryEntry[]): void {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
        } catch (e) {
            log.warn('Cache write failed:', e);
        }
    }

    private _getPendingEntries(): DiaryEntry[] {
        try {
            const raw = localStorage.getItem(PENDING_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            log.warn('Pending read failed:', e);
            return [];
        }
    }

    private _savePending(entries: DiaryEntry[]): void {
        try {
            // Strip blob: URLs (can't be serialized) but KEEP data: URIs.
            // Data URIs are intentionally preserved so photo data survives
            // iOS WKWebView process termination (share sheet, memory pressure).
            const cleaned = entries.map((e) => ({
                ...e,
                photos: e.photos.filter((p) => !p.startsWith('blob:')),
            }));
            localStorage.setItem(PENDING_KEY, JSON.stringify(cleaned));
        } catch (e) {
            // If localStorage is full (likely from photo data URIs), try once
            // more with aggressively stripped photos as a last resort
            log.error('Pending write failed, retrying without photos:', e);
            try {
                const minimal = entries.map((en) => ({
                    ...en,
                    photos: en.photos.filter((p) => p.startsWith('http://') || p.startsWith('https://')),
                }));
                localStorage.setItem(PENDING_KEY, JSON.stringify(minimal));
            } catch (e2) {
                log.error('Pending write CRITICALLY failed — entries may be lost:', e2);
            }
        }
    }

    /**
     * Add a pending entry, converting blob: photo URLs to compressed data URIs
     * so they survive localStorage persistence and iOS WKWebView termination.
     */
    private async _addPending(entry: DiaryEntry): Promise<void> {
        // Convert blob: photos to small data URIs before saving
        const persistedPhotos: string[] = [];
        for (const photo of entry.photos) {
            if (photo.startsWith('blob:')) {
                const blob = this._pendingPhotoBlobs.get(photo);
                if (blob) {
                    const dataUri = await this._blobToCompressedDataUri(blob);
                    if (dataUri) {
                        persistedPhotos.push(dataUri);
                        continue;
                    }
                }
                // If blob not in memory cache, skip it (can't persist)
            } else {
                persistedPhotos.push(photo);
            }
        }

        const persistedEntry = { ...entry, photos: persistedPhotos };
        const pending = this._getPendingEntries();
        pending.unshift(persistedEntry);
        this._savePending(pending);
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
            localStorage.removeItem(CACHE_KEY);
        } catch (e) {
            log.warn('Cache invalidation failed:', e);
        }
    }

    private async _refreshFromServer(limit: number): Promise<void> {
        // Deduplicate concurrent calls — reuse in-flight promise
        if (this._refreshPromise) return this._refreshPromise;
        this._refreshPromise = this._doRefreshFromServer(limit);
        try {
            await this._refreshPromise;
        } finally {
            this._refreshPromise = null;
        }
    }

    private async _doRefreshFromServer(limit: number): Promise<void> {
        // NOTE: Don't gate on navigator.onLine — it's unreliable on Capacitor.
        // Let the fetch fail gracefully in the try/catch below instead.
        if (!supabase) return;
        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return;

            const { data } = await supabase
                .from(TABLE)
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .limit(limit);

            this._lastRefreshTime = Date.now();

            if (data) {
                // IMPORTANT: Always save whatever the server returns (even empty).
                // This ensures deleted entries are properly removed from the cache.
                // But we must ALSO preserve any still-pending entries so they don't
                // vanish from the UI while waiting for sync.
                const pending = this._getPendingEntries();

                // Purge stale entries from recently-synced buffer (>30s)
                const now = Date.now();
                this._recentlySynced = this._recentlySynced.filter((r) => now - r.syncedAt < 120_000);

                // Collect all IDs already in server data
                const serverIds = new Set((data as DiaryEntry[]).map((e) => e.id));

                // Merge: server data + pending entries + recently-synced buffer
                // (pending and recently-synced win on collision with server data)
                const pendingNotOnServer = pending.filter((e) => !serverIds.has(e.id));
                const recentNotOnServer = this._recentlySynced.map((r) => r.entry).filter((e) => !serverIds.has(e.id));

                const merged = [...pendingNotOnServer, ...recentNotOnServer, ...(data as DiaryEntry[])].sort(
                    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
                );
                this._saveCachedEntries(merged);
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

    private _extractStoragePath(url: string): string | null {
        try {
            const match = url.match(/diary-photos\/(.+)$/);
            return match ? match[1] : null;
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
        if (!navigator.onLine) return null;

        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            const supabaseKey = import.meta.env?.VITE_SUPABASE_KEY || '';
            if (!supabaseUrl) return null;

            const res = await fetch(`${supabaseUrl}/functions/v1/gemini-diary`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
                },
                body: JSON.stringify({
                    action: 'enhance',
                    text: body,
                    mood: context.mood,
                    location: context.location || '',
                    weather: context.weather || '',
                    intensity: context.intensity ?? 30,
                }),
            });

            if (!res.ok) return null;
            const data = await res.json();
            return data?.enhanced || null;
        } catch (e) {
            log.error('Gemini enhance failed:', e);
            return null;
        }
    }

    // ── Audio ──────────────────────────────────────────────────

    async uploadAudio(blob: Blob): Promise<string | null> {
        // Convert to data URI for offline storage
        const dataUri = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
        });

        // Try upload if online
        if (supabase && navigator.onLine) {
            const url = await this._uploadAudioBlob(blob);
            if (url) return url;
        }

        // Return data URI — will be uploaded during sync
        return dataUri;
    }

    private async _uploadAudioBlob(blob: Blob): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            const path = `${user.id}/${Date.now()}.webm`;
            const { error } = await supabase.storage
                .from(AUDIO_BUCKET)
                .upload(path, blob, { contentType: 'audio/webm', upsert: false });

            if (error) return null;

            const { data: urlData } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(path);

            return urlData?.publicUrl || null;
        } catch (e) {
            log.error('Audio blob upload failed:', e);
            return null;
        }
    }

    private async _uploadAudioDataUri(dataUri: string): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            const res = await fetch(dataUri);
            const blob = await res.blob();
            return this._uploadAudioBlob(blob);
        } catch (e) {
            log.error('Audio data URI upload failed:', e);
            return null;
        }
    }

    async transcribeAudio(audioUrl: string, mimeType?: string): Promise<string | null> {
        if (!navigator.onLine) return null;

        try {
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
            const supabaseKey = import.meta.env?.VITE_SUPABASE_KEY || '';
            if (!supabaseUrl) return null;

            // Fetch audio as base64
            const audioRes = await fetch(audioUrl);
            const audioBlob = await audioRes.blob();
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
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
                },
                body: JSON.stringify({
                    action: 'transcribe',
                    audio_base64: base64,
                    mime_type: detectedMime,
                }),
            });

            if (!res.ok) return null;
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
