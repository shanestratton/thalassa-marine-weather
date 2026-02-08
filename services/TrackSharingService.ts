/**
 * Track Sharing Service
 * Community track sharing via Supabase — "Strava for Sailors"
 * 
 * Users can share voyage tracks (stripped of personal data) for other
 * sailors to discover and download. Pro tier required for downloads.
 * 
 * Categories: anchorage, port_entry, walking, reef_passage, coastal, offshore
 */

import { supabase } from './supabase';
import { ShipLogEntry } from '../types';
import { exportVoyageAsGPX } from './gpxService';

// --- TYPES ---

export type TrackCategory = 'anchorage' | 'port_entry' | 'walking' | 'reef_passage' | 'coastal' | 'offshore' | 'bar_crossing' | 'driving';

export interface SharedTrack {
    id: string;
    user_id: string;
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

// --- SERVICE ---

class TrackSharingServiceClass {

    /**
     * Share a voyage track with the community.
     * Strips personal data (userId, vessel name, exact timestamps).
     * Converts entries to GPX and stores in Supabase.
     */
    async shareTrack(
        entries: ShipLogEntry[],
        metadata: SharedTrackInput
    ): Promise<SharedTrack | null> {
        if (!supabase) {
            return null;
        }

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            throw new Error('Must be logged in to share tracks');
        }

        if (entries.length === 0) {
            throw new Error('No entries to share');
        }

        // Generate GPX (uses voyage name, no vessel info for privacy)
        const gpxData = exportVoyageAsGPX(entries, metadata.title);

        // Calculate track center (average of all points)
        const centerLat = entries.reduce((sum, e) => sum + e.latitude, 0) / entries.length;
        const centerLon = entries.reduce((sum, e) => sum + e.longitude, 0) / entries.length;

        // Calculate total distance
        const lastEntry = entries[entries.length - 1];
        const distanceNM = lastEntry.cumulativeDistanceNM || 0;

        const trackData: Record<string, any> = {
            user_id: user.id,
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            category: metadata.category,
            region: metadata.region,
            center_lat: centerLat,
            center_lon: centerLon,
            distance_nm: Math.round(distanceNM * 10) / 10,
            point_count: entries.length,
            download_count: 0,
            gpx_data: gpxData
        };

        // Include vessel draft and tide info if provided
        if (metadata.vessel_draft_m) trackData.vessel_draft_m = metadata.vessel_draft_m;
        if (metadata.tide_info) trackData.tide_info = metadata.tide_info;

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .insert(trackData)
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to share track: ${error.message}`);
        }

        return data as SharedTrack;
    }

    /**
     * Browse community-shared tracks with optional filters.
     * GPX data is NOT included in browse results (saves bandwidth).
     */
    async browseSharedTracks(filters: BrowseFilters = {}): Promise<{ tracks: SharedTrack[]; total: number }> {
        if (!supabase) {
            return { tracks: [], total: 0 };
        }

        const {
            category,
            region,
            search,
            limit = 20,
            offset = 0,
            sortBy = 'created_at',
            sortOrder = 'desc'
        } = filters;

        // Select all and strip GPX on client side (Supabase untyped table)
        let query = supabase
            .from(SHARED_TRACKS_TABLE)
            .select('*', { count: 'exact' });

        // Apply filters
        if (category) {
            query = query.eq('category', category);
        }
        if (region) {
            query = query.ilike('region', `%${region}%`);
        }
        if (search) {
            query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
        }

        // Sort and paginate
        query = query
            .order(sortBy, { ascending: sortOrder === 'asc' })
            .range(offset, offset + limit - 1);

        const { data, error, count } = await query;

        if (error) {
            return { tracks: [], total: 0 };
        }

        return {
            tracks: ((data || []) as SharedTrack[]).map(({ gpx_data, ...rest }) => rest as SharedTrack),
            total: count || 0
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

        // Fetch GPX data
        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select('gpx_data')
            .eq('id', trackId)
            .single();

        if (error || !data) {
            return null;
        }

        // Increment download counter (fire-and-forget)
        (async () => {
            try { await supabase.rpc('increment_download_count', { track_id: trackId }); } catch { }
        })();

        return data.gpx_data;
    }

    /**
     * Delete a shared track (owner only).
     */
    async deleteSharedTrack(trackId: string): Promise<boolean> {
        if (!supabase) return false;

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return false;

        const { error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .delete()
            .eq('id', trackId)
            .eq('user_id', user.id); // RLS also enforces this

        if (error) {
            return false;
        }

        return true;
    }

    /**
     * Get tracks shared by the current user.
     */
    async getMySharedTracks(): Promise<SharedTrack[]> {
        if (!supabase) return [];

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            return [];
        }

        // Strip GPX data from results (not needed for listing)
        return ((data || []) as SharedTrack[]).map(({ gpx_data, ...rest }) => rest as SharedTrack);
    }

    /**
     * Get a single track by ID (with GPX data for Pro users).
     */
    async getTrackById(trackId: string, includeGPX: boolean = false): Promise<SharedTrack | null> {
        if (!supabase) return null;

        const { data, error } = await supabase
            .from(SHARED_TRACKS_TABLE)
            .select('*')
            .eq('id', trackId)
            .single();

        if (error) {
            return null;
        }

        const track = data as unknown as SharedTrack;
        if (!includeGPX) {
            delete track.gpx_data;
        }
        return track;
    }
}

// Singleton
export const TrackSharingService = new TrackSharingServiceClass();
