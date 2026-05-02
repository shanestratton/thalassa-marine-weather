/**
 * CourseChangeDetector — fires when the boat's bearing changes by ≥22.5°
 * (one compass point).
 *
 * Strategy: every 15s, take the latest GPS fix and compute the bearing
 * from the LAST checked position to the CURRENT one — i.e. a recent,
 * short vector. Compare that against a "baseline" heading that stays
 * locked until we detect a turn. On turn, fire `onTurn(oldDeg, newDeg)`
 * and reset the baseline to the new heading.
 *
 * Why this, not "bearing from voyage origin": on long straight legs the
 * origin-bearing barely changes when you turn (1km north + small turn
 * → bearing-from-origin moves a degree or two). The recent-vector
 * approach is sensitive to short turns.
 *
 * Coupling: the detector calls into `getPos()` and `onTurn()` callbacks —
 * it doesn't touch `lastBgLocation`, the tracking state, or any timers
 * outside its own. The `min-movement` threshold reads from
 * `GpsPrecision.getAdaptedThresholds()` so it adapts when an external
 * high-precision GPS (Bad Elf Pro+) is connected.
 */
import { createLogger } from '../../utils/logger';
import type { CachedPosition } from '../BgGeoManager';
import { bearing, headingDelta } from './GpsTrackBuffer';
import { GpsPrecision } from './GpsPrecisionTracker';

const log = createLogger('ShipLog.Course');

const COURSE_CHECK_INTERVAL_MS = 15_000;
const COURSE_CHANGE_THRESHOLD_DEG = 22.5;

const CARDINALS_16 = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
];

/** Convert degrees (0-360) to 16-point compass cardinal (N, NNE, NE, …). */
export function degreesToCardinal16(deg: number): string {
    const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    return CARDINALS_16[idx];
}

export interface TurnEvent {
    /** Old (previous) heading in degrees */
    oldDeg: number;
    /** New heading in degrees */
    newDeg: number;
    /** Old heading as 16-point cardinal */
    oldCardinal: string;
    /** New heading as 16-point cardinal */
    newCardinal: string;
    /** Heading delta in degrees (always positive, 0–180) */
    deltaDeg: number;
}

/**
 * `getPos` should return the latest known position, or null if no fix.
 * `isActive` should return false to skip a tick (e.g. when paused / stopped).
 * `onTurn` is called when a turn ≥ threshold is detected. It MUST NOT
 * throw — exceptions inside the timer would silently kill the loop.
 */
export interface CourseChangeOptions {
    getPos: () => CachedPosition | null;
    isActive: () => boolean;
    onTurn: (event: TurnEvent) => void;
}

export class CourseChangeDetector {
    private intervalId?: ReturnType<typeof setInterval>;
    private lastValidPos: { lat: number; lon: number } | null = null;
    private baselineHeading: number | null = null;

    /**
     * Start the 15s detection loop. Subsequent calls clear the existing
     * timer first, so re-calling on resume is safe.
     */
    start(opts: CourseChangeOptions): void {
        this.stop();
        this.intervalId = setInterval(() => this.tick(opts), COURSE_CHECK_INTERVAL_MS);
    }

    /** Stop the loop and reset the baseline state. */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    /**
     * Reset the position anchor and baseline heading. Called from
     * `startTracking` so a new voyage doesn't inherit the previous
     * voyage's last heading as its baseline.
     */
    reset(): void {
        this.lastValidPos = null;
        this.baselineHeading = null;
    }

    private tick(opts: CourseChangeOptions): void {
        if (!opts.isActive()) return;
        const pos = opts.getPos();
        if (!pos) return;

        const currentPos = { lat: pos.latitude, lon: pos.longitude };

        // 1. Seed the position anchor on first tick of the voyage.
        if (!this.lastValidPos) {
            this.lastValidPos = currentPos;
            return;
        }

        // 2. Distance check — filters GPS jitter when stationary.
        // Threshold adapts to GPS precision (loosens for noisy phone GPS,
        // tightens for high-precision external GPS).
        const distM = haversine(this.lastValidPos.lat, this.lastValidPos.lon, currentPos.lat, currentPos.lon);
        const minMovement = GpsPrecision.getAdaptedThresholds().courseChangeMinMovementM;
        if (distM < minMovement) return;

        // 3. Compute the recent bearing — short vector from anchor to now.
        const recentBearing = bearing(this.lastValidPos.lat, this.lastValidPos.lon, currentPos.lat, currentPos.lon);

        // 4. CRITICAL: slide the anchor forward every tick so the bearing
        //    vector stays SHORT and RECENT. Long legs would dilute the turn signal.
        this.lastValidPos = currentPos;

        // 5. Seed the baseline heading on the first valid movement.
        if (this.baselineHeading === null) {
            this.baselineHeading = recentBearing;
            return;
        }

        // 6. Compare recent bearing against the locked baseline.
        const delta = headingDelta(this.baselineHeading, recentBearing);
        if (delta < COURSE_CHANGE_THRESHOLD_DEG) return;

        const oldDeg = this.baselineHeading;
        const newDeg = recentBearing;
        const oldCardinal = degreesToCardinal16(oldDeg);
        const newCardinal = degreesToCardinal16(newDeg);

        // Lock baseline to the new direction for the next leg.
        this.baselineHeading = newDeg;

        log.info(`Turn detected: ${oldCardinal} → ${newCardinal} (Δ${delta.toFixed(1)}°)`);

        try {
            opts.onTurn({ oldDeg, newDeg, oldCardinal, newCardinal, deltaDeg: delta });
        } catch (e) {
            // Defensive: an exception inside onTurn would kill the timer
            // and we'd silently stop detecting course changes for the
            // rest of the voyage.
            log.warn('onTurn handler threw — continuing', e);
        }
    }
}

/** Haversine distance in meters between two lat/lon points. */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
