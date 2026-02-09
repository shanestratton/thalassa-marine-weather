/**
 * AnchorWatchSyncService — Two-device real-time sync via Supabase
 * 
 * Enables the "Shore Watch" pattern:
 * - VESSEL device: broadcasts position + alarm state to Supabase Realtime channel
 * - SHORE device: subscribes to vessel's channel for remote monitoring
 * - Session pairing via 6-digit code
 * - **Session persists across app crashes/closures** — auto-reconnects on reopen
 * 
 * Channel naming: `anchor-watch-{sessionCode}`
 * Presence tracks which devices are connected.
 */

import { supabase, isSupabaseConfigured } from './supabase';
import { PushNotificationService } from './PushNotificationService';
import type { AnchorPosition, VesselPosition, AnchorWatchConfig } from './AnchorWatchService';

// ------- TYPES -------

export type SyncRole = 'vessel' | 'shore';

export interface SyncState {
    connected: boolean;
    role: SyncRole;
    sessionCode: string | null;
    peerConnected: boolean;
    lastPeerUpdate: number | null;
    peerDisconnectedAt: number | null;
}

export interface PositionBroadcast {
    type: 'position';
    vessel: VesselPosition;
    anchor: AnchorPosition;
    distance: number;
    swingRadius: number;
    isAlarm: boolean;
    config: AnchorWatchConfig;
    timestamp: number;
}

export interface AlarmBroadcast {
    type: 'alarm';
    triggered: boolean;
    distance: number;
    swingRadius: number;
    timestamp: number;
}

export type SyncBroadcast = PositionBroadcast | AlarmBroadcast;

export type SyncListener = (state: SyncState) => void;
export type BroadcastListener = (data: SyncBroadcast) => void;

// ------- PERSISTENCE -------
const SYNC_SESSION_KEY = 'thalassa_anchor_sync_session';

interface PersistedSyncSession {
    sessionCode: string;
    role: SyncRole;
    savedAt: number;
}

// ------- HELPERS -------

/** Generate a 6-digit session code */
function generateSessionCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ------- SERVICE -------

class AnchorWatchSyncServiceClass {
    private role: SyncRole = 'vessel';
    private sessionCode: string | null = null;
    private connected = false;
    private peerConnected = false;
    private lastPeerUpdate: number | null = null;
    private peerDisconnectedAt: number | null = null;

    private channel: any | null = null;
    private stateListeners: Set<SyncListener> = new Set();
    private broadcastListeners: Set<BroadcastListener> = new Set();
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private peerTimeoutInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempts = 0;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        // Auto-reconnect when app returns to foreground
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && !this.connected && this.sessionCode) {
                    console.log('[SyncService] App foregrounded — attempting reconnect');
                    this.reconnectAttempts = 0; // Reset backoff on foreground
                    this.scheduleReconnect();
                }
            });
        }
        // Auto-reconnect when network is restored
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                if (!this.connected && this.sessionCode) {
                    console.log('[SyncService] Network restored — attempting reconnect');
                    this.reconnectAttempts = 0;
                    this.scheduleReconnect();
                }
            });
        }
    }

    // ---- PUBLIC API ----

    /** Subscribe to sync state changes */
    onStateChange(listener: SyncListener): () => void {
        this.stateListeners.add(listener);
        listener(this.getState());
        return () => this.stateListeners.delete(listener);
    }

    /** Subscribe to incoming broadcast data */
    onBroadcast(listener: BroadcastListener): () => void {
        this.broadcastListeners.add(listener);
        return () => this.broadcastListeners.delete(listener);
    }

    /** Get current sync state */
    getState(): SyncState {
        return {
            connected: this.connected,
            role: this.role,
            sessionCode: this.sessionCode,
            peerConnected: this.peerConnected,
            lastPeerUpdate: this.lastPeerUpdate,
            peerDisconnectedAt: this.peerDisconnectedAt,
        };
    }

    /**
     * Restore a persisted sync session after app restart/crash.
     * Called during app initialization.
     * Returns true if a session was restored and reconnected.
     */
    async restoreSession(): Promise<boolean> {
        if (!isSupabaseConfigured() || !supabase) return false;

        try {
            const raw = localStorage.getItem(SYNC_SESSION_KEY);
            if (!raw) return false;

            const persisted: PersistedSyncSession = JSON.parse(raw);

            // Validate persisted data
            if (!persisted.sessionCode || !persisted.role) {
                this.clearPersistedSession();
                return false;
            }

            // Sessions older than 24 hours are stale — don't reconnect
            const ageMs = Date.now() - (persisted.savedAt || 0);
            if (ageMs > 24 * 60 * 60 * 1000) {
                this.clearPersistedSession();
                return false;
            }

            // Restore state and reconnect
            this.role = persisted.role;
            this.sessionCode = persisted.sessionCode;

            const joined = await this.joinChannel();
            if (!joined) {
                // Channel might have been cleaned up — clear stale session
                this.clearPersistedSession();
                this.sessionCode = null;
                return false;
            }

            // Re-register push token for shore devices
            if (this.role === 'shore') {
                this.registerPushToken(persisted.sessionCode);
            }

            return true;
        } catch (err) {
            this.clearPersistedSession();
            return false;
        }
    }

    /**
     * Create a new watch session as VESSEL device.
     * Returns the 6-digit session code for the shore device to join.
     * Session is persisted so it survives app crashes.
     */
    async createSession(): Promise<string | null> {
        if (!isSupabaseConfigured() || !supabase) {
            return null;
        }

        this.role = 'vessel';
        this.sessionCode = generateSessionCode();

        const joined = await this.joinChannel();
        if (!joined) {
            this.sessionCode = null;
            return null;
        }

        // Persist session for crash recovery
        this.persistSession();

        return this.sessionCode;
    }

    /**
     * Join an existing watch session as SHORE device.
     * @param code The 6-digit session code from the vessel device.
     * Session is persisted so it survives app crashes.
     */
    async joinSession(code: string): Promise<boolean> {
        if (!isSupabaseConfigured() || !supabase) {
            return false;
        }

        if (!/^\d{6}$/.test(code)) {
            return false;
        }

        this.role = 'shore';
        this.sessionCode = code;

        const joined = await this.joinChannel();

        if (joined) {
            // Persist session for crash recovery
            this.persistSession();
            // Register push token for alarm notifications
            this.registerPushToken(code);
        }

        return joined;
    }

    /** Leave the current session and clear persisted state */
    async leaveSession(): Promise<void> {
        // Clear reconnect timer
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.reconnectAttempts = 0;

        // Remove push token from Supabase
        if (this.role === 'shore' && this.sessionCode && supabase) {
            const token = PushNotificationService.getToken();
            if (token) {
                try {
                    await supabase.from('anchor_alarm_tokens')
                        .delete()
                        .eq('session_code', this.sessionCode)
                        .eq('device_token', token);
                } catch (err) {
                }
            }
        }

        if (this.channel && supabase) {
            supabase.removeChannel(this.channel);
        }
        this.channel = null;
        this.connected = false;
        this.peerConnected = false;
        this.sessionCode = null;
        this.lastPeerUpdate = null;

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.peerTimeoutInterval) {
            clearInterval(this.peerTimeoutInterval);
            this.peerTimeoutInterval = null;
        }

        // Clear persisted session — this is an explicit user action
        this.clearPersistedSession();

        this.notifyState();
    }

    /**
     * Send anchor drag alarm as push notification to shore devices.
     * Called by the vessel device when drag is detected.
     * Writes an alarm event to Supabase which triggers an Edge Function
     * to send APNs Critical Alert push notifications.
     */
    async sendAlarmPush(data: {
        distance: number;
        swingRadius: number;
        vesselLat?: number;
        vesselLon?: number;
    }): Promise<void> {
        if (!supabase || !this.sessionCode || this.role !== 'vessel') return;

        try {
            const { error } = await supabase.from('anchor_alarm_events').insert({
                session_code: this.sessionCode,
                distance_m: data.distance,
                swing_radius_m: data.swingRadius,
                vessel_lat: data.vesselLat ?? null,
                vessel_lon: data.vesselLon ?? null,
            });

            if (error) {
            } else {
            }
        } catch (err) {
        }
    }

    /** Broadcast position + state (called by vessel device) */
    broadcastPosition(data: Omit<PositionBroadcast, 'type' | 'timestamp'>): void {
        if (!this.channel || this.role !== 'vessel') return;

        const payload = {
            ...data,
            type: 'position' as const,
            timestamp: Date.now(),
        };

        this.channel.send({
            type: 'broadcast',
            event: 'position',
            payload,
        }).then((status: string) => {
        }).catch((err: any) => {
        });
    }

    /** Broadcast alarm state change (called by vessel device) */
    broadcastAlarm(data: Omit<AlarmBroadcast, 'type' | 'timestamp'>): void {
        if (!this.channel || this.role !== 'vessel') return;

        this.channel.send({
            type: 'broadcast',
            event: 'alarm',
            payload: {
                ...data,
                type: 'alarm' as const,
                timestamp: Date.now(),
            },
        });
    }

    /**
     * Check if there is a persisted session that can be restored.
     * Used by UI to show reconnection state.
     */
    hasPersistedSession(): boolean {
        try {
            const raw = localStorage.getItem(SYNC_SESSION_KEY);
            if (!raw) return false;
            const persisted: PersistedSyncSession = JSON.parse(raw);
            const ageMs = Date.now() - (persisted.savedAt || 0);
            return ageMs < 24 * 60 * 60 * 1000 && !!persisted.sessionCode;
        } catch {
            return false;
        }
    }

    /**
     * Get the persisted session info without restoring.
     */
    getPersistedSession(): PersistedSyncSession | null {
        try {
            const raw = localStorage.getItem(SYNC_SESSION_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    // ---- PRIVATE ----

    /** Persist current session to localStorage for crash recovery */
    private persistSession(): void {
        if (!this.sessionCode || !this.role) return;
        try {
            const data: PersistedSyncSession = {
                sessionCode: this.sessionCode,
                role: this.role,
                savedAt: Date.now(),
            };
            localStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(data));
        } catch {
            // localStorage might fail in some contexts — non-critical
        }
    }

    /** Clear persisted session state */
    private clearPersistedSession(): void {
        try {
            localStorage.removeItem(SYNC_SESSION_KEY);
        } catch {
            // Non-critical
        }
    }

    private async joinChannel(): Promise<boolean> {
        if (!supabase || !this.sessionCode) return false;

        try {
            const channelName = `anchor-watch-${this.sessionCode}`;

            this.channel = supabase.channel(channelName, {
                config: {
                    broadcast: { self: false, ack: true },
                    presence: { key: this.role },
                },
            });

            // Listen for position broadcasts
            this.channel.on('broadcast', { event: 'position' }, ({ payload }: { payload: any }) => {
                this.lastPeerUpdate = Date.now();
                this.broadcastListeners.forEach(l => l(payload as PositionBroadcast));
            });

            // Listen for alarm broadcasts
            this.channel.on('broadcast', { event: 'alarm' }, ({ payload }: { payload: any }) => {
                this.lastPeerUpdate = Date.now();
                this.broadcastListeners.forEach(l => l(payload as AlarmBroadcast));
            });

            // Listen for heartbeats
            this.channel.on('broadcast', { event: 'heartbeat' }, () => {
                this.lastPeerUpdate = Date.now();
                if (!this.peerConnected) {
                    this.peerConnected = true;
                    this.peerDisconnectedAt = null;
                    this.notifyState();
                }
            });

            // Track presence
            this.channel.on('presence', { event: 'join' }, ({ key }: { key: any }) => {
                if (key !== this.role) {
                    this.peerConnected = true;
                    this.peerDisconnectedAt = null;
                    this.lastPeerUpdate = Date.now();
                    console.log('[SyncService] Peer joined:', key);
                    this.notifyState();
                }
            });

            this.channel.on('presence', { event: 'leave' }, ({ key }: { key: any }) => {
                if (key !== this.role) {
                    this.peerConnected = false;
                    this.peerDisconnectedAt = Date.now();
                    console.log('[SyncService] Peer left:', key);
                    this.notifyState();
                }
            });

            // Subscribe to channel
            const status = await new Promise<string>((resolve) => {
                this.channel!.subscribe((status: string) => {
                    resolve(status);
                });
            });

            if (status !== 'SUBSCRIBED') {
                // If subscription failed and we have a persisted session, try reconnecting
                this.scheduleReconnect();
                return false;
            }

            // Track our presence
            await this.channel.track({ role: this.role, joinedAt: Date.now() });

            this.connected = true;
            this.reconnectAttempts = 0; // Reset on successful connection

            // Start heartbeat (every 10s)
            this.heartbeatInterval = setInterval(() => {
                this.channel?.send({
                    type: 'broadcast',
                    event: 'heartbeat',
                    payload: { role: this.role, timestamp: Date.now() },
                });
            }, 10000);

            // Monitor peer timeout (30s without heartbeat = disconnected)
            this.peerTimeoutInterval = setInterval(() => {
                if (this.lastPeerUpdate && Date.now() - this.lastPeerUpdate > 30000) {
                    if (this.peerConnected) {
                        this.peerConnected = false;
                        this.peerDisconnectedAt = Date.now();
                        console.log('[SyncService] Peer timed out (no heartbeat for 30s)');
                        this.notifyState();
                    }
                }
            }, 5000);

            this.notifyState();
            return true;
        } catch (error) {
            // On connection error, schedule reconnect if we have persisted session
            this.scheduleReconnect();
            return false;
        }
    }

    /**
     * Schedule automatic reconnection with exponential backoff.
     * Only reconnects if there's a persisted session to restore.
     */
    private scheduleReconnect(): void {
        if (!this.sessionCode) return;
        // Clear any pending reconnect
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        // Exponential backoff: 2s, 4s, 8s, 16s, 32s, capped at 60s — never gives up
        const delayMs = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 60000);
        this.reconnectAttempts++;
        console.log(`[SyncService] Reconnect attempt ${this.reconnectAttempts} in ${delayMs / 1000}s`);

        this.reconnectTimeout = setTimeout(async () => {
            if (!this.connected && this.sessionCode) {
                const joined = await this.joinChannel();
                if (!joined) {
                    this.scheduleReconnect(); // Keep trying forever
                }
            }
        }, delayMs);
    }

    private notifyState(): void {
        const state = this.getState();
        this.stateListeners.forEach(l => {
            try { l(state); } catch (e) { /* State listener error silenced */ }
        });
    }

    /**
     * Register push token for alarm notifications.
     * Called when shore device joins a session.
     */
    private async registerPushToken(sessionCode: string): Promise<void> {
        if (!supabase) return;

        try {
            // Request permission and get token
            const token = await PushNotificationService.requestPermissionAndRegister();
            if (!token) {
                return;
            }

            // Register token to Supabase
            const { error } = await supabase.from('anchor_alarm_tokens').upsert({
                session_code: sessionCode,
                device_token: token,
                platform: 'ios',
            }, {
                onConflict: 'session_code,device_token',
            });

            if (error) {
            } else {
            }
        } catch (err) {
        }
    }
}

// Export singleton
export const AnchorWatchSyncService = new AnchorWatchSyncServiceClass();

