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

import { supabase } from './supabase';
import { BgGeoManager } from './BgGeoManager';

// ── Types ──────────────────────────────────────────────────────

export interface DiaryEntry {
    id: string;
    user_id: string;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[];           // Public URLs (or data: URIs when offline)
    audio_url: string | null;   // Voice memo URL (or data: URI when offline)
    latitude: number | null;
    longitude: number | null;
    location_name: string;
    weather_summary: string;
    voyage_id: string | null;
    tags: string[];
    created_at: string;
    updated_at: string;
    _offline?: boolean;         // Client-only flag — not persisted to DB
    _pendingPhotos?: string[];  // Base64 photos awaiting upload
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

    constructor() {
        // Auto-sync when connectivity resumes
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this.syncPending());
            // Attempt sync on init
            setTimeout(() => this.syncPending(), 5000);
        }
    }

    // ── Read ───────────────────────────────────────────────────

    async getEntries(limit = 50): Promise<DiaryEntry[]> {
        // 1. Merge cached remote entries + pending offline entries
        const cached = this._getCachedEntries();
        const pending = this._getPendingEntries();

        // Combine: pending first (newest), then cached (remove dups)
        const pendingIds = new Set(pending.map(e => e.id));
        const merged = [
            ...pending,
            ...cached.filter(e => !pendingIds.has(e.id)),
        ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, limit);

        // Background refresh from Supabase (non-blocking)
        this._refreshFromServer(limit);

        return merged;
    }

    async getEntry(id: string): Promise<DiaryEntry | null> {
        // Check pending first
        const pending = this._getPendingEntries();
        const pendingMatch = pending.find(e => e.id === id);
        if (pendingMatch) return pendingMatch;

        // Check cache
        const cached = this._getCachedEntries();
        const cacheMatch = cached.find(e => e.id === id);
        if (cacheMatch) return cacheMatch;

        // Fallback to network
        if (!supabase) return null;
        const { data } = await supabase
            .from(TABLE)
            .select('*')
            .eq('id', id)
            .single();
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
            voyage_id: entry.voyage_id ?? null,
            tags: entry.tags || [],
            created_at: now,
            updated_at: now,
            _offline: true,
            _pendingPhotos: (entry.photos || []).filter(p => p.startsWith('data:')),
        };

        // Save to pending queue immediately (survives app crash)
        this._addPending(localEntry);

        // Try to sync immediately if online — await so we can return the synced entry
        if (navigator.onLine && supabase) {
            await this.syncPending();

            // If sync succeeded, the entry is no longer in the pending queue
            const stillPending = this._getPendingEntries().some(e => e.id === localEntry.id);
            if (!stillPending) {
                // Entry was synced — return server version from cache (without _offline flag)
                const cached = this._getCachedEntries();
                // Match by created_at + title since the server assigns a new UUID
                const serverEntry = cached.find(e =>
                    e.created_at === localEntry.created_at && e.title === localEntry.title
                );
                if (serverEntry) {
                    return { ...serverEntry, _offline: false };
                }
                // Fallback: return local entry with _offline cleared
                return { ...localEntry, _offline: false };
            }
        } else {
            // Fire and forget — will sync later
            this.syncPending();
        }

        return localEntry;
    }

    // ── Update ─────────────────────────────────────────────────

    async updateEntry(id: string, updates: Partial<Pick<DiaryEntry,
        'title' | 'body' | 'mood' | 'photos' | 'location_name' | 'weather_summary' | 'tags'
    >>): Promise<boolean> {
        // Update in pending queue if offline entry
        if (id.startsWith('offline-')) {
            const pending = this._getPendingEntries();
            const idx = pending.findIndex(e => e.id === id);
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

        if (!error) this._invalidateCache();
        return !error;
    }

    // ── Delete ─────────────────────────────────────────────────

    async deleteEntry(id: string): Promise<boolean> {
        // Delete from pending if offline entry
        if (id.startsWith('offline-')) {
            const pending = this._getPendingEntries();
            this._savePending(pending.filter(e => e.id !== id));
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
        if (!error) this._invalidateCache();
        return !error;
    }

    // ── Photos ─────────────────────────────────────────────────

    async uploadPhoto(file: File): Promise<string | null> {
        // Compress to base64 first (works offline)
        const dataUri = await this._fileToDataUri(file);

        // Try upload if online
        if (supabase && navigator.onLine) {
            const url = await this._uploadPhotoToStorage(file);
            if (url) return url;
        }

        // Return data URI — will be uploaded during sync
        return dataUri;
    }

    private async _uploadPhotoToStorage(file: File): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            const compressed = await this._compressImage(file);
            const ext = file.name.split('.').pop() || 'jpg';
            const path = `${user.id}/${Date.now()}.${ext}`;

            const { error } = await supabase.storage
                .from(PHOTO_BUCKET)
                .upload(path, compressed, {
                    contentType: `image/${ext === 'png' ? 'png' : 'jpeg'}`,
                    upsert: false,
                });

            if (error) return null;

            const { data: urlData } = supabase.storage
                .from(PHOTO_BUCKET)
                .getPublicUrl(path);

            return urlData?.publicUrl || null;
        } catch { return null; }
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
            const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;

            const { error } = await supabase.storage
                .from(PHOTO_BUCKET)
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

            if (error) return null;

            const { data: urlData } = supabase.storage
                .from(PHOTO_BUCKET)
                .getPublicUrl(path);

            return urlData?.publicUrl || null;
        } catch { return null; }
    }

    // ── Sync Engine ────────────────────────────────────────────

    async syncPending(): Promise<void> {
        if (this._syncInProgress || !navigator.onLine || !supabase) return;
        this._syncInProgress = true;

        try {
            const pending = this._getPendingEntries();
            if (pending.length === 0) return;

            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return;

            const synced: string[] = [];

            for (const entry of pending) {
                try {
                    // 1. Upload any pending photos (data: URIs → public URLs)
                    const uploadedPhotos: string[] = [];
                    for (const photo of entry.photos) {
                        if (photo.startsWith('data:')) {
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
                            user_id: user.id,
                            title: entry.title,
                            body: entry.body,
                            mood: entry.mood,
                            photos: uploadedPhotos,
                            audio_url: audioUrl || null,
                            latitude: entry.latitude,
                            longitude: entry.longitude,
                            location_name: entry.location_name,
                            weather_summary: entry.weather_summary,
                            voyage_id: entry.voyage_id,
                            tags: entry.tags,
                            created_at: entry.created_at,
                        })
                        .select()
                        .single();

                    if (!error && data) {
                        synced.push(entry.id);
                        console.log('[Diary] Synced entry:', entry.title);
                    }
                } catch (e) {
                    console.error('[Diary] Sync failed for entry:', entry.id, e);
                    // Leave in pending queue — will retry next sync
                }
            }

            // Remove synced entries from pending
            if (synced.length > 0) {
                const remaining = pending.filter(e => !synced.includes(e.id));
                this._savePending(remaining);
                this._invalidateCache();
                // Refresh cache with server data
                this._refreshFromServer(50);
            }
        } finally {
            this._syncInProgress = false;
        }
    }

    // ── Local Storage ──────────────────────────────────────────

    private _getCachedEntries(): DiaryEntry[] {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    private _saveCachedEntries(entries: DiaryEntry[]): void {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(entries)); } catch { }
    }

    private _getPendingEntries(): DiaryEntry[] {
        try {
            const raw = localStorage.getItem(PENDING_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    private _savePending(entries: DiaryEntry[]): void {
        try { localStorage.setItem(PENDING_KEY, JSON.stringify(entries)); } catch { }
    }

    private _addPending(entry: DiaryEntry): void {
        const pending = this._getPendingEntries();
        pending.unshift(entry);
        this._savePending(pending);
    }

    private _invalidateCache(): void {
        try { localStorage.removeItem(CACHE_KEY); } catch { }
    }

    private async _refreshFromServer(limit: number): Promise<void> {
        if (!supabase || !navigator.onLine) return;
        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return;

            const { data } = await supabase
                .from(TABLE)
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (data && data.length > 0) {
                this._saveCachedEntries(data as DiaryEntry[]);
            }
        } catch { }
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
        } catch { return null; }
    }

    // ── GPS ────────────────────────────────────────────────────

    async getCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
        try {
            const pos = BgGeoManager.getLastPosition();
            if (pos) return { lat: pos.latitude, lon: pos.longitude };
            const fresh = await BgGeoManager.getFreshPosition(10000, 10);
            if (fresh) return { lat: fresh.latitude, lon: fresh.longitude };
            return null;
        } catch { return null; }
    }

    /** Reverse geocode lat/lon to a human-readable place name via Nominatim */
    async reverseGeocode(lat: number, lon: number): Promise<string | null> {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&addressdetails=1`,
                { headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' } }
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
            return parts.length > 0 ? parts.join(', ') : (data.display_name?.split(',').slice(0, 2).join(',').trim() || null);
        } catch {
            return null;
        }
    }

    // ── Gemini AI ──────────────────────────────────────────────

    async enhanceWithGemini(body: string, context: {
        mood: DiaryMood;
        location?: string;
        weather?: string;
    }): Promise<string | null> {
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
                }),
            });

            if (!res.ok) return null;
            const data = await res.json();
            return data?.enhanced || null;
        } catch { return null; }
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

            const { data: urlData } = supabase.storage
                .from(AUDIO_BUCKET)
                .getPublicUrl(path);

            return urlData?.publicUrl || null;
        } catch { return null; }
    }

    private async _uploadAudioDataUri(dataUri: string): Promise<string | null> {
        if (!supabase) return null;
        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return null;

        try {
            const res = await fetch(dataUri);
            const blob = await res.blob();
            return this._uploadAudioBlob(blob);
        } catch { return null; }
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
        } catch { return null; }
    }

    // ── Status ─────────────────────────────────────────────────

    getPendingCount(): number {
        return this._getPendingEntries().length;
    }
}

// Singleton
export const DiaryService = new DiaryServiceClass();
