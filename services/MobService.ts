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
import { createLogger } from '../utils/logger';

const log = createLogger('MOB');

const STORAGE_KEY = 'thalassa_mob_active_v1';

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

class MobServiceClass {
    private snapshot: MobSnapshot | null = null;
    private own: GpsPosition | null = null;
    private tickerId: ReturnType<typeof setInterval> | null = null;
    private gpsUnsub: (() => void) | null = null;
    private subs = new Set<Subscriber>();
    private hydrated = false;

    /** Load any persisted MOB on first access. Idempotent. */
    async hydrate(): Promise<void> {
        if (this.hydrated) return;
        this.hydrated = true;
        try {
            const { value } = await Preferences.get({ key: STORAGE_KEY });
            if (!value) return;
            const parsed = JSON.parse(value) as MobSnapshot;
            if (parsed && typeof parsed.fixLat === 'number' && typeof parsed.fixLon === 'number') {
                this.snapshot = parsed;
                this.startLiveTracking();
                log.info('Hydrated active MOB from storage', parsed);
            }
        } catch (e) {
            log.warn('hydrate failed', e);
        }
    }

    /**
     * Mark Man Overboard at the most recent GPS fix. Triggers haptics,
     * wakes the screen, and starts live bearing/distance tracking.
     * Returns the snapshot, or null if no GPS fix was obtainable.
     */
    async activate(): Promise<MobSnapshot | null> {
        await this.hydrate();
        if (this.snapshot) return this.snapshot; // already active — no-op

        const pos = await GpsService.getCurrentPosition({ staleLimitMs: 15_000, timeoutSec: 6 });
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
        this.snapshot = snap;
        await this.persist(snap);

        // Strong triple-buzz to distinguish from normal taps
        try {
            await Haptics.impact({ style: ImpactStyle.Heavy });
            setTimeout(() => Haptics.impact({ style: ImpactStyle.Heavy }), 180);
            setTimeout(() => Haptics.impact({ style: ImpactStyle.Heavy }), 360);
        } catch {
            /* haptics unavailable on web */
        }

        try {
            await KeepAwake.keepAwake();
        } catch {
            /* keep-awake not available */
        }

        this.startLiveTracking();
        this.emit();
        log.info('MOB ACTIVATED', snap);
        return snap;
    }

    /** Cancel the active MOB. Releases wake-lock and clears tracking. */
    async clear(): Promise<void> {
        if (!this.snapshot) return;
        log.info('MOB cleared');
        this.snapshot = null;
        this.own = null;
        this.stopLiveTracking();
        try {
            await KeepAwake.allowSleep();
        } catch {
            /* noop */
        }
        try {
            await Preferences.remove({ key: STORAGE_KEY });
        } catch (e) {
            log.warn('failed to clear storage', e);
        }
        this.emit();
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
        let distance: number | null = null;
        let bearing: number | null = null;
        if (snap && own) {
            distance = distanceMeters(own.latitude, own.longitude, snap.fixLat, snap.fixLon);
            bearing = bearingDeg(own.latitude, own.longitude, snap.fixLat, snap.fixLon);
        }
        return {
            active: snap,
            own,
            distanceMeters: distance,
            bearingDeg: bearing,
            elapsedSec,
        };
    }

    isActive(): boolean {
        return this.snapshot !== null;
    }

    // ── Internals ────────────────────────────────────────────────────────────
    private startLiveTracking(): void {
        if (this.gpsUnsub) return;
        this.gpsUnsub = GpsService.watchPosition((pos) => {
            this.own = pos;
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

    private async persist(snap: MobSnapshot): Promise<void> {
        try {
            await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(snap) });
        } catch (e) {
            log.warn('failed to persist MOB', e);
        }
    }

    private emit(): void {
        const state = this.currentState();
        for (const sub of this.subs) {
            try {
                sub(state);
            } catch (e) {
                log.warn('subscriber threw', e);
            }
        }
    }
}

export const MobService = new MobServiceClass();
