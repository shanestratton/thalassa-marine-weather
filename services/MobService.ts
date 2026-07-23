/**
 * MobService — Man Overboard tracker.
 *
 * Snapshots vessel position at the moment MOB is activated, then keeps a
 * live bearing/distance back to that position as the vessel moves. Persists
 * across app restarts so an accidental swipe-close doesn't drop the fix.
 *
 * Pairs with the DSC panel in RadioConsolePage — an active MOB pre-fills the
 * Mayday transcript with nature = "Man Overboard" and the original fix.
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Preferences } from '@capacitor/preferences';
import { GpsService, type GpsPosition } from './GpsService';
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

const log = createLogger('MOB');

const STORAGE_KEY = 'thalassa_mob_active_v1';
const STORAGE_VERSION = 2;

export interface MobSnapshot {
    /** Position where MOB was marked. */
    fixLat: number;
    fixLon: number;
    /** Epoch ms when MOB was activated. */
    activatedAt: number;
    /** Source of the initial fix. */
    fixAccuracy: number | null;
}

export interface MobState {
    active: MobSnapshot | null;
    /** Live own-vessel position, if known. */
    own: GpsPosition | null;
    /** Metres from own position back to the MOB fix. */
    distanceMeters: number | null;
    /** True bearing (degrees) from own position to MOB fix. */
    bearingDeg: number | null;
    /** Seconds since MOB was activated. */
    elapsedSec: number;
}

type Subscriber = (state: MobState) => void;

interface PersistedMobSnapshot {
    version: typeof STORAGE_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    snapshot: MobSnapshot;
}

// ── Great-circle math (haversine) ────────────────────────────────────────────
const EARTH_M = 6371008.8; // WGS-84 mean radius in metres

function toRad(d: number): number {
    return (d * Math.PI) / 180;
}
function toDeg(r: number): number {
    return (r * 180) / Math.PI;
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function isValidSnapshot(value: unknown): value is MobSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<MobSnapshot>;
    return (
        typeof snapshot.fixLat === 'number' &&
        Number.isFinite(snapshot.fixLat) &&
        snapshot.fixLat >= -90 &&
        snapshot.fixLat <= 90 &&
        typeof snapshot.fixLon === 'number' &&
        Number.isFinite(snapshot.fixLon) &&
        snapshot.fixLon >= -180 &&
        snapshot.fixLon <= 180 &&
        typeof snapshot.activatedAt === 'number' &&
        Number.isFinite(snapshot.activatedAt) &&
        snapshot.activatedAt > 0 &&
        (snapshot.fixAccuracy === null ||
            (typeof snapshot.fixAccuracy === 'number' &&
                Number.isFinite(snapshot.fixAccuracy) &&
                snapshot.fixAccuracy >= 0))
    );
}

function isValidPersistedSnapshot(value: unknown, scope: AuthIdentityScope): value is PersistedMobSnapshot {
    if (!value || typeof value !== 'object') return false;
    const persisted = value as Partial<PersistedMobSnapshot>;
    return (
        persisted.version === STORAGE_VERSION &&
        persisted.ownerKey === scope.key &&
        persisted.ownerUserId === scope.userId &&
        isValidSnapshot(persisted.snapshot)
    );
}

class MobServiceClass {
    private snapshot: MobSnapshot | null = null;
    /**
     * Stable owner of the physical emergency. This deliberately survives an
     * auth transition: changing accounts must neither disarm a live MOB nor
     * expose its fix to the newly active account.
     */
    private snapshotOwnerKey: string | null = null;
    private snapshotOwnerUserId: string | null = null;
    private own: GpsPosition | null = null;
    private tickerId: ReturnType<typeof setInterval> | null = null;
    private gpsUnsub: (() => void) | null = null;
    private hapticTimeouts = new Set<ReturnType<typeof setTimeout>>();
    private subs = new Set<Subscriber>();
    private hydratedScopeKeys = new Set<string>();
    private hydrationPromises = new Map<number, Promise<void>>();
    private storageChains = new Map<string, Promise<void>>();

    constructor() {
        subscribeAuthIdentityScope((next) => {
            // Hide/reveal synchronously before any account-specific async work.
            this.emit();
            if (!this.snapshot) {
                void this.hydrate(next);
            }
        });
    }

    /** Load the current account's persisted MOB on first access. Idempotent. */
    async hydrate(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (this.isOwnedBy(scope) || this.snapshot || this.hydratedScopeKeys.has(scope.key)) return;

        const existing = this.hydrationPromises.get(scope.generation);
        if (existing) return existing;

        const hydration = this.hydrateForScope(scope);
        this.hydrationPromises.set(scope.generation, hydration);
        try {
            await hydration;
        } finally {
            if (this.hydrationPromises.get(scope.generation) === hydration) {
                this.hydrationPromises.delete(scope.generation);
            }
        }
    }

    /**
     * Mark Man Overboard at the most recent GPS fix. Triggers haptics,
     * wakes the screen, and starts live bearing/distance tracking.
     * Returns the snapshot, or null if no GPS fix was obtainable.
     */
    async activate(): Promise<MobSnapshot | null> {
        const operationScope = getAuthIdentityScope();
        await this.hydrate(operationScope);
        if (!isAuthIdentityScopeCurrent(operationScope)) return null;
        if (this.snapshot) {
            // Never hand another account the active emergency fix.
            return this.isOwnedBy(operationScope) ? { ...this.snapshot } : null;
        }

        const pos = await GpsService.getCurrentPosition({ staleLimitMs: 15_000, timeoutSec: 6 });
        if (!isAuthIdentityScopeCurrent(operationScope)) {
            log.warn('Discarded stale MOB activation after identity changed');
            return null;
        }
        // Another activation may have won while GPS was pending.
        const activeSnapshot = this.getPhysicalSnapshot();
        if (activeSnapshot) {
            return this.isOwnedBy(operationScope) ? { ...activeSnapshot } : null;
        }
        if (!pos) {
            log.error('Cannot activate MOB — no GPS fix available');
            return null;
        }

        const snap: MobSnapshot = {
            fixLat: pos.latitude,
            fixLon: pos.longitude,
            fixAccuracy: pos.accuracy ?? null,
            activatedAt: Date.now(),
        };
        if (!isValidSnapshot(snap)) {
            log.error('Cannot activate MOB — GPS returned an invalid fix');
            return null;
        }

        this.snapshot = snap;
        this.snapshotOwnerKey = operationScope.key;
        this.snapshotOwnerUserId = operationScope.userId;
        this.hydratedScopeKeys.add(operationScope.key);
        this.startLiveTracking();
        this.emit();

        // Persistence must never delay the immediate physical alarm path.
        const persistPromise = this.persist(snap, operationScope);

        // Strong triple-buzz to distinguish from normal taps
        const hapticPromise = (async () => {
            if (this.snapshot !== snap) return;
            try {
                await Haptics.impact({ style: ImpactStyle.Heavy });
                if (this.snapshot === snap) {
                    this.scheduleHaptic(snap, 180);
                    this.scheduleHaptic(snap, 360);
                }
            } catch {
                /* haptics unavailable on web */
            }
        })();

        const wakePromise = (async () => {
            if (this.snapshot !== snap) return;
            try {
                await KeepAwake.keepAwake();
            } catch {
                /* keep-awake not available */
            }
        })();

        await Promise.all([persistPromise, hapticPromise, wakePromise]);
        log.info('MOB ACTIVATED', snap);
        return { ...snap };
    }

    /** Cancel the active MOB. Releases wake-lock and clears tracking. */
    async clear(): Promise<void> {
        const operationScope = getAuthIdentityScope();
        if (!this.snapshot || !this.isOwnedBy(operationScope)) return;

        log.info('MOB cleared');
        this.snapshot = null;
        this.snapshotOwnerKey = null;
        this.snapshotOwnerUserId = null;
        this.own = null;
        this.clearScheduledHaptics();
        this.stopLiveTracking();
        this.emit();

        const removePromise = this.removePersisted(operationScope);
        try {
            await KeepAwake.allowSleep();
        } catch {
            /* noop */
        }
        await removePromise;

        // A new emergency may have armed while native sleep/storage calls were
        // pending. Restore the wake lock instead of letting the stale clear win.
        if (this.snapshot) {
            try {
                await KeepAwake.keepAwake();
            } catch {
                /* keep-awake not available */
            }
        }
    }

    /** Subscribe to state changes. Returns unsubscribe. */
    subscribe(cb: Subscriber): () => void {
        this.subs.add(cb);
        // Emit current state immediately so consumers render without a tick delay
        cb(this.currentState());
        // Kick off hydration without blocking the caller
        this.hydrate().catch(() => {});
        return () => this.subs.delete(cb);
    }

    /** Snapshot of the current MOB state (pure read). */
    currentState(): MobState {
        const currentScope = getAuthIdentityScope();
        const visible = this.isOwnedBy(currentScope);
        const snap = visible ? this.snapshot : null;
        const own = visible ? this.own : null;
        const elapsedSec = snap ? Math.max(0, Math.floor((Date.now() - snap.activatedAt) / 1000)) : 0;
        let distance: number | null = null;
        let bearing: number | null = null;
        if (snap && own) {
            distance = distanceMeters(own.latitude, own.longitude, snap.fixLat, snap.fixLon);
            bearing = bearingDeg(own.latitude, own.longitude, snap.fixLat, snap.fixLon);
        }
        return {
            active: snap ? { ...snap } : null,
            own: own ? { ...own } : null,
            distanceMeters: distance,
            bearingDeg: bearing,
            elapsedSec,
        };
    }

    isActive(): boolean {
        return this.snapshot !== null && this.isOwnedBy(getAuthIdentityScope());
    }

    // ── Internals ────────────────────────────────────────────────────────────
    /**
     * Read through a method so TypeScript does not retain the pre-await null
     * narrowing; another activation can legitimately win while GPS is pending.
     */
    private getPhysicalSnapshot(): MobSnapshot | null {
        return this.snapshot;
    }

    private startLiveTracking(): void {
        if (this.gpsUnsub) return;
        this.gpsUnsub = GpsService.watchPosition((pos) => {
            this.own = { ...pos };
            this.emit();
        });
        // Keep elapsed-time ticker so the UI clock moves even when GPS is silent
        if (!this.tickerId) {
            this.tickerId = setInterval(() => this.emit(), 1000);
        }
    }

    private stopLiveTracking(): void {
        if (this.gpsUnsub) {
            this.gpsUnsub();
            this.gpsUnsub = null;
        }
        if (this.tickerId) {
            clearInterval(this.tickerId);
            this.tickerId = null;
        }
    }

    private isOwnedBy(scope: AuthIdentityScope): boolean {
        return (
            this.snapshot !== null && this.snapshotOwnerKey === scope.key && this.snapshotOwnerUserId === scope.userId
        );
    }

    private async hydrateForScope(scope: AuthIdentityScope): Promise<void> {
        const storageKey = authScopedStorageKey(STORAGE_KEY, scope);
        try {
            const { value } = await Preferences.get({ key: storageKey });
            if (!isAuthIdentityScopeCurrent(scope) || this.snapshot) return;
            if (!value) {
                this.hydratedScopeKeys.add(scope.key);
                return;
            }

            const parsed: unknown = JSON.parse(value);
            if (!isValidPersistedSnapshot(parsed, scope)) {
                // The old global record is intentionally not consulted:
                // unattributed emergency coordinates cannot be adopted safely.
                await this.removePersisted(scope);
                if (isAuthIdentityScopeCurrent(scope)) this.hydratedScopeKeys.add(scope.key);
                return;
            }
            if (!isAuthIdentityScopeCurrent(scope) || this.snapshot) return;

            this.snapshot = { ...parsed.snapshot };
            this.snapshotOwnerKey = scope.key;
            this.snapshotOwnerUserId = scope.userId;
            this.hydratedScopeKeys.add(scope.key);
            this.startLiveTracking();
            this.emit();
            log.info('Hydrated active MOB from scoped storage');
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) {
                log.warn('hydrate failed', e);
            }
        }
    }

    private async persist(snap: MobSnapshot, scope: AuthIdentityScope): Promise<void> {
        const persisted: PersistedMobSnapshot = {
            version: STORAGE_VERSION,
            ownerKey: scope.key,
            ownerUserId: scope.userId,
            snapshot: { ...snap },
        };
        await this.enqueueStorage(scope, async () => {
            try {
                await Preferences.set({
                    key: authScopedStorageKey(STORAGE_KEY, scope),
                    value: JSON.stringify(persisted),
                });
            } catch (e) {
                log.warn('failed to persist MOB', e);
            }
        });
    }

    private async removePersisted(scope: AuthIdentityScope): Promise<void> {
        await this.enqueueStorage(scope, async () => {
            try {
                await Preferences.remove({ key: authScopedStorageKey(STORAGE_KEY, scope) });
            } catch (e) {
                log.warn('failed to clear storage', e);
            }
        });
    }

    /**
     * Capacitor Preferences has no transaction API. Per-owner serialization
     * prevents a slow activation write from resurrecting a later clear.
     */
    private enqueueStorage(scope: AuthIdentityScope, operation: () => Promise<void>): Promise<void> {
        const previous = this.storageChains.get(scope.key) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.storageChains.set(scope.key, next);
        const cleanup = () => {
            if (this.storageChains.get(scope.key) === next) {
                this.storageChains.delete(scope.key);
            }
        };
        void next.then(cleanup, cleanup);
        return next;
    }

    private scheduleHaptic(snap: MobSnapshot, delayMs: number): void {
        const timeout = setTimeout(() => {
            this.hapticTimeouts.delete(timeout);
            if (this.snapshot !== snap) return;
            void Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
        }, delayMs);
        this.hapticTimeouts.add(timeout);
    }

    private clearScheduledHaptics(): void {
        for (const timeout of this.hapticTimeouts) clearTimeout(timeout);
        this.hapticTimeouts.clear();
    }

    private emit(): void {
        const state = this.currentState();
        for (const sub of this.subs) {
            try {
                sub({
                    ...state,
                    active: state.active ? { ...state.active } : null,
                    own: state.own ? { ...state.own } : null,
                });
            } catch (e) {
                log.warn('subscriber threw', e);
            }
        }
    }
}

export const MobService = new MobServiceClass();
