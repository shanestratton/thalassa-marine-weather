/**
 * AisStore — Live AIS vessel target store.
 *
 * Maintains a map of MMSI → AisTarget, merging position reports and
 * static data from the AIS decoder. Publishes GeoJSON for the map layer.
 *
 * Follows the same singleton pub/sub pattern as NmeaStore and WindStore.
 */
import type { AisTarget } from '../types/navigation';
import type { AisDecoded } from './AisDecoder';
import { createLogger } from '../utils/createLogger';
import {
    AIS_COG_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_SOG_NOT_AVAILABLE,
    aisTargetIsDistressBeacon,
    distressTextSignal,
} from '../utils/collisionRule';

const log = createLogger('AIS');

// ── Configuration ──
const SWEEP_INTERVAL_MS = 60_000; // Check for stale targets every 60s
const TARGET_EXPIRY_MS = 10 * 60_000; // Remove targets silent for 10 minutes
const MAX_TARGETS = 500; // Cap to prevent memory issues in busy ports
/** Message 14 texts held at once (shore stations broadcast them too). */
const MAX_SAFETY_TEXTS = 100;

/** A message 14's text and when it was heard (build 125, 125-02). */
export interface AisSafetyText {
    text: string;
    at: number;
}

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
        navStatus: number | null;
        shipType: number;
        callSign: string;
        destination: string;
        statusColor: string;
        lastUpdated: number;
        /** The MMSI's latest message 14 text (a beacon's 'SART ACTIVE' / 'SART TEST'), when one was heard. */
        safetyText?: string;
        safetyTextAt?: number;
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
    /** When AIS was last heard: the newest report of ANY message, own ship and static ones included (125-01). */
    private lastHeardAt = 0;
    /** Our own MMSI, learned from the boat's own transponder (!AIVDO). */
    private ownMmsi: number | null = null;
    /**
     * Message 14 texts by MMSI (build 125, 125-02). Kept apart from the
     * targets: a text carries no position, so it never makes a target at 0,0.
     */
    private safety = new Map<number, AisSafetyText>();

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
        this.safety.clear();
        this.lastHeardAt = 0;
        this.notify();
        log.info('AIS store stopped');
    }

    /**
     * One decoded message off the boat's data feed (build 125, 125-01).
     * `ownShip` means it came as !AIVDO: our own transponder reporting us.
     * That teaches the store our MMSI, so the guard ring and the collision
     * alarm never grade our own echo as a vessel at our own position, even
     * when no MMSI was typed into Settings → Vessel. It still updates the
     * store as before.
     */
    ingest(partial: AisDecoded, ownShip: boolean): void {
        if (ownShip && partial.mmsi) this.ownMmsi = partial.mmsi;
        this.update(partial);
    }

    /** Our own MMSI as our transponder reports it, or null (no !AIVDO heard). */
    getOwnMmsi(): number | null {
        return this.ownMmsi;
    }

    /** Epoch ms of the newest AIS report heard by any lane, swept targets included (0 = none). */
    getLastHeardAt(): number {
        return this.lastHeardAt;
    }

    /** The MMSI's latest message 14 text, or null. */
    getSafetyText(mmsi: number): AisSafetyText | null {
        return this.safety.get(mmsi) ?? null;
    }

    /** Every message 14 text held, by MMSI: the distress watch reads beacons heard before their position. */
    getSafetyTexts(): ReadonlyMap<number, AisSafetyText> {
        return this.safety;
    }

    /** Merge-upsert a partial AIS target (from decoder) */
    update(partial: AisDecoded): void {
        if (!partial.mmsi) return;
        const heardAt = Math.min(Date.now(), partial.lastUpdated ?? Date.now());
        if (Number.isFinite(heardAt) && heardAt > this.lastHeardAt) this.lastHeardAt = heardAt;

        // Message 14: its text against the MMSI, and no target. Listeners hear
        // it at once, so a beacon heard before its position still alarms.
        if (typeof partial.safetyText === 'string') {
            this.recordSafetyText(partial.mmsi, partial.safetyText, heardAt);
            this.notify();
            return;
        }

        const existing = this.targets.get(partial.mmsi);
        if (existing) {
            // Merge: position reports update kinematics, static reports update metadata
            Object.assign(existing, partial);
        } else {
            // New target — apply defaults. Course and speed a static message
            // did not carry are 'not available' (ITU 360 / 102.3), never 0: a
            // 0 is a stopped boat pointing north, and the collision rule would
            // read it as one (build 125, 125-01). A status nobody reported is
            // null, never 15: on a 97x MMSI, 15 is a beacon's TEST (125-10b).
            if (this.targets.size >= MAX_TARGETS) {
                this.evictOldest();
            }
            const target: AisTarget = {
                mmsi: partial.mmsi,
                name: partial.name ?? '',
                lat: partial.lat ?? 0,
                lon: partial.lon ?? 0,
                cog: partial.cog ?? AIS_COG_NOT_AVAILABLE,
                sog: partial.sog ?? AIS_SOG_NOT_AVAILABLE,
                heading: partial.heading ?? AIS_HEADING_NOT_AVAILABLE,
                navStatus: partial.navStatus ?? null,
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
            const safety = this.safety.get(target.mmsi);

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
                    ...(safety ? { safetyText: safety.text, safetyTextAt: safety.at } : {}),
                },
            });
        }

        return { type: 'FeatureCollection', features };
    }

    // ── Internals ──

    private notify(): void {
        for (const cb of this.listeners) cb(this.targets);
    }

    /** A beacon (a 97x MMSI, status 14, or a beacon's own text) is never swept or evicted (125-02). */
    private isBeacon(mmsi: number, navStatus?: number | null): boolean {
        if (aisTargetIsDistressBeacon(mmsi, navStatus)) return true;
        return distressTextSignal(this.safety.get(mmsi)?.text, mmsi) !== null;
    }

    private recordSafetyText(mmsi: number, text: string, at: number): void {
        if (!this.safety.has(mmsi) && this.safety.size >= MAX_SAFETY_TEXTS) {
            // Room for the new one: the oldest station's text goes, a beacon's last.
            let oldest: number | null = null;
            let oldestBeacon: number | null = null;
            for (const [key, entry] of this.safety) {
                const slot = this.isBeacon(key, this.targets.get(key)?.navStatus) ? 'beacon' : 'station';
                if (slot === 'station' && (oldest === null || entry.at < this.safety.get(oldest)!.at)) oldest = key;
                if (slot === 'beacon' && (oldestBeacon === null || entry.at < this.safety.get(oldestBeacon)!.at)) {
                    oldestBeacon = key;
                }
            }
            const drop = oldest ?? oldestBeacon;
            if (drop !== null) this.safety.delete(drop);
        }
        this.safety.set(mmsi, { text, at });
    }

    /** Remove targets with no update for TARGET_EXPIRY_MS. A beacon stays, its age shown wherever it is drawn. */
    private sweep(): void {
        const now = Date.now();
        let removed = 0;
        for (const [mmsi, target] of this.targets) {
            if (now - target.lastUpdated > TARGET_EXPIRY_MS && !this.isBeacon(mmsi, target.navStatus)) {
                this.targets.delete(mmsi);
                removed++;
            }
        }
        for (const [mmsi, entry] of this.safety) {
            if (now - entry.at > TARGET_EXPIRY_MS && !this.isBeacon(mmsi, this.targets.get(mmsi)?.navStatus)) {
                this.safety.delete(mmsi);
            }
        }
        if (removed > 0) {
            log.info(`Swept ${removed} stale AIS targets, ${this.targets.size} remaining`);
            this.notify();
        }
    }

    /**
     * Evict the oldest target when at capacity, never a beacon. Only a store
     * holding nothing but beacons (500 of them is a spoofer, not a sea) drops
     * its oldest beacon, so memory stays bounded.
     */
    private evictOldest(): void {
        let oldestMmsi = 0;
        let oldestTime = Infinity;
        let oldestBeaconMmsi = 0;
        let oldestBeaconTime = Infinity;
        for (const [mmsi, target] of this.targets) {
            if (this.isBeacon(mmsi, target.navStatus)) {
                if (target.lastUpdated < oldestBeaconTime) {
                    oldestBeaconTime = target.lastUpdated;
                    oldestBeaconMmsi = mmsi;
                }
            } else if (target.lastUpdated < oldestTime) {
                oldestTime = target.lastUpdated;
                oldestMmsi = mmsi;
            }
        }
        const drop = oldestMmsi || oldestBeaconMmsi;
        if (drop) this.targets.delete(drop);
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
 *   14 = AIS-SART / MOB / EPIRB active → distress red (125-02)
 *   15 = Not defined / Class B → sky blue (and null: no status reported)
 */
function navStatusColor(status: number | null): string {
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
        case 14:
            return '#ff1a1a'; // AIS-SART / MOB / EPIRB active — distress red
        case 15:
        case null:
            return '#38bdf8'; // Not defined / Class B / none reported — sky blue
        default:
            return '#94a3b8'; // Unknown — grey
    }
}

export const AisStore = new AisStoreClass();
