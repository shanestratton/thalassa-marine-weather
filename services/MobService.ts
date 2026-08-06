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
import { calculateDistance, calculateBearing } from '../utils/navigationCalculations';
import { setLiveMobSafetyState } from './activeSafetyInterlock';
import { getCachedOwnshipPosition } from './ownshipPosition';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

const log = createLogger('MOB');

const STORAGE_KEY = 'thalassa_mob_active_v1';
const STORAGE_VERSION = 2;
/** Recovery vectors must never be calculated from an own-ship fix older than this. */
export const MOB_OWN_POSITION_STALE_MS = 15_000;
/** Marks at or below this uncertainty are treated as precise recovery fixes. */
export const MOB_PRECISE_FIX_ACCURACY_M = 100;
/** Backward-compatible name retained for consumers; this is a quality
 * threshold, no longer an activation refusal threshold. */
export const MOB_MAX_ACTIVATION_ACCURACY_M = MOB_PRECISE_FIX_ACCURACY_M;
/** A later GPS observation may refine an approximate mark only briefly after
 * activation. After this window, own-ship movement must never drag the datum. */
export const MOB_FIX_REFINEMENT_WINDOW_MS = 30_000;
/** Refinement may tighten an approximate circle only while the receiver proves
 * the boat has barely moved. Otherwise a later high-accuracy own-ship fix can
 * drag the casualty datum down-track and falsely label it precise. */
export const MOB_FIX_REFINEMENT_MAX_SPEED_MPS = 0.5;
export const MOB_FIX_REFINEMENT_MAX_DISPLACEMENT_M = 15;
/** How stale a cached fix may be and still be worth marking INSTANTLY.
 *  Generous on purpose: at 6 kt a 90 s old fix is ~280 m out, which is poor —
 *  but it is a starting datum and a search area, where the alternative is a
 *  spinner and possibly nothing at all. refineApproximateFix tightens it
 *  within seconds whenever the boat is near-stationary. */
export const MOB_INSTANT_MARK_MAX_AGE_MS = 90_000;
/** Assumed receiver uncertainty for a cached mark, before drift is added.
 *  A phone fix is typically better than this; claiming better than we can
 *  prove would paint a false pinpoint on a casualty datum. */
export const MOB_CACHED_FIX_BASE_ACCURACY_M = 30;

export interface MobSnapshot {
    /** Position where MOB was marked. */
    fixLat: number;
    fixLon: number;
    /** Epoch ms when MOB was activated. */
    activatedAt: number;
    /** Source of the initial fix. */
    fixAccuracy: number;
}

export type MobPersistenceStatus = 'idle' | 'pending' | 'confirmed' | 'failed';

export interface MobState {
    active: MobSnapshot | null;
    /** Most recent own-vessel position, if known; inspect freshness before use. */
    own: GpsPosition | null;
    /** Metres from own position back to the MOB fix. */
    distanceMeters: number | null;
    /** True bearing (degrees) from own position to MOB fix. */
    bearingDeg: number | null;
    /** Age of the retained own-ship fix, or null when no valid fix is known. */
    ownPositionAgeMs: number | null;
    /** Whether distance/bearing are based on an in-bound own-ship fix. */
    ownPositionFresh: boolean;
    /** Seconds since MOB was activated. */
    elapsedSec: number;
    /** Whether the casualty datum is precise or an uncertainty/search area. */
    fixQuality: 'precise' | 'approximate' | null;
    /** Whether restart recovery of the active physical emergency is durable. */
    persistenceStatus: MobPersistenceStatus;
}

type Subscriber = (state: MobState) => void;

interface PersistedMobSnapshot {
    version: typeof STORAGE_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    snapshot: MobSnapshot;
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
        typeof snapshot.fixAccuracy === 'number' &&
        Number.isFinite(snapshot.fixAccuracy) &&
        snapshot.fixAccuracy >= 0
    );
}

function isValidPersistedSnapshot(value: unknown): value is PersistedMobSnapshot {
    if (!value || typeof value !== 'object') return false;
    const persisted = value as Partial<PersistedMobSnapshot>;
    const expectedOwnerKey = persisted.ownerUserId ? `user:${persisted.ownerUserId}` : 'anonymous';
    return (
        persisted.version === STORAGE_VERSION &&
        typeof persisted.ownerKey === 'string' &&
        persisted.ownerKey === expectedOwnerKey &&
        (persisted.ownerUserId === null ||
            (typeof persisted.ownerUserId === 'string' && persisted.ownerUserId.trim().length > 0)) &&
        isValidSnapshot(persisted.snapshot)
    );
}

class MobServiceClass {
    private snapshot: MobSnapshot | null = null;
    /**
     * Originating identity is retained only as provenance/migration metadata.
     * The active emergency itself is device-authoritative: logout/session loss
     * must never hide the casualty fix or make Clear impossible.
     */
    private snapshotOwnerKey: string | null = null;
    private snapshotOwnerUserId: string | null = null;
    private own: GpsPosition | null = null;
    private persistenceStatus: MobPersistenceStatus = 'idle';
    private tickerId: ReturnType<typeof setInterval> | null = null;
    private gpsUnsub: (() => void) | null = null;
    private hapticTimeouts = new Set<ReturnType<typeof setTimeout>>();
    private subs = new Set<Subscriber>();
    private hydratedScopeKeys = new Set<string>();
    private hydrationPromises = new Map<number, Promise<void>>();
    private storageChains = new Map<string, Promise<void>>();

    constructor() {
        subscribeAuthIdentityScope((next) => {
            // A physical MOB remains visible across identity transitions. Emit
            // so subscribers can re-render, then look for a legacy scoped record
            // only when no device emergency is already active.
            this.emit();
            if (!this.snapshot) {
                void this.hydrate(next);
            }
        });
    }

    /** Load the device's persisted MOB on first access. Legacy account-scoped
     * records are migrated only from the scope that originally created them. */
    async hydrate(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
        if (this.snapshot || this.hydratedScopeKeys.has(scope.key)) return;

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
        if (this.snapshot) {
            return { ...this.snapshot };
        }

        // ── MARK NOW, REFINE AFTER (Shane 2026-08-07) ──
        // This used to await a fresh fix: staleLimitMs 15 s, timeoutSec 6. On a
        // cold receiver that is a six-second stare at the screen, and if
        // nothing lands, MOB returns NOTHING.
        //
        // For a man-overboard mark, waiting makes the answer worse rather than
        // better. The boat keeps moving away from the incident while the fix
        // resolves — at 6 kt those six seconds are ~18 m of error ADDED to the
        // casualty's drift. A position from a few seconds ago is closer to
        // where the person actually went in than a perfect fix taken later.
        //
        // So: take the best position already held and mark instantly. The
        // refinement path (refineApproximateFix, fed by the live watch started
        // below) then tightens it — but only while the receiver proves the boat
        // has barely moved, which is exactly the case where refining is safe.
        const cached = getCachedOwnshipPosition({ maxGpsAgeMs: MOB_INSTANT_MARK_MAX_AGE_MS });
        let pos: GpsPosition | null = null;
        if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
            // OwnshipPosition carries no accuracy, and isValidSnapshot demands
            // a finite one — so ESTIMATE it rather than invent a constant. For
            // a cached mark the dominant error is not receiver noise, it is how
            // far the boat travelled since that fix. Base uncertainty plus
            // drift is both honest and self-correcting: a one-second-old fix on
            // a stationary boat stays inside MOB_PRECISE_FIX_ACCURACY_M and is
            // shown as precise, while a stale fix at speed correctly presents
            // as a wide, approximate circle instead of a false pinpoint.
            const ageMs = Math.max(0, Date.now() - cached.timestamp);
            const sogMps = Math.max(0, cached.sog ?? 0) * 0.514444;
            const driftM = sogMps * (ageMs / 1000);
            pos = {
                latitude: cached.lat,
                longitude: cached.lon,
                accuracy: MOB_CACHED_FIX_BASE_ACCURACY_M + driftM,
                timestamp: cached.timestamp,
                speed: sogMps,
                heading: null,
                altitude: null,
            };
        }

        // SECOND SOURCE: the last fix any live watcher saw.
        //
        // getCachedOwnshipPosition reads NMEA and LocationStore, and
        // LocationStore is written by explicit user actions rather than by the
        // GPS stream — so on a phone with no NMEA it is usually EMPTY at the
        // moment of need, and MOB fell straight through to the blocking
        // acquisition. That is the 8 seconds (Shane 2026-08-07), even with the
        // instant-mark path in place: it had nothing to be instant with.
        //
        // The chart's location dot, vessel tracker and status button all hold
        // a live subscription, so a current fix has almost always just passed
        // through GpsService — it simply was not kept. Reading it costs
        // nothing and no extra battery.
        if (!pos) {
            const lastKnown = GpsService.getLastKnownPosition();
            const ageMs = lastKnown ? Date.now() - lastKnown.timestamp : Number.POSITIVE_INFINITY;
            if (lastKnown && ageMs <= MOB_INSTANT_MARK_MAX_AGE_MS) {
                log.warn(`MOB: marking from the last live fix (${Math.round(ageMs / 1000)}s old)`);
                pos = {
                    ...lastKnown,
                    // Widen for drift the same way the cached path does — a
                    // held fix is no more precise than its age allows.
                    accuracy: Math.max(
                        lastKnown.accuracy ?? MOB_CACHED_FIX_BASE_ACCURACY_M,
                        Math.max(0, lastKnown.speed ?? 0) * (ageMs / 1000),
                    ),
                };
            }
        }

        // Only pay the wait when there is genuinely nothing to mark at all.
        // This is the cold-start case the launch warm-up exists to shrink.
        if (!pos) {
            log.warn('MOB: no cached or live fix — falling back to a blocking acquisition');
            pos = await GpsService.getCurrentPosition({ staleLimitMs: 15_000, timeoutSec: 6 });
        }

        // Another activation may have won while GPS was pending.
        const activeSnapshot = this.getPhysicalSnapshot();
        if (activeSnapshot) {
            return { ...activeSnapshot };
        }
        if (!pos) {
            log.error('Cannot activate MOB — no GPS fix available');
            return null;
        }
        const snap: MobSnapshot = {
            fixLat: pos.latitude,
            fixLon: pos.longitude,
            fixAccuracy: pos.accuracy,
            activatedAt: Date.now(),
        };
        if (!isValidSnapshot(snap)) {
            log.error('Cannot activate MOB — GPS returned an invalid fix');
            return null;
        }

        this.snapshot = snap;
        this.snapshotOwnerKey = operationScope.key;
        this.snapshotOwnerUserId = operationScope.userId;
        this.persistenceStatus = 'pending';
        this.hydratedScopeKeys.add(operationScope.key);
        this.startLiveTracking();
        this.emit();

        // Persistence must never delay the immediate physical alarm path.
        const persistPromise = this.persist(snap).then(
            () => {
                if (this.snapshot === snap) {
                    this.persistenceStatus = 'confirmed';
                    this.emit();
                }
            },
            (error: unknown) => {
                if (this.snapshot === snap) {
                    this.persistenceStatus = 'failed';
                    this.emit();
                }
                log.error('MOB is active but restart recovery could not be persisted', error);
            },
        );

        // Strong triple-buzz to distinguish from normal taps
        const activationId = snap.activatedAt;
        const hapticPromise = (async () => {
            if (this.snapshot?.activatedAt !== activationId) return;
            try {
                await Haptics.impact({ style: ImpactStyle.Heavy });
                if (this.snapshot?.activatedAt === activationId) {
                    this.scheduleHaptic(activationId, 180);
                    this.scheduleHaptic(activationId, 360);
                }
            } catch {
                /* haptics unavailable on web */
            }
        })();

        const wakePromise = (async () => {
            if (this.snapshot?.activatedAt !== activationId) return;
            try {
                await KeepAwake.keepAwake();
            } catch {
                /* keep-awake not available */
            }
        })();

        await Promise.all([persistPromise, hapticPromise, wakePromise]);
        const finalSnapshot = this.snapshot ?? snap;
        log.info('MOB ACTIVATED', finalSnapshot);
        return { ...finalSnapshot };
    }

    /** Cancel the active MOB. Releases wake-lock and clears tracking. */
    async clear(): Promise<void> {
        if (!this.snapshot) return;

        const clearingSnapshot = this.snapshot;
        try {
            await this.removePersisted();
        } catch (error) {
            if (this.snapshot === clearingSnapshot) {
                this.persistenceStatus = 'failed';
                this.emit();
            }
            throw new Error('MOB remains active because restart-recovery storage could not be cleared.', {
                cause: error,
            });
        }
        if (this.snapshot !== clearingSnapshot) return;

        log.info('MOB cleared');
        this.snapshot = null;
        this.snapshotOwnerKey = null;
        this.snapshotOwnerUserId = null;
        this.persistenceStatus = 'idle';
        this.own = null;
        this.clearScheduledHaptics();
        this.stopLiveTracking();
        this.emit();

        try {
            await KeepAwake.allowSleep();
        } catch {
            /* noop */
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
        const snap = this.snapshot;
        const own = this.own;
        const elapsedSec = snap ? Math.max(0, Math.floor((Date.now() - snap.activatedAt) / 1000)) : 0;
        const now = Date.now();
        const ownCoordinatesValid =
            own !== null &&
            Number.isFinite(own.latitude) &&
            own.latitude >= -90 &&
            own.latitude <= 90 &&
            Number.isFinite(own.longitude) &&
            own.longitude >= -180 &&
            own.longitude <= 180;
        const ownTimestampValid =
            own !== null && Number.isFinite(own.timestamp) && own.timestamp > 0 && own.timestamp <= now;
        const ownPositionAgeMs = ownCoordinatesValid && ownTimestampValid ? Math.max(0, now - own.timestamp) : null;
        const ownPositionFresh = ownPositionAgeMs !== null && ownPositionAgeMs <= MOB_OWN_POSITION_STALE_MS;
        let distance: number | null = null;
        let bearing: number | null = null;
        if (snap && own && ownPositionFresh) {
            // Canonical haversine (R = 3440.065 NM = 6 371 000.4 m). The old
            // private copy used the WGS-84 mean radius 6 371 008.8 m — the repo's
            // one radius outlier; the ~1.4 mm/km shift is irrelevant at MOB range.
            distance = calculateDistance(own.latitude, own.longitude, snap.fixLat, snap.fixLon) * 1852;
            bearing = calculateBearing(own.latitude, own.longitude, snap.fixLat, snap.fixLon);
        }
        return {
            active: snap ? { ...snap } : null,
            own: own ? { ...own } : null,
            distanceMeters: distance,
            bearingDeg: bearing,
            ownPositionAgeMs,
            ownPositionFresh,
            elapsedSec,
            fixQuality: snap ? (snap.fixAccuracy <= MOB_PRECISE_FIX_ACCURACY_M ? 'precise' : 'approximate') : null,
            persistenceStatus: this.persistenceStatus,
        };
    }

    isActive(): boolean {
        return this.snapshot !== null;
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
        // ensureRunning: THE ENGINE MUST BE STARTED, not merely listened to.
        // GpsService.watchPosition defaults ensureRunning to false, so a bare
        // subscribe only receives fixes if some OTHER consumer already spun the
        // engine up — and App renders MapHub and the Dashboard (the only hooks
        // that do) mutually exclusively with the MOB screen. Without this, live
        // bearing and distance to the person in the water silently never
        // populate while the UI shows a pulsing "Live" badge. GpsService's own
        // comment names MOB as an ensureRunning consumer; it just never was one.
        this.gpsUnsub = GpsService.watchPosition(
            (pos) => {
                this.own = { ...pos };
                this.refineApproximateFix(pos);
                this.emit();
            },
            { ensureRunning: true },
        );
        // Keep elapsed-time ticker so the UI clock moves even when GPS is silent
        if (!this.tickerId) {
            this.tickerId = setInterval(() => this.emit(), 1000);
        }
    }

    /**
     * Improve an uncertain initial datum while the boat is still effectively
     * at the activation point. The original activation timestamp never moves,
     * and the mark freezes permanently after the short refinement window.
     */
    private refineApproximateFix(pos: GpsPosition): void {
        const snap = this.snapshot;
        if (!snap || snap.fixAccuracy <= MOB_PRECISE_FIX_ACCURACY_M) return;
        const displacementM =
            Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude)
                ? calculateDistance(snap.fixLat, snap.fixLon, pos.latitude, pos.longitude) * 1852
                : Number.POSITIVE_INFINITY;
        if (
            !Number.isFinite(pos.latitude) ||
            pos.latitude < -90 ||
            pos.latitude > 90 ||
            !Number.isFinite(pos.longitude) ||
            pos.longitude < -180 ||
            pos.longitude > 180 ||
            !Number.isFinite(pos.accuracy) ||
            pos.accuracy < 0 ||
            pos.accuracy >= snap.fixAccuracy ||
            !Number.isFinite(pos.timestamp) ||
            !Number.isFinite(pos.speed) ||
            pos.speed < 0 ||
            pos.speed > MOB_FIX_REFINEMENT_MAX_SPEED_MPS ||
            !Number.isFinite(displacementM) ||
            displacementM > MOB_FIX_REFINEMENT_MAX_DISPLACEMENT_M ||
            pos.timestamp < snap.activatedAt - MOB_OWN_POSITION_STALE_MS ||
            pos.timestamp > snap.activatedAt + MOB_FIX_REFINEMENT_WINDOW_MS
        ) {
            return;
        }

        const refined: MobSnapshot = {
            ...snap,
            fixLat: pos.latitude,
            fixLon: pos.longitude,
            fixAccuracy: pos.accuracy,
            // activatedAt deliberately inherited from the original alarm.
        };
        this.snapshot = refined;
        this.persistenceStatus = 'pending';
        void this.persist(refined).then(
            () => {
                if (this.snapshot === refined) {
                    this.persistenceStatus = 'confirmed';
                    this.emit();
                }
            },
            (error: unknown) => {
                if (this.snapshot === refined) {
                    this.persistenceStatus = 'failed';
                    this.emit();
                }
                log.error('Improved MOB fix could not be persisted', error);
            },
        );
        log.warn(
            `MOB approximate datum refined from ±${Math.round(snap.fixAccuracy)}m to ±${Math.round(pos.accuracy)}m`,
        );
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

    private async hydrateForScope(scope: AuthIdentityScope): Promise<void> {
        try {
            const { value: deviceValue } = await Preferences.get({ key: STORAGE_KEY });
            if (this.snapshot) return;
            if (deviceValue) {
                const parsed: unknown = JSON.parse(deviceValue);
                if (isValidPersistedSnapshot(parsed)) {
                    this.adoptPersisted(parsed);
                    this.hydratedScopeKeys.add(scope.key);
                    log.info('Hydrated active MOB from device safety storage');
                    return;
                }
                // A corrupt or pre-v2 unattributed record is not safe enough to
                // navigate to. Remove it so it cannot repeatedly masquerade as
                // a recoverable emergency.
                await this.enqueueStorage(async () => Preferences.remove({ key: STORAGE_KEY }));
            }

            const legacyKey = authScopedStorageKey(STORAGE_KEY, scope);
            const { value: scopedValue } = await Preferences.get({ key: legacyKey });
            if (this.snapshot) return;
            if (!scopedValue) {
                this.hydratedScopeKeys.add(scope.key);
                return;
            }

            const parsed: unknown = JSON.parse(scopedValue);
            if (
                !isValidPersistedSnapshot(parsed) ||
                parsed.ownerKey !== scope.key ||
                parsed.ownerUserId !== scope.userId
            ) {
                await this.enqueueStorage(async () => Preferences.remove({ key: legacyKey }));
                this.hydratedScopeKeys.add(scope.key);
                return;
            }

            // Migrate before deleting the only crash-recovery copy.
            await this.enqueueStorage(async () => {
                await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(parsed) });
                await Preferences.remove({ key: legacyKey });
            });
            if (this.snapshot) return;
            this.adoptPersisted(parsed);
            this.hydratedScopeKeys.add(scope.key);
            log.info('Migrated and hydrated active MOB from legacy scoped storage');
        } catch (e) {
            log.warn('hydrate failed', e);
        }
    }

    private adoptPersisted(persisted: PersistedMobSnapshot): void {
        this.snapshot = { ...persisted.snapshot };
        this.snapshotOwnerKey = persisted.ownerKey;
        this.snapshotOwnerUserId = persisted.ownerUserId;
        this.persistenceStatus = 'confirmed';
        this.startLiveTracking();
        this.emit();
    }

    private async persist(snap: MobSnapshot): Promise<void> {
        if (!this.snapshotOwnerKey) throw new Error('MOB device recovery owner metadata is unavailable.');
        const persisted: PersistedMobSnapshot = {
            version: STORAGE_VERSION,
            ownerKey: this.snapshotOwnerKey,
            ownerUserId: this.snapshotOwnerUserId,
            snapshot: { ...snap },
        };
        await this.enqueueStorage(async () => {
            await Preferences.set({
                key: STORAGE_KEY,
                value: JSON.stringify(persisted),
            });
        });
    }

    private async removePersisted(): Promise<void> {
        const ownerKey = this.snapshotOwnerKey;
        const ownerUserId = this.snapshotOwnerUserId;
        await this.enqueueStorage(async () => {
            // Also clear a pre-device-scope record if this emergency was
            // migrated from an older beta build. Remove it first: if this step
            // fails, the device-authoritative restart record must remain.
            if (ownerKey) {
                await Preferences.remove({
                    key: authScopedStorageKey(STORAGE_KEY, {
                        key: ownerKey,
                        userId: ownerUserId,
                        generation: 0,
                    }),
                });
            }
            await Preferences.remove({ key: STORAGE_KEY });
        });
    }

    /**
     * Capacitor Preferences has no transaction API. Per-owner serialization
     * prevents a slow activation write from resurrecting a later clear.
     */
    private enqueueStorage(operation: () => Promise<void>): Promise<void> {
        const previous = this.storageChains.get(STORAGE_KEY) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.storageChains.set(STORAGE_KEY, next);
        const cleanup = () => {
            if (this.storageChains.get(STORAGE_KEY) === next) {
                this.storageChains.delete(STORAGE_KEY);
            }
        };
        void next.then(cleanup, cleanup);
        return next;
    }

    private scheduleHaptic(activationId: number, delayMs: number): void {
        const timeout = setTimeout(() => {
            this.hapticTimeouts.delete(timeout);
            if (this.snapshot?.activatedAt !== activationId) return;
            void Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
        }, delayMs);
        this.hapticTimeouts.add(timeout);
    }

    private clearScheduledHaptics(): void {
        for (const timeout of this.hapticTimeouts) clearTimeout(timeout);
        this.hapticTimeouts.clear();
    }

    private emit(): void {
        setLiveMobSafetyState(this.snapshot !== null);
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
