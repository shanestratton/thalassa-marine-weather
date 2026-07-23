/**
 * GuardianService — identity-bound Maritime Neighbourhood Watch service.
 *
 * A Guardian BOLO remains a server-side safety state until its owner disarms
 * it. Changing the signed-in account deliberately does not disarm that BOLO,
 * but it does synchronously hide all of its private client state and stops its
 * timers. The next account must initialise its own session before it can see
 * or control Guardian.
 */
import { createLogger } from '../utils/createLogger';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
import { supabase } from './supabase';
import { acquireFreshOwnshipPosition, type OwnshipPosition } from './ownshipPosition';

const log = createLogger('GuardianService');

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

export const WEATHER_TEMPLATES = [
    { emoji: '💨', text: 'Wind gusting strong in the bay — check anchors' },
    { emoji: '⛈️', text: 'Squall approaching — secure everything on deck' },
    { emoji: '🌊', text: 'Swell building — uncomfortable conditions expected' },
    { emoji: '⚡', text: 'Lightning spotted nearby — stay below' },
    { emoji: '🌫️', text: 'Fog rolling in — visibility dropping fast' },
    { emoji: '🌡️', text: 'Strong current change — reset your anchor bearing' },
] as const;

const HEARTBEAT_INTERVAL_MS = 60_000;
const NEARBY_POLL_INTERVAL_MS = 30_000;
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROFILE_TEXT = 500;
const MAX_ALERT_TEXT = 1_000;
const MAX_HAIL_TEXT = 300;

function emptyState(): GuardianState {
    return {
        profile: null,
        nearbyUsers: [],
        alerts: [],
        loading: false,
        armed: false,
        nearbyCount: 0,
    };
}

function validCoordinates(lat: number | null | undefined, lon: number | null | undefined): lat is number {
    return (
        typeof lat === 'number' &&
        Number.isFinite(lat) &&
        lat >= -90 &&
        lat <= 90 &&
        typeof lon === 'number' &&
        Number.isFinite(lon) &&
        lon >= -180 &&
        lon <= 180
    );
}

function normaliseText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || text.length > maxLength) return null;
    return text;
}

function cloneProfile(profile: GuardianProfile | null): GuardianProfile | null {
    return profile ? { ...profile } : null;
}

function cloneNearby(users: NearbyUser[]): NearbyUser[] {
    return users.map((user) => ({ ...user }));
}

function cloneAlerts(alerts: GuardianAlert[]): GuardianAlert[] {
    return alerts.map((alert) => ({ ...alert, data: { ...alert.data } }));
}

function cloneState(state: GuardianState): GuardianState {
    return {
        ...state,
        profile: cloneProfile(state.profile),
        nearbyUsers: cloneNearby(state.nearbyUsers),
        alerts: cloneAlerts(state.alerts),
    };
}

class GuardianServiceClass {
    private state = emptyState();
    private listeners = new Set<GuardianListener>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private nearbyTimer: ReturnType<typeof setInterval> | null = null;
    private initializedScopeKey: string | null = null;
    private initializePromise: Promise<void> | null = null;
    private lifecycleVersion = 0;

    constructor() {
        subscribeAuthIdentityScope(() => {
            // The identity fence fires before React publishes the new user.
            // Clear A synchronously so B can never render A's Guardian data.
            this.lifecycleVersion += 1;
            this.clearTimers();
            this.initializedScopeKey = null;
            this.initializePromise = null;
            this.state = emptyState();
            this.notify();
        });
    }

    async initialize(): Promise<void> {
        const scope = getAuthIdentityScope();
        if (!supabase || !scope.userId) {
            this.stop();
            return;
        }
        if (this.initializedScopeKey === scope.key && this.initializePromise) {
            return this.initializePromise;
        }
        if (this.initializedScopeKey === scope.key && this.heartbeatTimer && this.nearbyTimer) return;

        this.lifecycleVersion += 1;
        const version = this.lifecycleVersion;
        this.clearTimers();
        this.initializedScopeKey = scope.key;
        this.state = { ...emptyState(), loading: true };
        this.notify();

        const initialization = (async () => {
            if (!(await this.remoteIdentityMatches(scope)) || !this.operationIsCurrent(scope, version)) return;
            await Promise.all([
                this.fetchProfileFor(scope, version),
                this.fetchNearbyUsersFor(scope, version),
                this.fetchAlertsFor(scope, version),
            ]);
            if (!this.operationIsCurrent(scope, version)) return;
            this.state = { ...this.state, loading: false };
            this.notify();
            this.startHeartbeat(scope, version);
            this.startNearbyPolling(scope, version);
        })().finally(() => {
            if (this.initializePromise === initialization) this.initializePromise = null;
            if (
                this.operationIsCurrent(scope, version) &&
                (!this.heartbeatTimer || !this.nearbyTimer) &&
                this.state.loading
            ) {
                this.state = { ...this.state, loading: false };
                this.notify();
            }
        });
        this.initializePromise = initialization;
        return initialization;
    }

    stop(): void {
        this.lifecycleVersion += 1;
        this.clearTimers();
        this.initializedScopeKey = null;
        this.initializePromise = null;
        this.state = emptyState();
        this.notify();
    }

    async fetchProfile(): Promise<GuardianProfile | null> {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return null;
        return this.fetchProfileFor(scope, this.lifecycleVersion);
    }

    async updateProfile(
        updates: Partial<
            Pick<GuardianProfile, 'vessel_name' | 'vessel_bio' | 'owner_name' | 'dog_name' | 'mmsi' | 'home_radius_m'>
        >,
    ): Promise<boolean> {
        const operation = await this.captureVerifiedOperation();
        if (!operation || !supabase) return false;
        const { scope, ownerId, version } = operation;
        const sanitised: Record<string, string | number | null> = {};

        for (const key of ['vessel_name', 'vessel_bio', 'owner_name', 'dog_name'] as const) {
            if (updates[key] === undefined) continue;
            if (typeof updates[key] !== 'string' || updates[key]!.length > MAX_PROFILE_TEXT) return false;
            sanitised[key] = updates[key]!.trim();
        }
        if (updates.mmsi !== undefined) {
            if (updates.mmsi !== null && !this.validMmsi(updates.mmsi)) return false;
            sanitised.mmsi = updates.mmsi;
        }
        if (updates.home_radius_m !== undefined) {
            if (
                !Number.isFinite(updates.home_radius_m) ||
                !Number.isInteger(updates.home_radius_m) ||
                updates.home_radius_m < 10 ||
                updates.home_radius_m > 10_000
            ) {
                return false;
            }
            sanitised.home_radius_m = updates.home_radius_m;
        }
        if (!Object.keys(sanitised).length) return false;

        try {
            const { error } = await supabase.from('guardian_profiles').upsert(
                {
                    user_id: ownerId,
                    ...sanitised,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
            );
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Profile update error:', error.message);
                return false;
            }
            await this.fetchProfileFor(scope, version);
            return this.operationIsCurrent(scope, version);
        } catch (error) {
            log.error('[Guardian] Profile update exception:', error);
            return false;
        }
    }

    async claimMMSI(mmsi: number): Promise<{ success: boolean; error?: string }> {
        if (!this.validMmsi(mmsi)) return { success: false, error: 'MMSI must be exactly 9 digits' };
        const operation = await this.captureVerifiedOperation();
        if (!operation || !supabase) return { success: false, error: 'Not authenticated' };
        const { scope, ownerId, version } = operation;

        try {
            const { error } = await supabase.from('guardian_profiles').upsert(
                {
                    user_id: ownerId,
                    mmsi,
                    mmsi_verified: false,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
            );
            if (!this.operationIsCurrent(scope, version)) return { success: false, error: 'Account changed' };
            if (error) {
                return {
                    success: false,
                    error: error.code === '23505' ? 'This MMSI is already claimed by another user' : error.message,
                };
            }
            await this.fetchProfileFor(scope, version);
            return this.operationIsCurrent(scope, version)
                ? { success: true }
                : { success: false, error: 'Account changed' };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    async arm(positionOverride?: OwnshipPosition): Promise<boolean> {
        const operation = await this.captureVerifiedOperation();
        if (!operation || !supabase) return false;
        const { scope, version } = operation;
        const position =
            positionOverride ??
            (await acquireFreshOwnshipPosition({
                maxGpsAgeMs: 30_000,
                timeoutSec: 10,
            }));
        if (!this.operationIsCurrent(scope, version)) return false;
        if (!position || !validCoordinates(position.lat, position.lon)) {
            log.warn('[Guardian] Cannot arm — invalid GPS position');
            return false;
        }
        const lat = position.lat;
        const lon = position.lon;

        try {
            const { error } = await supabase.rpc('guardian_arm', { lat, lon });
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Arm error:', error.message);
                return false;
            }
            this.state = { ...this.state, armed: true };
            this.notify();
            await this.fetchProfileFor(scope, version);
            return this.operationIsCurrent(scope, version);
        } catch (error) {
            log.error('[Guardian] Arm exception:', error);
            return false;
        }
    }

    async disarm(): Promise<boolean> {
        const operation = await this.captureVerifiedOperation();
        if (!operation || !supabase) return false;
        const { scope, version } = operation;
        try {
            const { error } = await supabase.rpc('guardian_disarm');
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Disarm error:', error.message);
                return false;
            }
            this.state = { ...this.state, armed: false };
            this.notify();
            await this.fetchProfileFor(scope, version);
            return this.operationIsCurrent(scope, version);
        } catch (error) {
            log.error('[Guardian] Disarm exception:', error);
            return false;
        }
    }

    async fetchNearbyUsers(): Promise<NearbyUser[]> {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return [];
        return this.fetchNearbyUsersFor(scope, this.lifecycleVersion);
    }

    async fetchAlerts(): Promise<GuardianAlert[]> {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return [];
        return this.fetchAlertsFor(scope, this.lifecycleVersion);
    }

    async reportSuspicious(description: string): Promise<{ success: boolean; notified: number }> {
        const text = normaliseText(description, MAX_ALERT_TEXT);
        const operation = await this.captureVerifiedOperation();
        if (!text || !operation || !supabase) return { success: false, notified: 0 };
        const { scope, ownerId, version } = operation;
        const position = await acquireFreshOwnshipPosition({ maxGpsAgeMs: 30_000, timeoutSec: 10 });
        if (!this.operationIsCurrent(scope, version)) return { success: false, notified: 0 };
        if (!position || !validCoordinates(position.lat, position.lon)) return { success: false, notified: 0 };
        const lat = position.lat;
        const lon = position.lon;
        const profile = this.state.profile?.user_id === ownerId ? cloneProfile(this.state.profile) : null;
        const vesselName = normaliseText(profile?.vessel_name, MAX_PROFILE_TEXT) ?? 'A nearby vessel';

        try {
            const { data, error } = await supabase.rpc('broadcast_guardian_alert', {
                sender_user_id: ownerId,
                p_alert_type: 'suspicious',
                lat,
                lon,
                radius_nm: 5,
                p_title: '🚨 Suspicious Activity Reported',
                p_body: `${vesselName}: ${text}`,
                alert_data: { description: text },
            });
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Report suspicious error:', error.message);
                return { success: false, notified: 0 };
            }
            await this.fetchAlertsFor(scope, version);
            return {
                success: this.operationIsCurrent(scope, version),
                notified: Number.isFinite(Number(data)) ? Number(data) : 0,
            };
        } catch (error) {
            log.error('[Guardian] Report suspicious exception:', error);
            return { success: false, notified: 0 };
        }
    }

    async broadcastWeatherSpike(message: string): Promise<{ success: boolean; notified: number }> {
        const text = normaliseText(message, MAX_ALERT_TEXT);
        const operation = await this.captureVerifiedOperation();
        if (!text || !operation || !supabase) return { success: false, notified: 0 };
        const { scope, ownerId, version } = operation;
        const position = await acquireFreshOwnshipPosition({ maxGpsAgeMs: 30_000, timeoutSec: 10 });
        if (!this.operationIsCurrent(scope, version)) return { success: false, notified: 0 };
        if (!position || !validCoordinates(position.lat, position.lon)) return { success: false, notified: 0 };
        const lat = position.lat;
        const lon = position.lon;

        try {
            const { data, error } = await supabase.rpc('broadcast_guardian_alert', {
                sender_user_id: ownerId,
                p_alert_type: 'weather_spike',
                lat,
                lon,
                radius_nm: 5,
                p_title: '⚠️ Weather Alert — Bay Watch',
                p_body: text,
                alert_data: { message: text },
            });
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Weather broadcast error:', error.message);
                return { success: false, notified: 0 };
            }
            await this.fetchAlertsFor(scope, version);
            return {
                success: this.operationIsCurrent(scope, version),
                notified: Number.isFinite(Number(data)) ? Number(data) : 0,
            };
        } catch (error) {
            log.error('[Guardian] Weather broadcast exception:', error);
            return { success: false, notified: 0 };
        }
    }

    async sendHail(targetUserId: string, message: string): Promise<boolean> {
        const targetId = targetUserId.trim();
        const text = normaliseText(message, MAX_HAIL_TEXT);
        const operation = await this.captureVerifiedOperation();
        if (!text || !SAFE_USER_ID.test(targetId) || !operation || !supabase) return false;
        const { scope, ownerId, version } = operation;
        if (targetId === ownerId) return false;

        const profile = this.state.profile?.user_id === ownerId ? cloneProfile(this.state.profile) : null;
        const ownerName = normaliseText(profile?.owner_name, MAX_PROFILE_TEXT) ?? 'Someone';
        const vesselName = normaliseText(profile?.vessel_name, MAX_PROFILE_TEXT) ?? 'a nearby vessel';
        const fullMessage = `${ownerName} on ${vesselName} says: ${text}`;

        try {
            const { data: sentMessage, error } = await supabase
                .from('chat_direct_messages')
                .insert({
                    sender_id: ownerId,
                    recipient_id: targetId,
                    sender_name: ownerName,
                    message: `🏴‍☠️ ${fullMessage}`,
                })
                .select('id')
                .single();
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Hail error:', error.message);
                return false;
            }
            if (sentMessage?.id) {
                await supabase.rpc('queue_dm_push', { p_message_id: sentMessage.id });
            }
            return this.operationIsCurrent(scope, version);
        } catch (error) {
            log.error('[Guardian] Hail exception:', error);
            return false;
        }
    }

    async setHomeCoordinate(lat: number, lon: number, radiusM: number = 100): Promise<boolean> {
        if (
            !validCoordinates(lat, lon) ||
            !Number.isFinite(radiusM) ||
            !Number.isInteger(radiusM) ||
            radiusM < 10 ||
            radiusM > 10_000
        ) {
            return false;
        }
        const operation = await this.captureVerifiedOperation();
        if (!operation || !supabase) return false;
        const { scope, ownerId, version } = operation;

        try {
            const { error } = await supabase.from('guardian_profiles').upsert(
                {
                    user_id: ownerId,
                    home_coordinate: `SRID=4326;POINT(${lon} ${lat})`,
                    home_radius_m: radiusM,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
            );
            if (error || !this.operationIsCurrent(scope, version)) {
                if (error) log.error('[Guardian] Set home error:', error.message);
                return false;
            }
            await this.fetchProfileFor(scope, version);
            return this.operationIsCurrent(scope, version);
        } catch (error) {
            log.error('[Guardian] Set home exception:', error);
            return false;
        }
    }

    getState(): GuardianState {
        return cloneState(this.state);
    }

    subscribe(listener: GuardianListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private async captureVerifiedOperation(): Promise<{
        scope: AuthIdentityScope;
        ownerId: string;
        version: number;
    } | null> {
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        const version = this.lifecycleVersion;
        if (!ownerId || !SAFE_USER_ID.test(ownerId) || !(await this.remoteIdentityMatches(scope))) return null;
        return this.operationIsCurrent(scope, version) ? { scope, ownerId, version } : null;
    }

    private async remoteIdentityMatches(scope: AuthIdentityScope): Promise<boolean> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
        try {
            const {
                data: { user },
                error,
            } = await supabase.auth.getUser();
            return !error && user?.id === scope.userId && isAuthIdentityScopeCurrent(scope);
        } catch {
            return false;
        }
    }

    private operationIsCurrent(scope: AuthIdentityScope, version: number): boolean {
        return (
            isAuthIdentityScopeCurrent(scope) &&
            scope.userId !== null &&
            SAFE_USER_ID.test(scope.userId) &&
            version === this.lifecycleVersion
        );
    }

    private async fetchProfileFor(scope: AuthIdentityScope, version: number): Promise<GuardianProfile | null> {
        if (!supabase || !scope.userId || !this.operationIsCurrent(scope, version)) return null;
        const ownerId = scope.userId;
        try {
            if (!(await this.remoteIdentityMatches(scope)) || !this.operationIsCurrent(scope, version)) return null;
            const { data, error } = await supabase
                .from('guardian_profiles')
                .select('*')
                .eq('user_id', ownerId)
                .maybeSingle();
            if (!this.operationIsCurrent(scope, version)) return null;
            if (error) {
                log.warn('[Guardian] Profile fetch error:', error.message);
                return null;
            }
            const profile = data && data.user_id === ownerId ? (data as GuardianProfile) : null;
            this.state = { ...this.state, profile, armed: profile?.armed ?? false };
            this.notify();
            return cloneProfile(profile);
        } catch (error) {
            log.warn('[Guardian] Profile fetch exception:', error);
            return null;
        }
    }

    private async fetchNearbyUsersFor(scope: AuthIdentityScope, version: number): Promise<NearbyUser[]> {
        if (!supabase || !scope.userId || !this.operationIsCurrent(scope, version)) return [];
        const position = await acquireFreshOwnshipPosition({ maxGpsAgeMs: 60_000, timeoutSec: 8 });
        if (!this.operationIsCurrent(scope, version)) return [];
        if (!position || !validCoordinates(position.lat, position.lon)) return [];
        const lat = position.lat;
        const lon = position.lon;
        try {
            if (!(await this.remoteIdentityMatches(scope)) || !this.operationIsCurrent(scope, version)) return [];
            const { data, error } = await supabase.rpc('thalassa_users_nearby', {
                query_lat: lat,
                query_lon: lon,
                radius_nm: 5,
            });
            if (!this.operationIsCurrent(scope, version)) return [];
            if (error) {
                log.warn('[Guardian] Nearby fetch error:', error.message);
                return [];
            }
            const users = Array.isArray(data)
                ? (data as NearbyUser[]).filter(
                      (user) =>
                          user &&
                          SAFE_USER_ID.test(user.user_id) &&
                          user.user_id !== scope.userId &&
                          Number.isFinite(user.distance_nm) &&
                          user.distance_nm >= 0,
                  )
                : [];
            this.state = { ...this.state, nearbyUsers: cloneNearby(users), nearbyCount: users.length };
            this.notify();
            return cloneNearby(users);
        } catch (error) {
            log.warn('[Guardian] Nearby fetch exception:', error);
            return [];
        }
    }

    private async fetchAlertsFor(scope: AuthIdentityScope, version: number): Promise<GuardianAlert[]> {
        if (!supabase || !scope.userId || !this.operationIsCurrent(scope, version)) return [];
        const position = await acquireFreshOwnshipPosition({ maxGpsAgeMs: 60_000, timeoutSec: 8 });
        if (!this.operationIsCurrent(scope, version)) return [];
        if (!position || !validCoordinates(position.lat, position.lon)) return [];
        const lat = position.lat;
        const lon = position.lon;
        try {
            if (!(await this.remoteIdentityMatches(scope)) || !this.operationIsCurrent(scope, version)) return [];
            const { data, error } = await supabase.rpc('guardian_alerts_nearby', {
                query_lat: lat,
                query_lon: lon,
                radius_nm: 10,
                max_hours: 24,
            });
            if (!this.operationIsCurrent(scope, version)) return [];
            if (error) {
                log.warn('[Guardian] Alerts fetch error:', error.message);
                return [];
            }
            const alerts = Array.isArray(data)
                ? (data as GuardianAlert[]).filter(
                      (alert) =>
                          alert &&
                          typeof alert.id === 'string' &&
                          validCoordinates(alert.lat, alert.lon) &&
                          typeof alert.title === 'string' &&
                          typeof alert.body === 'string',
                  )
                : [];
            this.state = { ...this.state, alerts: cloneAlerts(alerts) };
            this.notify();
            return cloneAlerts(alerts);
        } catch (error) {
            log.warn('[Guardian] Alerts fetch exception:', error);
            return [];
        }
    }

    private startHeartbeat(scope: AuthIdentityScope, version: number): void {
        if (this.heartbeatTimer || !this.operationIsCurrent(scope, version)) return;
        const beat = async () => {
            if (!supabase || !this.operationIsCurrent(scope, version) || !(await this.remoteIdentityMatches(scope))) {
                return;
            }
            const position = await acquireFreshOwnshipPosition({ maxGpsAgeMs: 60_000, timeoutSec: 8 });
            if (!this.operationIsCurrent(scope, version)) return;
            if (!position || !validCoordinates(position.lat, position.lon)) return;
            const lat = position.lat;
            const lon = position.lon;
            try {
                if (!this.operationIsCurrent(scope, version)) return;
                await supabase.rpc('guardian_heartbeat', { lat, lon });
            } catch {
                // Heartbeats are best-effort. The next interval retries.
            }
        };
        void beat();
        this.heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    }

    private startNearbyPolling(scope: AuthIdentityScope, version: number): void {
        if (this.nearbyTimer || !this.operationIsCurrent(scope, version)) return;
        this.nearbyTimer = setInterval(() => {
            void Promise.all([this.fetchNearbyUsersFor(scope, version), this.fetchAlertsFor(scope, version)]);
        }, NEARBY_POLL_INTERVAL_MS);
    }

    private clearTimers(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.nearbyTimer) clearInterval(this.nearbyTimer);
        this.heartbeatTimer = null;
        this.nearbyTimer = null;
    }

    private validMmsi(mmsi: number): boolean {
        return Number.isInteger(mmsi) && mmsi >= 100_000_000 && mmsi <= 999_999_999;
    }

    private notify(): void {
        const snapshot = cloneState(this.state);
        for (const listener of [...this.listeners]) {
            try {
                listener(cloneState(snapshot));
            } catch (error) {
                log.warn('[Guardian] Listener failed:', error);
            }
        }
    }
}

export const GuardianService = new GuardianServiceClass();
