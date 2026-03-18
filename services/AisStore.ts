/**
 * AisStore — Live AIS vessel target store.
 *
 * Maintains a map of MMSI → AisTarget, merging position reports and
 * static data from the AIS decoder. Publishes GeoJSON for the map layer.
 *
 * Follows the same singleton pub/sub pattern as NmeaStore and WindStore.
 */
import type { AisTarget } from '../types/navigation';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AIS');

// ── Configuration ──
const SWEEP_INTERVAL_MS = 60_000; // Check for stale targets every 60s
const TARGET_EXPIRY_MS = 10 * 60_000; // Remove targets silent for 10 minutes
const MAX_TARGETS = 500; // Cap to prevent memory issues in busy ports

export type AisStoreListener = (targets: Map<number, AisTarget>) => void;

// ── GeoJSON Types ──
interface AisGeoJSONFeature {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
        mmsi: number;
        name: string;
        sog: number;
        cog: number;
        heading: number;
        navStatus: number;
        shipType: number;
        callSign: string;
        destination: string;
        statusColor: string;
        lastUpdated: number;
    };
}

interface AisGeoJSON {
    type: 'FeatureCollection';
    features: AisGeoJSONFeature[];
}

class AisStoreClass {
    private targets = new Map<number, AisTarget>();
    private listeners = new Set<AisStoreListener>();
    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    // ── Public API ──

    start(): void {
        if (this.running) return;
        this.running = true;
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        log.info('AIS store started');
    }

    stop(): void {
        this.running = false;
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        this.targets.clear();
        this.notify();
        log.info('AIS store stopped');
    }

    /** Merge-upsert a partial AIS target (from decoder) */
    update(partial: Partial<AisTarget>): void {
        if (!partial.mmsi) return;

        const existing = this.targets.get(partial.mmsi);
        if (existing) {
            // Merge: position reports update kinematics, static reports update metadata
            Object.assign(existing, partial);
        } else {
            // New target — apply defaults
            if (this.targets.size >= MAX_TARGETS) {
                this.evictOldest();
            }
            const target: AisTarget = {
                mmsi: partial.mmsi,
                name: partial.name ?? '',
                lat: partial.lat ?? 0,
                lon: partial.lon ?? 0,
                cog: partial.cog ?? 0,
                sog: partial.sog ?? 0,
                heading: partial.heading ?? 511,
                navStatus: partial.navStatus ?? 15,
                shipType: partial.shipType ?? 0,
                callSign: partial.callSign ?? '',
                destination: partial.destination ?? '',
                lastUpdated: partial.lastUpdated ?? Date.now(),
            };
            // Only add if we have a position (static-only messages without position are useless)
            if (target.lat === 0 && target.lon === 0 && !existing) {
                // Store it anyway so static data is ready when position arrives
            }
            this.targets.set(partial.mmsi, target);
        }

        this.notify();
    }

    /** Get current target map */
    getTargets(): Map<number, AisTarget> {
        return this.targets;
    }

    /** Get count of tracked vessels */
    getCount(): number {
        return this.targets.size;
    }

    /** Subscribe to changes. Returns unsubscribe function. */
    subscribe(cb: AisStoreListener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Export all current targets as a MapBox-ready GeoJSON FeatureCollection */
    toGeoJSON(): AisGeoJSON {
        const features: AisGeoJSONFeature[] = [];

        for (const target of this.targets.values()) {
            // Skip targets without valid position
            if (target.lat === 0 && target.lon === 0) continue;

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [target.lon, target.lat],
                },
                properties: {
                    mmsi: target.mmsi,
                    name: target.name || `MMSI ${target.mmsi}`,
                    sog: target.sog,
                    cog: target.cog,
                    heading: target.heading,
                    navStatus: target.navStatus,
                    shipType: target.shipType,
                    callSign: target.callSign,
                    destination: target.destination,
                    statusColor: navStatusColor(target.navStatus),
                    lastUpdated: target.lastUpdated,
                },
            });
        }

        return { type: 'FeatureCollection', features };
    }

    // ── Internals ──

    private notify(): void {
        for (const cb of this.listeners) cb(this.targets);
    }

    /** Remove targets with no update for TARGET_EXPIRY_MS */
    private sweep(): void {
        const now = Date.now();
        let removed = 0;
        for (const [mmsi, target] of this.targets) {
            if (now - target.lastUpdated > TARGET_EXPIRY_MS) {
                this.targets.delete(mmsi);
                removed++;
            }
        }
        if (removed > 0) {
            log.info(`Swept ${removed} stale AIS targets, ${this.targets.size} remaining`);
            this.notify();
        }
    }

    /** Evict oldest target when at capacity */
    private evictOldest(): void {
        let oldestMmsi = 0;
        let oldestTime = Infinity;
        for (const [mmsi, target] of this.targets) {
            if (target.lastUpdated < oldestTime) {
                oldestTime = target.lastUpdated;
                oldestMmsi = mmsi;
            }
        }
        if (oldestMmsi) this.targets.delete(oldestMmsi);
    }
}

/**
 * Map AIS navigational status code to a display colour.
 *   0 = Under way using engine → green
 *   1 = At anchor → amber
 *   2 = Not under command → red
 *   3 = Restricted manueverability → orange
 *   4 = Constrained by draught → orange
 *   5 = Moored → grey
 *   6 = Aground → red
 *   7 = Engaged in fishing → cyan
 *   8 = Under way sailing → green
 *   15 = Not defined / Class B → sky blue
 */
function navStatusColor(status: number): string {
    switch (status) {
        case 0:
            return '#22c55e'; // Under way (engine) — green
        case 1:
            return '#f59e0b'; // At anchor — amber
        case 2:
            return '#ef4444'; // Not under command — red
        case 3:
            return '#f97316'; // Restricted manoeuvrability — orange
        case 4:
            return '#f97316'; // Constrained by draught — orange
        case 5:
            return '#94a3b8'; // Moored — grey
        case 6:
            return '#ef4444'; // Aground — red
        case 7:
            return '#06b6d4'; // Fishing — cyan
        case 8:
            return '#22c55e'; // Under way (sail) — green
        case 15:
            return '#38bdf8'; // Not defined / Class B — sky blue
        default:
            return '#94a3b8'; // Unknown — grey
    }
}

export const AisStore = new AisStoreClass();
