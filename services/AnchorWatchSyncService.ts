/**
 * AnchorWatchSyncService — Two-device real-time sync via Supabase
 *
 * Enables the "Shore Watch" pattern:
 * - VESSEL device: broadcasts position + alarm state to Supabase Realtime channel
 * - SHORE device: subscribes to vessel's channel for remote monitoring
 * - Session pairing via a high-entropy 12-character code
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
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

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
    /**
     * OPTIONAL, because the boat's Pi may not know it. Rode and depth are the
     * skipper's setup numbers; a Pi assigned by an older app build has none,
     * and a shore view that assumed them crashed on the first Pi broadcast
     * (2026-09-03). Partial for the same reason — the Pi sends the two fields
     * a shore watcher reads, not the whole config.
     */
    config?: Partial<AnchorWatchConfig>;
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
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_CODE_ATTEMPTS = 5;

interface PersistedSyncSession {
    sessionCode: string;
    role: SyncRole;
    userId: string;
    savedAt: number;
}

// ------- HELPERS -------

const SESSION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate a 60-bit session code without predictable Math.random state. */
function generateSessionCode(): string {
    const random = new Uint8Array(12);
    crypto.getRandomValues(random);
    return Array.from(random, (byte) => SESSION_CODE_ALPHABET[byte % SESSION_CODE_ALPHABET.length]).join('');
}

function isValidSessionCode(value: unknown): value is string {
    return typeof value === 'string' && /^[A-HJ-NP-Z2-9]{12}$/.test(value);
}

function isDuplicateSessionCodeError(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    return (
        error.code === '23505' ||
        (error.message?.toLowerCase().includes('duplicate') === true &&
            error.message.toLowerCase().includes('session') === true)
    );
}

// ------- SERVICE -------

class AnchorWatchSyncServiceClass {
    private role: SyncRole = 'vessel';
    private sessionCode: string | null = null;
    private sessionScope: AuthIdentityScope | null = null;
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
    private pendingJoinResolvers = new Set<(status: string) => void>();
    /** Invalidates overlapping create/join/leave operations. */
    private operationEpoch = 0;
    /** Invalidates callbacks, promises, and timers belonging to an old channel. */
    private connectionEpoch = 0;
    // Silence escalation. This replaces a single boolean (`rejoinedOnSilence`)
    // that was latched at 20s and re-armed ONLY by hearing the peer — and that
    // joinChannel never re-armed. So a rejoin which reconnected the channel but
    // did NOT restore data flow (lapsed Pi lease, rebooted Pi, auth refused on
    // a token refreshed offline) spent the one shot and left the watchdog
    // watching a dead link in silence for the rest of the night. That is the
    // "occasionally it will not reconnect" Shane reported: not the first
    // silence of the night, the second — or the first one a rejoin cannot fix.
    private silenceRejoins = 0;
    private silenceProbedPiAt = 0;
    private silenceAlertedAt = 0;

    constructor() {
        // authStore advances this fence synchronously before exposing another
        // account to React. Tear down cloud state in the same turn so account
        // B can never inherit account A's channel, timers, or session code.
        subscribeAuthIdentityScope(() => {
            this.operationEpoch++;
            this.resetRuntimeSession(true);
        });

        // Auto-reconnect when app returns to foreground
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && !this.connected && this.hasCurrentSession()) {
                    log.info('App foregrounded — attempting reconnect');
                    this.reconnectAttempts = 0; // Reset backoff on foreground
                    this.scheduleReconnect();
                }
            });
        }
        // Auto-reconnect when network is restored
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                if (!this.connected && this.hasCurrentSession()) {
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
        void Promise.resolve(
            App.addListener('appStateChange', ({ isActive }) => {
                if (isActive && !this.connected && this.hasCurrentSession()) {
                    log.info('App active (native) — attempting reconnect');
                    this.reconnectAttempts = 0;
                    this.scheduleReconnect();
                }
            }),
        ).catch(() => {
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
        // Defensive fail-closed check in case a caller reads state during an
        // unusual auth bootstrap before the synchronous subscriber runs.
        if (this.sessionScope && !isAuthIdentityScopeCurrent(this.sessionScope)) {
            return {
                connected: false,
                role: 'vessel',
                sessionCode: null,
                peerConnected: false,
                lastPeerUpdate: null,
                peerDisconnectedAt: null,
            };
        }
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
     * one-tap reconnect so the user never has to re-type the session code if
     * the connection ever drops and doesn't auto-recover.
     */
    getLastSessionCode(): string | null {
        if (this.hasCurrentSession()) return this.sessionCode;
        return this.readPersistedSession(getAuthIdentityScope())?.sessionCode ?? null;
    }

    /**
     * Restore a persisted sync session after app restart/crash.
     * Called during app initialization.
     * Returns true if a session was restored and reconnected.
     */
    async restoreSession(): Promise<boolean> {
        if (!isSupabaseConfigured() || !supabase) return false;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return false;

        // Idempotent: restore is now called both on app startup AND on
        // Anchor Watch page mount. If we're already live on a session,
        // there's nothing to do — don't tear down / re-join.
        if (this.connected && this.hasCurrentSession()) return true;

        const operationEpoch = ++this.operationEpoch;

        try {
            const persisted = this.readPersistedSession(scope, true);
            if (!persisted) return false;

            // Don't AUTO-rejoin a very old session, but KEEP the code so the
            // user can still one-tap reconnect manually from the UI.
            const ageMs = Date.now() - (persisted.savedAt || 0);
            if (ageMs > SESSION_TTL_MS) {
                return false;
            }

            // The local identity fence and the actual Supabase session must
            // agree before a private channel is restored.
            const { data: authData } = await supabase.auth.getUser();
            if (!this.isOperationCurrent(scope, operationEpoch) || authData.user?.id !== scope.userId) {
                return false;
            }

            this.installSession(scope, persisted.role, persisted.sessionCode);
            const joined = await this.joinChannel();
            if (!this.isOperationCurrent(scope, operationEpoch)) return false;
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
                void this.registerPushToken(persisted.sessionCode, scope);
            }

            return true;
        } catch {
            if (this.isOperationCurrent(scope, operationEpoch)) {
                this.resetRuntimeSession(true);
            }
            return false;
        }
    }

    /**
     * Create a new watch session as VESSEL device.
     * Returns the 12-character session code for the shore device to join.
     * Session is persisted so it survives app crashes.
     */
    async createSession(): Promise<string | null> {
        if (!isSupabaseConfigured() || !supabase) {
            return null;
        }
        const scope = getAuthIdentityScope();
        if (!scope.userId) return null;
        const operationEpoch = ++this.operationEpoch;

        const { data: authData } = await supabase.auth.getUser();
        if (!this.isOperationCurrent(scope, operationEpoch) || authData.user?.id !== scope.userId) {
            return null;
        }

        // A 60-bit code collision is extremely unlikely, but the database is
        // authoritative. Retry uniqueness conflicts instead of leaving the UI
        // with a mysteriously failed pairing attempt.
        let sessionCode: string | null = null;
        for (let attempt = 0; attempt < MAX_SESSION_CODE_ATTEMPTS; attempt++) {
            const candidate = generateSessionCode();
            const { error: sessionError } = await supabase.rpc('create_anchor_watch_session', {
                p_session_code: candidate,
            });
            if (!this.isOperationCurrent(scope, operationEpoch)) return null;
            if (!sessionError) {
                sessionCode = candidate;
                break;
            }
            if (!isDuplicateSessionCodeError(sessionError) || attempt === MAX_SESSION_CODE_ATTEMPTS - 1) {
                log.warn('createSession: secure session creation failed', sessionError.message);
                return null;
            }
        }
        if (!sessionCode) return null;

        this.installSession(scope, 'vessel', sessionCode);
        // Persist immediately after the server accepts the session. A
        // transient realtime failure can then recover via the normal backoff
        // instead of orphaning the server-side session.
        this.persistSession(scope);
        const joined = await this.joinChannel();
        if (!this.isOperationCurrent(scope, operationEpoch)) return null;
        if (!joined) log.warn('createSession: channel join deferred to reconnect backoff');
        return sessionCode;
    }

    /**
     * Join an existing watch session as SHORE device.
     * @param code The 12-character session code from the vessel device.
     * Session is persisted so it survives app crashes.
     */
    async joinSession(code: string): Promise<boolean> {
        if (!isSupabaseConfigured() || !supabase) {
            return false;
        }

        const normalizedCode = code.trim().toUpperCase();
        if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalizedCode)) {
            return false;
        }
        const scope = getAuthIdentityScope();
        if (!scope.userId) return false;
        const operationEpoch = ++this.operationEpoch;

        const { data: authData } = await supabase.auth.getUser();
        if (!this.isOperationCurrent(scope, operationEpoch) || authData.user?.id !== scope.userId) {
            return false;
        }

        const { data: sessionJoined, error: joinError } = await supabase.rpc('join_anchor_watch_session', {
            p_session_code: normalizedCode,
        });
        if (!this.isOperationCurrent(scope, operationEpoch) || joinError || !sessionJoined) return false;

        this.installSession(scope, 'shore', normalizedCode);
        this.persistSession(scope);
        const joined = await this.joinChannel();
        if (!this.isOperationCurrent(scope, operationEpoch)) return false;

        if (joined) {
            // Register push token for alarm notifications
            void this.registerPushToken(normalizedCode, scope);
        }

        return joined;
    }

    /** Leave the current session and clear persisted state */
    async leaveSession(): Promise<void> {
        const scope = this.sessionScope;
        const sessionCode = this.sessionCode;
        const role = this.role;
        if (!scope || !sessionCode || !isAuthIdentityScopeCurrent(scope)) return;

        // This is the linearization point for an explicit leave. Disconnect
        // synchronously before any network await so a later account cannot be
        // torn down by the completion of this account's request.
        ++this.operationEpoch;
        this.clearPersistedSession(scope);
        this.resetRuntimeSession(true);

        // Remove only the captured account's token. The explicit user_id
        // predicate makes the request harmless if Supabase's auth token
        // changes in the narrow window after the identity check.
        if (role !== 'shore' || !supabase) return;
        const token = PushNotificationService.getToken();
        if (!token || !isAuthIdentityScopeCurrent(scope)) return;
        try {
            const { data: authData } = await supabase.auth.getUser();
            if (!isAuthIdentityScopeCurrent(scope) || authData.user?.id !== scope.userId) return;
            await supabase
                .from('anchor_alarm_tokens')
                .delete()
                .eq('session_code', sessionCode)
                .eq('device_token', token)
                .eq('user_id', scope.userId);
        } catch {
            // Best effort — the session expires server-side after 24 hours.
        }
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
        if (!supabase || !this.sessionCode || this.role !== 'vessel' || !this.sessionScope) return;
        const scope = this.sessionScope;
        const sessionCode = this.sessionCode;
        if (!this.isSessionCurrent(scope, sessionCode, 'vessel')) return;

        try {
            const { data: authData } = await supabase.auth.getUser();
            if (!this.isSessionCurrent(scope, sessionCode, 'vessel') || authData.user?.id !== scope.userId) {
                return;
            }
            const { error } = await supabase.from('anchor_alarm_events').insert({
                session_code: sessionCode,
                user_id: scope.userId,
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
        if (
            !this.channel ||
            this.role !== 'vessel' ||
            !this.sessionScope ||
            !this.sessionCode ||
            !this.isSessionCurrent(this.sessionScope, this.sessionCode, 'vessel')
        ) {
            return;
        }
        const channel = this.channel;
        const scope = this.sessionScope;
        const sessionCode = this.sessionCode;
        const connectionEpoch = this.connectionEpoch;

        const payload = {
            ...data,
            type: 'position' as const,
            timestamp: Date.now(),
        };

        channel
            .send({
                type: 'broadcast',
                event: 'position',
                payload,
            })
            .then((_status: string) => {})
            .catch((_err) => {
                if (this.isConnectionCurrent(scope, sessionCode, 'vessel', connectionEpoch, channel)) {
                    log.warn(`[AnchorWatchSyncService]`, _err);
                }
            });
    }

    /** Broadcast alarm state change (called by vessel device) */
    broadcastAlarm(data: Omit<AlarmBroadcast, 'type' | 'timestamp'>): void {
        if (
            !this.channel ||
            this.role !== 'vessel' ||
            !this.sessionScope ||
            !this.sessionCode ||
            !this.isSessionCurrent(this.sessionScope, this.sessionCode, 'vessel')
        ) {
            return;
        }
        const channel = this.channel;
        const scope = this.sessionScope;
        const sessionCode = this.sessionCode;
        const connectionEpoch = this.connectionEpoch;

        void channel
            .send({
                type: 'broadcast',
                event: 'alarm',
                payload: {
                    ...data,
                    type: 'alarm' as const,
                    timestamp: Date.now(),
                },
            })
            .catch((error) => {
                if (this.isConnectionCurrent(scope, sessionCode, 'vessel', connectionEpoch, channel)) {
                    log.warn('broadcastAlarm failed', error);
                }
            });
    }

    /**
     * Check if there is a persisted session that can be restored.
     * Used by UI to show reconnection state.
     */
    hasPersistedSession(): boolean {
        const persisted = this.readPersistedSession(getAuthIdentityScope());
        if (!persisted) return false;
        const ageMs = Date.now() - (persisted.savedAt || 0);
        return ageMs < SESSION_TTL_MS;
    }

    /**
     * Get the persisted session info without restoring.
     */
    getPersistedSession(): PersistedSyncSession | null {
        return this.readPersistedSession(getAuthIdentityScope());
    }

    // ---- PRIVATE ----

    /**
     * Read only the current account's session namespace. The historic global
     * key is deliberately not adopted: it contains no trustworthy owner and
     * could otherwise reconnect account B to account A's private watch.
     */
    private readPersistedSession(scope: AuthIdentityScope, clearInvalid = false): PersistedSyncSession | null {
        if (!scope.userId) return null;
        const key = authScopedStorageKey(SYNC_SESSION_KEY, scope);
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const value = JSON.parse(raw) as Partial<PersistedSyncSession>;
            if (
                !isValidSessionCode(value.sessionCode) ||
                (value.role !== 'vessel' && value.role !== 'shore') ||
                value.userId !== scope.userId ||
                typeof value.savedAt !== 'number' ||
                !Number.isFinite(value.savedAt)
            ) {
                if (clearInvalid) localStorage.removeItem(key);
                return null;
            }
            return value as PersistedSyncSession;
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            if (clearInvalid) {
                try {
                    localStorage.removeItem(key);
                } catch {
                    // Storage is unavailable; treating it as empty is enough.
                }
            }
            return null;
        }
    }

    /** Persist current session to its immutable account namespace. */
    private persistSession(scope: AuthIdentityScope): void {
        if (!scope.userId || !this.sessionCode || !this.isSessionCurrent(scope, this.sessionCode, this.role)) {
            return;
        }
        try {
            const data: PersistedSyncSession = {
                sessionCode: this.sessionCode,
                role: this.role,
                userId: scope.userId,
                savedAt: Date.now(),
            };
            localStorage.setItem(authScopedStorageKey(SYNC_SESSION_KEY, scope), JSON.stringify(data));
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            // localStorage might fail in some contexts — realtime still works.
        }
    }

    /** Clear persisted session state for an explicit captured identity. */
    private clearPersistedSession(scope: AuthIdentityScope): void {
        if (!scope.userId) return;
        try {
            localStorage.removeItem(authScopedStorageKey(SYNC_SESSION_KEY, scope));
        } catch (e) {
            log.warn('[AnchorWatchSync]', e);
            // Non-critical
        }
    }

    private isOperationCurrent(scope: AuthIdentityScope, operationEpoch: number): boolean {
        return this.operationEpoch === operationEpoch && !!scope.userId && isAuthIdentityScopeCurrent(scope);
    }

    private hasCurrentSession(): boolean {
        return (
            !!this.sessionScope &&
            !!this.sessionCode &&
            this.isSessionCurrent(this.sessionScope, this.sessionCode, this.role)
        );
    }

    private isSessionCurrent(scope: AuthIdentityScope, sessionCode: string, role: SyncRole): boolean {
        return (
            !!scope.userId &&
            isAuthIdentityScopeCurrent(scope) &&
            this.sessionScope === scope &&
            this.sessionCode === sessionCode &&
            this.role === role
        );
    }

    private isConnectionCurrent(
        scope: AuthIdentityScope,
        sessionCode: string,
        role: SyncRole,
        connectionEpoch: number,
        channel: ReturnType<NonNullable<typeof supabase>['channel']>,
    ): boolean {
        return (
            this.connectionEpoch === connectionEpoch &&
            this.channel === channel &&
            this.isSessionCurrent(scope, sessionCode, role)
        );
    }

    /** Replace the active cloud session without touching either account's persisted copy. */
    private installSession(scope: AuthIdentityScope, role: SyncRole, sessionCode: string): void {
        this.resetRuntimeSession(false);
        this.sessionScope = scope;
        this.role = role;
        this.sessionCode = sessionCode;
    }

    /**
     * Synchronously invalidate all channel work. removeChannel itself is
     * asynchronous, but callbacks are already fenced out before it can settle.
     */
    private resetRuntimeSession(notify: boolean): void {
        this.connectionEpoch++;
        this.pendingJoinResolvers.forEach((resolve) => resolve('STALE'));
        this.pendingJoinResolvers.clear();
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.peerTimeoutInterval) clearInterval(this.peerTimeoutInterval);
        this.reconnectTimeout = null;
        this.heartbeatInterval = null;
        this.peerTimeoutInterval = null;
        this.reconnectAttempts = 0;
        this.silenceRejoins = 0;
        this.silenceProbedPiAt = 0;
        this.silenceAlertedAt = 0;

        const oldChannel = this.channel;
        this.channel = null;
        if (oldChannel && supabase) {
            try {
                void Promise.resolve(supabase.removeChannel(oldChannel)).catch(() => {});
            } catch {
                // The callback fences above already made this channel inert.
            }
        }

        this.sessionScope = null;
        this.role = 'vessel';
        this.sessionCode = null;
        this.connected = false;
        this.peerConnected = false;
        this.lastPeerUpdate = null;
        this.peerDisconnectedAt = null;
        if (notify) this.notifyState();
    }

    private async joinChannel(): Promise<boolean> {
        if (!supabase || !this.sessionCode || !this.sessionScope) return false;
        const scope = this.sessionScope;
        const sessionCode = this.sessionCode;
        const role = this.role;
        if (!this.isSessionCurrent(scope, sessionCode, role)) return false;

        try {
            const channelName = `anchor-watch-${sessionCode}`;

            // Tear down a prior connection synchronously while retaining the
            // immutable account/session identity used by reconnect.
            this.connectionEpoch++;
            this.pendingJoinResolvers.forEach((resolve) => resolve('STALE'));
            this.pendingJoinResolvers.clear();
            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            if (this.peerTimeoutInterval) clearInterval(this.peerTimeoutInterval);
            this.reconnectTimeout = null;
            this.heartbeatInterval = null;
            this.peerTimeoutInterval = null;
            const oldChannel = this.channel;
            this.channel = null;
            this.connected = false;
            if (oldChannel) {
                try {
                    void Promise.resolve(supabase.removeChannel(oldChannel)).catch(() => {});
                } catch {
                    /* callback fences already made the old channel inert */
                }
            }

            if (!this.isSessionCurrent(scope, sessionCode, role)) return false;
            const connectionEpoch = this.connectionEpoch;
            const channel = supabase.channel(channelName, {
                config: {
                    private: true,
                    broadcast: { self: false, ack: true },
                    presence: { key: role },
                },
            });
            this.channel = channel;

            // Listen for position broadcasts
            channel.on('broadcast', { event: 'position' }, ({ payload }: { payload: PositionBroadcast }) => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                this.lastPeerUpdate = Date.now();
                this.broadcastListeners.forEach((listener) => {
                    try {
                        listener(payload);
                    } catch {
                        // One UI listener must not starve the others.
                    }
                });
            });

            // Listen for alarm broadcasts
            channel.on('broadcast', { event: 'alarm' }, ({ payload }: { payload: AlarmBroadcast }) => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                this.lastPeerUpdate = Date.now();
                this.broadcastListeners.forEach((listener) => {
                    try {
                        listener(payload);
                    } catch {
                        // One UI listener must not starve the others.
                    }
                });
            });

            // Listen for heartbeats
            channel.on('broadcast', { event: 'heartbeat' }, () => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                this.lastPeerUpdate = Date.now();
                if (!this.peerConnected) {
                    this.peerConnected = true;
                    this.peerDisconnectedAt = null;
                    this.notifyState();
                }
            });

            // Track presence
            channel.on('presence', { event: 'join' }, ({ key }: { key: string }) => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                if (key !== role) {
                    this.peerConnected = true;
                    this.peerDisconnectedAt = null;
                    this.lastPeerUpdate = Date.now();
                    log.info('Peer joined:', key);
                    this.notifyState();
                }
            });

            channel.on('presence', { event: 'leave' }, ({ key }: { key: string }) => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                if (key !== role) {
                    this.peerConnected = false;
                    this.peerDisconnectedAt = Date.now();
                    log.info('Peer left:', key);
                    this.notifyState();
                }
            });

            // Subscribe to channel
            const status = await new Promise<string>((resolve) => {
                let settled = false;
                const finish = (nextStatus: string) => {
                    if (settled) return;
                    settled = true;
                    this.pendingJoinResolvers.delete(finish);
                    resolve(nextStatus);
                };
                this.pendingJoinResolvers.add(finish);
                channel.subscribe((nextStatus: string) => {
                    // Identity fence FIRST, on EVERY invocation. supabase-js
                    // keeps calling this for the life of the channel, so this
                    // is now a permanent health handler rather than a
                    // join-only one — and the fence is therefore tighter than
                    // before, not looser: a superseded channel used to be
                    // discarded by luck (the `settled` guard), now it is
                    // discarded by the identity check.
                    if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) {
                        finish('STALE');
                        return;
                    }
                    if (!settled) {
                        finish(nextStatus);
                        return;
                    }
                    // POST-JOIN. Every CHANNEL_ERROR / CLOSED / TIMED_OUT used
                    // to hit `if (settled) return` and vanish, leaving a dead
                    // channel looking connected forever.
                    if (nextStatus !== 'SUBSCRIBED') {
                        this.reconnectAttempts = 0; // first death of an episode — recover fast
                        this.handleConnectionLost(`channel_${nextStatus.toLowerCase()}`);
                    }
                });
            });

            if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return false;
            if (status !== 'SUBSCRIBED') {
                // If subscription failed and we have a persisted session, try reconnecting
                this.scheduleReconnect();
                return false;
            }

            // Track our presence. Race this network promise against the same
            // synchronous invalidator used by subscription so an auth switch
            // cannot leave create/join hanging forever.
            const trackStatus = await new Promise<'TRACKED' | 'ERROR' | 'STALE'>((resolve) => {
                let settled = false;
                const finish = (nextStatus: 'TRACKED' | 'ERROR' | 'STALE') => {
                    if (settled) return;
                    settled = true;
                    this.pendingJoinResolvers.delete(invalidate);
                    resolve(nextStatus);
                };
                const invalidate = () => finish('STALE');
                this.pendingJoinResolvers.add(invalidate);
                try {
                    void Promise.resolve(channel.track({ role, joinedAt: Date.now() })).then(
                        () => finish('TRACKED'),
                        () => finish('ERROR'),
                    );
                } catch {
                    finish('ERROR');
                }
            });
            if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return false;
            if (trackStatus !== 'TRACKED') {
                this.scheduleReconnect();
                return false;
            }

            this.connected = true;
            this.reconnectAttempts = 0;
            // A fresh channel gets a fresh silence budget. And `=== null`
            // deliberately: a rejoin must not reset a genuinely stale
            // lastPeerUpdate, or the escalation above would be reset by its
            // own recovery attempt and could never climb. Seeding it at all
            // matters because joinSession/createSession never did — so
            // `if (!this.lastPeerUpdate) return` disarmed the ONLY safety net
            // for a watch armed before the boat starts reporting.
            this.silenceRejoins = 0;
            this.silenceProbedPiAt = 0;
            this.silenceAlertedAt = 0;
            if (this.lastPeerUpdate === null) this.lastPeerUpdate = Date.now();
            this.reconnectAttempts = 0; // Reset on successful connection

            // Start heartbeat (every 10s)
            this.heartbeatInterval = setInterval(() => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                void channel
                    .send({
                        type: 'broadcast',
                        event: 'heartbeat',
                        payload: { role, timestamp: Date.now() },
                    })
                    .catch(() => {
                        // Peer-timeout/reconnect logic handles a dead socket.
                    });
            }, 10000);

            // Monitor peer liveness. Heartbeats arrive every 10s, so silence
            // means trouble. Two thresholds:
            //   • 20s, doubling to 5 min → force a rejoin. Prolonged silence usually
            //     means OUR socket died (a WiFi→cell handoff leaves it
            //     half-open: the peer's heartbeats stop arriving while
            //     `connected` stays stale-true, and neither `online` nor a
            //     foreground event fires mid-walk). Rejoining over the new
            //     interface re-establishes; harmless if the peer is truly
            //     gone (we just re-subscribe and wait). Kicking in before the
            //     30s UI-disconnect makes a quick handoff often seamless.
            //   • 30s → flag the peer disconnected in the UI.
            this.peerTimeoutInterval = setInterval(() => {
                if (!this.isConnectionCurrent(scope, sessionCode, role, connectionEpoch, channel)) return;
                const silentMs = this.lastPeerUpdate ? Date.now() - this.lastPeerUpdate : 0;
                if (!this.lastPeerUpdate) return;

                // Hearing the peer is the ONLY thing that ends an episode.
                if (silentMs < 20000) {
                    this.silenceRejoins = 0;
                    this.silenceProbedPiAt = 0;
                    this.silenceAlertedAt = 0;
                    if (this.peerDisconnectedAt !== null) {
                        this.peerDisconnectedAt = null;
                        this.notifyState();
                    }
                    return;
                }

                // ── 20s, then 40s, 80s… capped at 5 min: force a rejoin.
                //    Never gives up and never hammers — the budget grows
                //    faster than the attempts. The old code allowed exactly
                //    ONE per episode and joinChannel never re-armed it, so a
                //    rejoin that reconnected the channel without restoring
                //    data flow spent the only shot there was.
                const budgetMs = Math.min(20000 * Math.pow(2, this.silenceRejoins), 300000);
                if (silentMs > budgetMs && !this.reconnectTimeout) {
                    this.silenceRejoins++;
                    this.handleConnectionLost(
                        `peer_silent_${Math.round(silentMs / 1000)}s_rejoin_${this.silenceRejoins}`,
                    );
                }

                // ── 30s: show the vessel as lost. The old gate was
                //    `&& this.peerConnected`, which is DEAD CODE for a Pi-kept
                //    watch: the Pi never joins Realtime, so presence never
                //    sets peerConnected true and this could never fire for
                //    exactly the setup Shane runs.
                if (silentMs > 30000 && this.peerDisconnectedAt === null) {
                    this.peerConnected = false;
                    this.peerDisconnectedAt = Date.now();
                    log.warn(`anchor sync peer silent ${Math.round(silentMs / 1000)}s — vessel not reporting`);
                    this.notifyState();
                }

                // ── 2 min: rejoining a channel nobody publishes to fixes
                //    nothing. Re-probe the Pi — re-authorise its six-hour
                //    lease and re-assign the watch. The only step that
                //    repairs a lapsed lease or a rebooted Pi.
                if (silentMs > 120000 && Date.now() - this.silenceProbedPiAt > 300000) {
                    this.silenceProbedPiAt = Date.now();
                    void this.reprobeVesselKeeper(Math.round(silentMs / 1000));
                }

                // ── 10 min: a shore watch blind this long is not a glitch.
                if (silentMs > 600000 && this.silenceAlertedAt === 0) {
                    this.silenceAlertedAt = Date.now();
                    log.warn(`anchor sync SHORE WATCH BLIND for ${Math.round(silentMs / 60000)}m`);
                }
            }, 5000);

            this.notifyState();
            return true;
        } catch {
            // On connection error, schedule reconnect if we have persisted session
            if (this.isSessionCurrent(scope, sessionCode, role)) this.scheduleReconnect();
            return false;
        }
    }

    /**
     * Schedule automatic reconnection with exponential backoff.
     * Only reconnects if there's a persisted session to restore.
     */
    /**
     * The link is dead. Say so out loud, clear the flag that gates every
     * recovery path, and start over.
     *
     * `connected` stale-true is what disabled foregrounding, the 'online'
     * event, appStateChange, restoreSession and the backoff timer's own body
     * all at once — five recovery routes, each independently vetoed by one
     * boolean nothing was clearing. Nothing may clear it on a death but here.
     */
    private handleConnectionLost(reason: string): void {
        if (!this.connected && this.reconnectTimeout) return; // already recovering
        // log.warn, never log.info: createLogger compiles info() out of
        // production iOS builds, and this is the line that diagnoses a bad
        // night from the deck.
        log.warn(`anchor sync link lost (reason=${reason}) — reconnecting`);
        this.connected = false;
        this.notifyState();
        this.scheduleReconnect();
    }

    /**
     * Ask the Pi to take the watch again.
     *
     * Rejoining a channel nobody is publishing to cannot fix a lapsed lease or
     * a Pi that rebooted, and those are the silences a reconnect ladder cannot
     * climb out of. Dynamically imported to avoid a module cycle: the keeper
     * imports this service's types.
     */
    private async reprobeVesselKeeper(silentSeconds: number): Promise<void> {
        try {
            const { AnchorPiWatchKeeper } = await import('./anchorPiWatchKeeper');
            if (!AnchorPiWatchKeeper.isKeeping()) {
                log.warn(`anchor sync silent ${silentSeconds}s — no Pi watch to re-probe from this device`);
                return;
            }
            const renewed = await AnchorPiWatchKeeper.renewNow();
            log.warn(`anchor sync silent ${silentSeconds}s — Pi watch re-probe ${renewed ? 'renewed' : 'FAILED'}`);
        } catch (e) {
            log.warn('anchor sync Pi re-probe threw', e);
        }
    }

    private scheduleReconnect(): void {
        if (!this.sessionCode || !this.sessionScope) return;
        const scope = this.sessionScope;
        const sessionCode = this.sessionCode;
        const role = this.role;
        if (!this.isSessionCurrent(scope, sessionCode, role)) return;
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
            this.reconnectTimeout = null;
            if (!this.connected && this.isSessionCurrent(scope, sessionCode, role)) {
                await this.joinChannel();
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
    private async registerPushToken(sessionCode: string, scope: AuthIdentityScope): Promise<void> {
        if (!supabase || !this.isSessionCurrent(scope, sessionCode, 'shore')) return;

        try {
            // Request permission and get token
            const token = await PushNotificationService.requestPermissionAndRegister();
            if (!token || !this.isSessionCurrent(scope, sessionCode, 'shore')) {
                return;
            }

            // Register token to Supabase
            const { data: authData } = await supabase.auth.getUser();
            if (!this.isSessionCurrent(scope, sessionCode, 'shore') || authData.user?.id !== scope.userId) {
                return;
            }

            const { error } = await supabase.from('anchor_alarm_tokens').upsert(
                {
                    session_code: sessionCode,
                    user_id: scope.userId,
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
