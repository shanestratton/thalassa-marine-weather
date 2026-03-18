/**
 * GuardianService — Maritime Neighborhood Watch service layer.
 *
 * Handles:
 * - Guardian profile CRUD (vessel identity, MMSI claim)
 * - ARM/DISARM for BOLO system
 * - Bay Presence (nearby Thalassa users)
 * - Suspicious activity reporting
 * - Weather spike broadcasting
 * - Hail (social pings)
 * - GPS heartbeat (position updates)
 * - Alert feed (recent alerts nearby)
 *
 * Singleton with pub/sub for UI reactivity.
 */
import { supabase } from './supabase';
import { LocationStore } from '../stores/LocationStore';

// ── Types ──

export interface GuardianProfile {
    user_id: string;
    mmsi: number | null;
    mmsi_verified: boolean;
    vessel_name: string;
    vessel_bio: string;
    owner_name: string;
    dog_name: string;
    armed: boolean;
    armed_at: string | null;
    home_coordinate: unknown | null;
    home_radius_m: number;
    last_known_lat: number | null;
    last_known_lon: number | null;
    last_known_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface NearbyUser {
    user_id: string;
    vessel_name: string | null;
    owner_name: string | null;
    dog_name: string | null;
    mmsi: number | null;
    armed: boolean;
    distance_nm: number;
    last_known_at: string;
}

export interface GuardianAlert {
    id: string;
    alert_type: 'bolo' | 'suspicious' | 'drag_warning' | 'weather_spike' | 'geofence_breach' | 'hail';
    source_vessel_name: string | null;
    title: string;
    body: string;
    lat: number;
    lon: number;
    data: Record<string, unknown>;
    created_at: string;
}

export type GuardianState = {
    profile: GuardianProfile | null;
    nearbyUsers: NearbyUser[];
    alerts: GuardianAlert[];
    loading: boolean;
    armed: boolean;
    nearbyCount: number;
};

type GuardianListener = (state: GuardianState) => void;

// ── Pre-set Hail Messages ──
export const HAIL_MESSAGES = [
    { emoji: '🏴‍☠️', text: 'Ahoy!' },
    { emoji: '🍻', text: 'Sundowners?' },
    { emoji: '🤝', text: 'Need a hand?' },
    { emoji: '⚓', text: 'Check your anchor' },
    { emoji: '🐕', text: 'Walkies on the beach?' },
    { emoji: '🌊', text: 'Great day on the water!' },
    { emoji: '📡', text: 'Anyone on VHF 16?' },
    { emoji: '🐟', text: 'Fish biting yet?' },
] as const;

// ── Pre-set Weather Spike Templates ──
export const WEATHER_TEMPLATES = [
    { emoji: '💨', text: 'Wind gusting strong in the bay — check anchors' },
    { emoji: '⛈️', text: 'Squall approaching — secure everything on deck' },
    { emoji: '🌊', text: 'Swell building — uncomfortable conditions expected' },
    { emoji: '⚡', text: 'Lightning spotted nearby — stay below' },
    { emoji: '🌫️', text: 'Fog rolling in — visibility dropping fast' },
    { emoji: '🌡️', text: 'Strong current change — reset your anchor bearing' },
] as const;

// ── Heartbeat interval ──
const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const NEARBY_POLL_INTERVAL_MS = 30_000; // 30 seconds

// ── Service Class ──

class GuardianServiceClass {
    private state: GuardianState = {
        profile: null,
        nearbyUsers: [],
        alerts: [],
        loading: false,
        armed: false,
        nearbyCount: 0,
    };
    private listeners = new Set<GuardianListener>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private nearbyTimer: ReturnType<typeof setInterval> | null = null;
    private initialized = false;

    // ── Lifecycle ──

    /**
     * Initialize the Guardian service — fetch profile, start heartbeat.
     * Safe to call multiple times (idempotent).
     */
    async initialize(): Promise<void> {
        if (this.initialized || !supabase) return;
        this.initialized = true;

        await this.fetchProfile();
        this.startHeartbeat();
        this.startNearbyPolling();
    }

    /** Cleanup timers on app teardown */
    stop(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.nearbyTimer) {
            clearInterval(this.nearbyTimer);
            this.nearbyTimer = null;
        }
        this.initialized = false;
    }

    // ── Profile CRUD ──

    async fetchProfile(): Promise<GuardianProfile | null> {
        if (!supabase) return null;

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return null;

            const { data, error } = await supabase
                .from('guardian_profiles')
                .select('*')
                .eq('user_id', user.id)
                .maybeSingle();

            if (error) {
                console.warn('[Guardian] Profile fetch error:', error.message);
                return null;
            }

            this.state = {
                ...this.state,
                profile: data,
                armed: data?.armed ?? false,
            };
            this.notify();
            return data;
        } catch (e) {
            console.warn('[Guardian] Profile fetch exception:', e);
            return null;
        }
    }

    async updateProfile(
        updates: Partial<
            Pick<GuardianProfile, 'vessel_name' | 'vessel_bio' | 'owner_name' | 'dog_name' | 'mmsi' | 'home_radius_m'>
        >,
    ): Promise<boolean> {
        if (!supabase) return false;

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return false;

            const { error } = await supabase.from('guardian_profiles').upsert(
                {
                    user_id: user.id,
                    ...updates,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
            );

            if (error) {
                console.error('[Guardian] Profile update error:', error.message);
                return false;
            }

            await this.fetchProfile();
            return true;
        } catch (e) {
            console.error('[Guardian] Profile update exception:', e);
            return false;
        }
    }

    /** Claim an MMSI for this user */
    async claimMMSI(mmsi: number): Promise<{ success: boolean; error?: string }> {
        if (!supabase) return { success: false, error: 'Not connected' };

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return { success: false, error: 'Not authenticated' };

            const { error } = await supabase.from('guardian_profiles').upsert(
                {
                    user_id: user.id,
                    mmsi,
                    mmsi_verified: false,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
            );

            if (error) {
                if (error.code === '23505') {
                    return { success: false, error: 'This MMSI is already claimed by another user' };
                }
                return { success: false, error: error.message };
            }

            await this.fetchProfile();
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    // ── ARM / DISARM (BOLO System) ──

    async arm(): Promise<boolean> {
        if (!supabase) return false;

        const pos = LocationStore.getState();
        if (!pos.lat || !pos.lon) {
            console.warn('[Guardian] Cannot arm — no GPS position');
            return false;
        }

        try {
            const { error } = await supabase.rpc('guardian_arm', {
                lat: pos.lat,
                lon: pos.lon,
            });

            if (error) {
                console.error('[Guardian] Arm error:', error.message);
                return false;
            }

            this.state = { ...this.state, armed: true };
            this.notify();
            await this.fetchProfile();
            return true;
        } catch (e) {
            console.error('[Guardian] Arm exception:', e);
            return false;
        }
    }

    async disarm(): Promise<boolean> {
        if (!supabase) return false;

        try {
            const { error } = await supabase.rpc('guardian_disarm');

            if (error) {
                console.error('[Guardian] Disarm error:', error.message);
                return false;
            }

            this.state = { ...this.state, armed: false };
            this.notify();
            await this.fetchProfile();
            return true;
        } catch (e) {
            console.error('[Guardian] Disarm exception:', e);
            return false;
        }
    }

    // ── Bay Presence ──

    async fetchNearbyUsers(): Promise<NearbyUser[]> {
        if (!supabase) return [];

        const pos = LocationStore.getState();
        if (!pos.lat || !pos.lon) return [];

        try {
            const { data, error } = await supabase.rpc('thalassa_users_nearby', {
                query_lat: pos.lat,
                query_lon: pos.lon,
                radius_nm: 5,
            });

            if (error) {
                console.warn('[Guardian] Nearby fetch error:', error.message);
                return [];
            }

            const users = (data || []) as NearbyUser[];
            this.state = {
                ...this.state,
                nearbyUsers: users,
                nearbyCount: users.length,
            };
            this.notify();
            return users;
        } catch (e) {
            console.warn('[Guardian] Nearby fetch exception:', e);
            return [];
        }
    }

    // ── Alert Feed ──

    async fetchAlerts(): Promise<GuardianAlert[]> {
        if (!supabase) return [];

        const pos = LocationStore.getState();
        if (!pos.lat || !pos.lon) return [];

        try {
            const { data, error } = await supabase.rpc('guardian_alerts_nearby', {
                query_lat: pos.lat,
                query_lon: pos.lon,
                radius_nm: 10,
                max_hours: 24,
            });

            if (error) {
                console.warn('[Guardian] Alerts fetch error:', error.message);
                return [];
            }

            const alerts = (data || []) as GuardianAlert[];
            this.state = { ...this.state, alerts };
            this.notify();
            return alerts;
        } catch (e) {
            console.warn('[Guardian] Alerts fetch exception:', e);
            return [];
        }
    }

    // ── Report Suspicious ──

    async reportSuspicious(description: string): Promise<{
        success: boolean;
        notified: number;
    }> {
        if (!supabase) return { success: false, notified: 0 };

        const pos = LocationStore.getState();
        if (!pos.lat || !pos.lon) return { success: false, notified: 0 };

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return { success: false, notified: 0 };

            const vesselName = this.state.profile?.vessel_name || 'A nearby vessel';

            const { data, error } = await supabase.rpc('broadcast_guardian_alert', {
                sender_user_id: user.id,
                p_alert_type: 'suspicious',
                lat: pos.lat,
                lon: pos.lon,
                radius_nm: 5,
                p_title: '🚨 Suspicious Activity Reported',
                p_body: `${vesselName}: ${description}`,
                alert_data: { description },
            });

            if (error) {
                console.error('[Guardian] Report suspicious error:', error.message);
                return { success: false, notified: 0 };
            }

            await this.fetchAlerts();
            return { success: true, notified: data as number };
        } catch (e) {
            console.error('[Guardian] Report suspicious exception:', e);
            return { success: false, notified: 0 };
        }
    }

    // ── Weather Spike Broadcast ──

    async broadcastWeatherSpike(message: string): Promise<{
        success: boolean;
        notified: number;
    }> {
        if (!supabase) return { success: false, notified: 0 };

        const pos = LocationStore.getState();
        if (!pos.lat || !pos.lon) return { success: false, notified: 0 };

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return { success: false, notified: 0 };

            const { data, error } = await supabase.rpc('broadcast_guardian_alert', {
                sender_user_id: user.id,
                p_alert_type: 'weather_spike',
                lat: pos.lat,
                lon: pos.lon,
                radius_nm: 5,
                p_title: '⚠️ Weather Alert — Bay Watch',
                p_body: message,
                alert_data: { message },
            });

            if (error) {
                console.error('[Guardian] Weather broadcast error:', error.message);
                return { success: false, notified: 0 };
            }

            await this.fetchAlerts();
            return { success: true, notified: data as number };
        } catch (e) {
            console.error('[Guardian] Weather broadcast exception:', e);
            return { success: false, notified: 0 };
        }
    }

    // ── Hail (Social Ping) ──

    async sendHail(targetUserId: string, message: string): Promise<boolean> {
        if (!supabase) return false;

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return false;

            const ownerName = this.state.profile?.owner_name || 'Someone';
            const vesselName = this.state.profile?.vessel_name || 'a nearby vessel';
            const fullMessage = `${ownerName} on ${vesselName} says: ${message}`;

            // Send as DM via existing chat_direct_messages
            const { error } = await supabase.from('chat_direct_messages').insert({
                sender_id: user.id,
                recipient_id: targetUserId,
                sender_name: ownerName,
                message: `🏴‍☠️ ${fullMessage}`,
            });

            if (error) {
                console.error('[Guardian] Hail error:', error.message);
                return false;
            }

            // Also queue a push notification
            await supabase.from('push_notification_queue').insert({
                recipient_user_id: targetUserId,
                notification_type: 'hail',
                title: `🏴‍☠️ Hail from ${vesselName}`,
                body: fullMessage,
                data: { sender_id: user.id, sender_vessel: vesselName },
            });

            return true;
        } catch (e) {
            console.error('[Guardian] Hail exception:', e);
            return false;
        }
    }

    // ── Set Home Coordinate (Geofence) ──

    async setHomeCoordinate(lat: number, lon: number, radiusM: number = 100): Promise<boolean> {
        if (!supabase) return false;

        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) return false;

            const { error } = await supabase.from('guardian_profiles').upsert(
                {
                    user_id: user.id,
                    home_coordinate: `SRID=4326;POINT(${lon} ${lat})`,
                    home_radius_m: radiusM,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
            );

            if (error) {
                console.error('[Guardian] Set home error:', error.message);
                return false;
            }

            await this.fetchProfile();
            return true;
        } catch (e) {
            console.error('[Guardian] Set home exception:', e);
            return false;
        }
    }

    // ── GPS Heartbeat ──

    private startHeartbeat(): void {
        if (this.heartbeatTimer) return;

        const beat = async () => {
            if (!supabase) return;
            const pos = LocationStore.getState();
            if (!pos.lat || !pos.lon) return;

            try {
                await supabase.rpc('guardian_heartbeat', {
                    lat: pos.lat,
                    lon: pos.lon,
                });
            } catch {
                // Silent fail — heartbeat is best-effort
            }
        };

        beat(); // Immediate first beat
        this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    }

    private startNearbyPolling(): void {
        if (this.nearbyTimer) return;
        this.fetchNearbyUsers();
        this.nearbyTimer = setInterval(() => this.fetchNearbyUsers(), NEARBY_POLL_INTERVAL_MS);
    }

    // ── Pub/Sub ──

    getState(): GuardianState {
        return { ...this.state };
    }

    subscribe(fn: GuardianListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private notify(): void {
        const snapshot = { ...this.state };
        for (const fn of this.listeners) fn(snapshot);
    }
}

export const GuardianService = new GuardianServiceClass();
