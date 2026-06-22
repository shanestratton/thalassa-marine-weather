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

import { App } from '@capacitor/app';
import { supabase, isSupabaseConfigured } from './supabase';
import { PushNotificationService } from './PushNotificationService';
import type { AnchorPosition, VesselPosition, AnchorWatchConfig } from './AnchorWatchService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SyncService');

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

    private channel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
    private stateListeners: Set<SyncListener> = new Set();
    private broadcastListeners: Set<BroadcastListener> = new Set();
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private peerTimeoutInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempts = 0;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    // One-shot guard so prolonged peer silence forces a single rejoin per
    // disconnection episode (re-armed when the peer is heard again).
    private rejoinedOnSilence = false;

    constructor() {
        // Auto-reconnect when app returns to foreground
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && !this.connected && this.sessionCode) {
                    log.info('App foregrounded — attempting reconnect');
                    this.reconnectAttempts = 0; // Reset backoff on foreground
                    this.scheduleReconnect();
                }
            });
        }
        // Auto-reconnect when network is restored
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                if (!this.connected && this.sessionCode) {
                    log.info('Network restored — attempting reconnect');
                    this.reconnectAttempts = 0;
                    this.scheduleReconnect();
                }
            });
        }
        // Native (iOS/Android) foreground signal. More reliable than the web
        // `visibilitychange` event inside a Capacitor WKWebView, which often
        // does NOT fire when the app returns from the background — which is
        // why a backgrounded follower silently lost the share and had to
        // re-enter the code.
        void App.addListener('appStateChange', ({ isActive }) => {
            if (isActive && !this.connected && this.sessionCode) {
                log.info('App active (native) — attempting reconnect');
                this.reconnectAttempts = 0;
                this.scheduleReconnect();
            }
        }).catch(() => {
            /* plugin unavailable (pure web) — visibilitychange covers it */
        });
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
     * The last joined/created session code — from memory, else the persisted
     * session — even when not currently connected. Lets the UI offer a
     * one-tap reconnect so the user never has to re-type the 6-digit code if
     * the connection ever drops and doesn't auto-recover.
     */
    getLastSessionCode(): string | null {
        if (this.sessionCode) return this.sessionCode;
        try {
            const raw = localStorage.getItem(SYNC_SESSION_KEY);
            if (!raw) return null;
            const persisted = JSON.parse(raw) as PersistedSyncSession;
            return persisted.sessionCode || null;
        } catch {
            return null;
        }
    }

    /**
     * Restore a persisted sync session after app restart/crash.
     * Called during app initialization.
     * Returns true if a session was restored and reconnected.
     */
    async restoreSession(): Promise<boolean> {
        if (!isSupabaseConfigured() || !supabase) return false;

        // Idempotent: restore is now called both on app startup AND on
        // Anchor Watch page mount. If we're already live on a session,
        // there's nothing to do — don't tear down / re-join.
        if (this.connected && this.sessionCode) return true;

        try {
            const raw = localStorage.getItem(SYNC_SESSION_KEY);
            if (!raw) return false;

            const persisted: PersistedSyncSession = JSON.parse(raw);

            // Validate persisted data (genuinely corrupt → clear).
            if (!persisted.sessionCode || !persisted.role) {
                this.clearPersistedSession();
                return false;
            }

            // Restore the code/role up front so it's available to the UI
            // (getLastSessionCode → one-tap reconnect, code display) even if
            // we don't auto-reconnect right now.
            this.role = persisted.role;
            this.sessionCode = persisted.sessionCode;

            // Don't AUTO-rejoin a very old session, but KEEP the code so the
            // user can still one-tap reconnect manually from the UI.
            const ageMs = Date.now() - (persisted.savedAt || 0);
            if (ageMs > 24 * 60 * 60 * 1000) {
                return false;
            }

            const joined = await this.joinChannel();
            if (!joined) {
                // Transient failure (e.g. no comms this instant). joinChannel
                // has already scheduled a backoff retry — KEEP the session so
                // that retry (and the user's manual reconnect) still has the
                // code. Don't wipe it.
                return false;
            }

            // Seed peer update time so the 30s timeout can detect absent peers.
            // Without this, lastPeerUpdate stays null after restore and the
            // timeout never fires — leaving shore stuck showing "Vessel Connected".
            this.lastPeerUpdate = Date.now();

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
                    await supabase
                        .from('anchor_alarm_tokens')
                        .delete()
                        .eq('session_code', this.sessionCode)
                        .eq('device_token', token);
                } catch (err) {
                    // Silently ignored — non-critical failure
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
                log.warn('sendAlarmPush: insert failed', error);
            }
        } catch (err) {
            // Silently ignored — non-critical failure
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

        this.channel
            .send({
                type: 'broadcast',
                event: 'position',
                payload,
            })
            .then((_status: string) => {})
            .catch((_err) => {
                log.warn(`[AnchorWatchSyncService]`, _err);
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
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            /* Corrupted localStorage JSON — treat as no session */
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
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            /* Corrupted localStorage JSON — treat as no session */
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
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            // localStorage might fail in some contexts — non-critical
        }
    }

    /** Clear persisted session state */
    private clearPersistedSession(): void {
        try {
            localStorage.removeItem(SYNC_SESSION_KEY);
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            // Non-critical
        }
    }

    private async joinChannel(): Promise<boolean> {
        if (!supabase || !this.sessionCode) return false;

        try {
            const channelName = `anchor-watch-${this.sessionCode}`;

            // Tear down any prior channel + timers first, so a reconnect
            // doesn't leak intervals or leave a dead half-open channel behind.
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            if (this.peerTimeoutInterval) {
                clearInterval(this.peerTimeoutInterval);
                this.peerTimeoutInterval = null;
            }
            if (this.channel) {
                try {
                    await supabase.removeChannel(this.channel);
                } catch {
                    /* best effort — old channel may already be dead */
                }
                this.channel = null;
            }

            this.channel = supabase.channel(channelName, {
                config: {
                    broadcast: { self: false, ack: true },
                    presence: { key: this.role },
                },
            });

            // Listen for position broadcasts
            this.channel.on('broadcast', { event: 'position' }, ({ payload }: { payload: PositionBroadcast }) => {
                this.lastPeerUpdate = Date.now();
                this.broadcastListeners.forEach((l) => l(payload as PositionBroadcast));
            });

            // Listen for alarm broadcasts
            this.channel.on('broadcast', { event: 'alarm' }, ({ payload }: { payload: AlarmBroadcast }) => {
                this.lastPeerUpdate = Date.now();
                this.broadcastListeners.forEach((l) => l(payload as AlarmBroadcast));
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
            this.channel.on('presence', { event: 'join' }, ({ key }: { key: string }) => {
                if (key !== this.role) {
                    this.peerConnected = true;
                    this.peerDisconnectedAt = null;
                    this.lastPeerUpdate = Date.now();
                    log.info('Peer joined:', key);
                    this.notifyState();
                }
            });

            this.channel.on('presence', { event: 'leave' }, ({ key }: { key: string }) => {
                if (key !== this.role) {
                    this.peerConnected = false;
                    this.peerDisconnectedAt = Date.now();
                    log.info('Peer left:', key);
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

            // Monitor peer liveness. Heartbeats arrive every 10s, so silence
            // means trouble. Two thresholds:
            //   • 20s → force ONE channel rejoin. Prolonged silence usually
            //     means OUR socket died (a WiFi→cell handoff leaves it
            //     half-open: the peer's heartbeats stop arriving while
            //     `connected` stays stale-true, and neither `online` nor a
            //     foreground event fires mid-walk). Rejoining over the new
            //     interface re-establishes; harmless if the peer is truly
            //     gone (we just re-subscribe and wait). Kicking in before the
            //     30s UI-disconnect makes a quick handoff often seamless.
            //   • 30s → flag the peer disconnected in the UI.
            this.peerTimeoutInterval = setInterval(() => {
                const silentMs = this.lastPeerUpdate ? Date.now() - this.lastPeerUpdate : 0;
                if (!this.lastPeerUpdate) return;

                // Peer actively heard → re-arm the one-shot rejoin.
                if (silentMs < 20000) {
                    this.rejoinedOnSilence = false;
                }

                // Suspected dead socket → force a single fresh rejoin.
                if (silentMs > 20000 && !this.rejoinedOnSilence) {
                    this.rejoinedOnSilence = true;
                    log.info('Peer silent 20s — forcing channel rejoin (suspected dead socket)');
                    this.connected = false;
                    this.reconnectAttempts = 0;
                    this.scheduleReconnect();
                }

                // UI: peer disconnected.
                if (silentMs > 30000 && this.peerConnected) {
                    this.peerConnected = false;
                    this.peerDisconnectedAt = Date.now();
                    log.warn('Peer timed out (no heartbeat for 30s)');
                    this.notifyState();
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
        log.info(`Reconnect attempt ${this.reconnectAttempts} in ${delayMs / 1000}s`);

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
        this.stateListeners.forEach((l) => {
            try {
                l(state);
            } catch (e) {
                /* State listener error silenced */
            }
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
            const { error } = await supabase.from('anchor_alarm_tokens').upsert(
                {
                    session_code: sessionCode,
                    device_token: token,
                    platform: 'ios',
                },
                {
                    onConflict: 'session_code,device_token',
                },
            );

            if (error) {
                log.warn('registerPushToken: upsert failed', error);
            }
        } catch (err) {
            // Silently ignored — non-critical failure
        }
    }
}

// Export singleton
export const AnchorWatchSyncService = new AnchorWatchSyncServiceClass();
