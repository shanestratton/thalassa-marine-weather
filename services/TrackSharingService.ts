/**
 * Track Sharing Service
 * Community track sharing via Supabase — "Strava for Sailors"
 *
 * Users can share voyage tracks (stripped of personal data) for other
 * sailors to discover and download. Pro tier required for downloads.
 *
 * Categories: anchorage, port_entry, marina_exit, harbour_entry,
 *   walking, reef_passage, bar_crossing, coastal, offshore,
 *   driving, pin_repairs, pin_food, pin_fuel, pin_supplies, pin_scenic
 */

import { supabase } from './supabase';
import { ShipLogEntry } from '../types';
import { exportVoyageAsGPX } from './gpxService';

import { createLogger } from '../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

const log = createLogger('TrackSharingService');

// --- TYPES ---

export type TrackCategory =
    | 'anchorage'
    | 'port_entry'
    | 'marina_exit'
    | 'harbour_entry'
    | 'walking'
    | 'reef_passage'
    | 'coastal'
    | 'offshore'
    | 'bar_crossing'
    | 'driving'
    | 'pin_repairs'
    | 'pin_food'
    | 'pin_fuel'
    | 'pin_supplies'
    | 'pin_scenic';

export interface SharedTrack {
    id: string;
    user_id: string;
    voyage_id?: string; // Links back to the local voyage for cascade-delete
    title: string;
    description: string;
    tags: string[];
    category: TrackCategory;
    region: string;
    center_lat: number;
    center_lon: number;
    distance_nm: number;
    point_count: number;
    download_count: number;
    vessel_draft_m?: number; // Draft depth of sharing vessel (meters)
    tide_info?: string; // Tide conditions at time of recording
    created_at: string;
    gpx_data?: string; // Only returned for downloads (Pro tier)
}

export interface SharedTrackInput {
    title: string;
    description: string;
    tags: string[];
    category: TrackCategory;
    region: string;
    vessel_draft_m?: number;
    tide_info?: string;
}

export interface BrowseFilters {
    category?: TrackCategory;
    region?: string;
    search?: string;
    limit?: number;
    offset?: number;
    sortBy?: 'created_at' | 'download_count' | 'distance_nm';
    sortOrder?: 'asc' | 'desc';
}

// Table name
const SHARED_TRACKS_TABLE = 'shared_tracks';
const MAX_PAGE_SIZE = 100;
const TRACK_METADATA_COLUMNS =
    'id, user_id, voyage_id, title, description, tags, category, region, center_lat, center_lon, distance_nm, point_count, download_count, vessel_draft_m, tide_info, created_at';

function cloneTrack(track: SharedTrack, includeGPX = false): SharedTrack {
    const cloned = {
        ...track,
        tags: Array.isArray(track.tags) ? [...track.tags] : [],
    };
    if (!includeGPX) delete cloned.gpx_data;
    return cloned;
}

function stripFilterSyntax(value: string): string {
    return value.trim().slice(0, 120).replace(/[(),]/g, ' ');
}

// --- SERVICE ---

class TrackSharingServiceClass {
    private async getOwnerForScope(scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const {
            data: { user },
            error,
        } = await supabase.auth.getUser();
        if (error || !isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;
        return scope.userId;
    }

    /**
     * Share a voyage track with the community.
     * Strips personal data (userId, vessel name, exact timestamps).
     * Converts entries to GPX and stores in Supabase.
     */
    async shareTrack(entries: ShipLogEntry[], metadata: SharedTrackInput): Promise<SharedTrack | null> {
        if (!supabase) {
            return null;
        }

        const scope = getAuthIdentityScope();
        if (!scope.userId) {
            throw new Error('Must be logged in to share tracks');
        }

        const entriesSnapshot = entries.map((entry) => ({ ...entry }));
        const metadataSnapshot: SharedTrackInput = {
            ...metadata,
            tags: [...metadata.tags],
        };
        if (entriesSnapshot.length === 0) {
            throw new Error('No entries to share');
        }

        // ── Provenance guard: only first-party device tracks can be shared ──
        // Prevents laundering imported GPX or community-downloaded tracks back
        // into the community pool under a different user's name.
        const nonDeviceEntries = entriesSnapshot.filter((e) => e.source && e.source !== 'device');
        if (nonDeviceEntries.length > 0) {
            const source = nonDeviceEntries[0].source;
            if (source === 'community_download') {
                throw new Error(
                    'Cannot re-share a community-downloaded track — only your own recorded voyages can be shared',
                );
            }
            if (source === 'gpx_import') {
                throw new Error('Cannot share imported GPX tracks — only your own recorded voyages can be shared');
            }
            throw new Error('Cannot share tracks from external sources — only your own recorded voyages can be shared');
        }

        const ownerId = await this.getOwnerForScope(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (!ownerId) {
            throw new Error('Must be logged in to share tracks');
        }
        if (entriesSnapshot.some((entry) => entry.userId !== ownerId)) {
            throw new Error('Cannot share track entries owned by another account');
        }

        // Generate GPX (uses voyage name, no vessel info for privacy)
        const gpxData = exportVoyageAsGPX(entriesSnapshot, metadataSnapshot.title);

        // Calculate track center (average of all points)
        const centerLat = entriesSnapshot.reduce((sum, e) => sum + e.latitude, 0) / entriesSnapshot.length;
        const centerLon = entriesSnapshot.reduce((sum, e) => sum + e.longitude, 0) / entriesSnapshot.length;

        // Calculate total distance — prefer cumulative, fallback to sum of legs
        const lastEntry = entriesSnapshot[entriesSnapshot.length - 1];
        let distanceNM = lastEntry.cumulativeDistanceNM || 0;
        if (distanceNM === 0) {
            // Fallback: sum individual distanceNM from each entry
            distanceNM = entriesSnapshot.reduce((sum, e) => sum + (e.distanceNM || 0), 0);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const trackData: Record<string, any> = {
            user_id: ownerId,
            voyage_id: entriesSnapshot[0]?.voyageId || null, // Link back to local voyage
            title: metadataSnapshot.title,
            description: metadataSnapshot.description,
            tags: metadataSnapshot.tags,
            category: metadataSnapshot.category,
            region: metadataSnapshot.region,
            center_lat: centerLat,
            center_lon: centerLon,
            distance_nm: Math.round(distanceNM * 10) / 10,
            point_count: entriesSnapshot.length,
            download_count: 0,
            gpx_data: gpxData,
        };

        // Include vessel draft and tide info if provided
        if (metadataSnapshot.vessel_draft_m) trackData.vessel_draft_m = metadataSnapshot.vessel_draft_m;
        if (metadataSnapshot.tide_info) trackData.tide_info = metadataSnapshot.tide_info;

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .insert(trackData)
            .select(TRACK_METADATA_COLUMNS)
            .single();

        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (error) {
            throw new Error(`Failed to share track: ${error.message}`);
        }

        return data ? cloneTrack(data as SharedTrack) : null;
    }

    /**
     * Browse community-shared tracks with optional filters.
     * GPX data is NOT included in browse results (saves bandwidth).
     */
    async browseSharedTracks(filters: BrowseFilters = {}): Promise<{ tracks: SharedTrack[]; total: number }> {
        if (!supabase) {
            return { tracks: [], total: 0 };
        }

        const scope = getAuthIdentityScope();
        const { category, region, search, limit = 20, offset = 0, sortBy = 'created_at', sortOrder = 'desc' } = filters;
        const safeLimit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
        const safeOffset = Math.max(0, Math.trunc(offset));

        // Never transfer GPX blobs through metadata/listing APIs.
        let query = supabase.from(SHARED_TRACKS_TABLE).select(TRACK_METADATA_COLUMNS, { count: 'exact' });

        // Apply filters
        if (category) {
            query = query.eq('category', category);
        }
        if (region) {
            query = query.ilike('region', `%${stripFilterSyntax(region)}%`);
        }
        if (search) {
            const safeSearch = stripFilterSyntax(search);
            if (safeSearch) query = query.or(`title.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`);
        }

        // Sort and paginate
        query = query.order(sortBy, { ascending: sortOrder === 'asc' }).range(safeOffset, safeOffset + safeLimit - 1);

        const { data, error, count } = await query;

        if (error || !isAuthIdentityScopeCurrent(scope)) {
            return { tracks: [], total: 0 };
        }

        return {
            tracks: ((data || []) as SharedTrack[]).map((track) => cloneTrack(track)),
            total: count || 0,
        };
    }

    /**
     * Download a shared track's GPX data.
     * Requires Pro tier (checked client-side; RLS enforces server-side).
     * Increments the download counter.
     */
    async downloadTrack(trackId: string, isProUser: boolean): Promise<string | null> {
        if (!supabase) return null;

        if (!isProUser) {
            throw new Error('Pro subscription required to download community tracks');
        }
        const normalizedTrackId = trackId.trim();
        if (!normalizedTrackId) return null;
        const scope = getAuthIdentityScope();

        // Fetch track metadata + GPX data
        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select('gpx_data, user_id')
            .eq('id', normalizedTrackId)
            .single();

        if (error || !data || !isAuthIdentityScopeCurrent(scope)) {
            return null;
        }

        // ── Self-import guard: can't download your own track ──
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();
        if (
            authError ||
            !isAuthIdentityScopeCurrent(scope) ||
            (scope.userId ? user?.id !== scope.userId : Boolean(user))
        ) {
            return null;
        }
        if (user && data.user_id === user.id) {
            throw new Error('Cannot download your own shared track — you already have this data');
        }

        // Count the immutable download target. A counter miss remains
        // non-critical, but awaiting it lets an account switch fence the result.
        try {
            await supabase.rpc('increment_download_count', { track_id: normalizedTrackId });
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) {
                log.warn('[TrackSharing] Counter miss is non-critical:', e);
            }
        }

        return isAuthIdentityScopeCurrent(scope) ? data.gpx_data : null;
    }

    /**
     * Delete a shared track (owner only).
     */
    async deleteSharedTrack(trackId: string): Promise<boolean> {
        if (!supabase) return false;
        const normalizedTrackId = trackId.trim();
        if (!normalizedTrackId) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getOwnerForScope(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;

        const { error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .delete()
            .eq('id', normalizedTrackId)
            .eq('user_id', ownerId); // RLS also enforces this

        if (error || !isAuthIdentityScopeCurrent(scope)) {
            return false;
        }

        return true;
    }

    /**
     * Get tracks shared by the current user.
     */
    async getMySharedTracks(): Promise<SharedTrack[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const ownerId = await this.getOwnerForScope(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select(TRACK_METADATA_COLUMNS)
            .eq('user_id', ownerId)
            .order('created_at', { ascending: false });

        if (error || !isAuthIdentityScopeCurrent(scope)) {
            return [];
        }

        // Strip GPX data from results (not needed for listing)
        return ((data || []) as SharedTrack[]).map((track) => cloneTrack(track));
    }

    async getTrackById(trackId: string, includeGPX: boolean = false): Promise<SharedTrack | null> {
        if (!supabase) return null;
        // Kept for source compatibility. GPX access must go through
        // downloadTrack so Pro and self-import checks cannot be bypassed.
        void includeGPX;
        const normalizedTrackId = trackId.trim();
        if (!normalizedTrackId) return null;
        const scope = getAuthIdentityScope();

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select(TRACK_METADATA_COLUMNS)
            .eq('id', normalizedTrackId)
            .single();

        if (error || !data || !isAuthIdentityScopeCurrent(scope)) {
            return null;
        }

        return cloneTrack(data as unknown as SharedTrack);
    }

    /**
     * Get distinct region values from all shared tracks.
     * Used to populate the region filter dropdown in the browse UI.
     */
    async getDistinctRegions(): Promise<string[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();

        const { data, error } = await supabase.from(SHARED_TRACKS_TABLE).select('region');

        if (error || !data || !isAuthIdentityScopeCurrent(scope)) return [];

        // Extract unique non-empty regions, sorted alphabetically
        const regions = new Set<string>();
        (data as { region: string }[]).forEach((row) => {
            if (row.region && row.region.trim()) {
                regions.add(row.region.trim());
            }
        });

        return Array.from(regions).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Check if a voyage has been shared to the community.
     * Returns matching shared track(s), or empty array if not shared.
     */
    async getSharedTracksByVoyageId(voyageId: string): Promise<SharedTrack[]> {
        if (!supabase) return [];
        const normalizedVoyageId = voyageId.trim();
        if (!normalizedVoyageId) return [];
        const scope = getAuthIdentityScope();
        const ownerId = await this.getOwnerForScope(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select('id, title, created_at, download_count, voyage_id')
            .eq('user_id', ownerId)
            .eq('voyage_id', normalizedVoyageId);

        if (error || !data || !isAuthIdentityScopeCurrent(scope)) return [];
        return (data as SharedTrack[]).map((track) => cloneTrack(track));
    }

    /**
     * Delete all shared tracks for a given voyage (owner only).
     * Used when a user deletes a voyage from their logbook.
     */
    async deleteSharedTracksByVoyageId(voyageId: string): Promise<boolean> {
        if (!supabase) return false;
        const normalizedVoyageId = voyageId.trim();
        if (!normalizedVoyageId) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getOwnerForScope(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;

        const { error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .delete()
            .eq('user_id', ownerId)
            .eq('voyage_id', normalizedVoyageId);

        if (error || !isAuthIdentityScopeCurrent(scope)) {
            return false;
        }
        return true;
    }
}

// Singleton
export const TrackSharingService = new TrackSharingServiceClass();
