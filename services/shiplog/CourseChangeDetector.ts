/**
 * CourseChangeDetector — fires when the boat's bearing changes by
 * ≥COURSE_CHANGE_THRESHOLD_DEG (currently 30°, one quarter past one
 * compass point). On fire the pin is placed at the GEOMETRIC MIDPOINT
 * of the turn (start-of-drift position averaged with end-of-drift
 * position), not at the position where the threshold was crossed.
 *
 * Strategy: every 15s, take the latest GPS fix and compute the bearing
 * from the LAST checked position to the CURRENT one — i.e. a recent,
 * short vector. Compare that against a "baseline" heading that stays
 * locked until we detect a turn. On turn, fire `onTurn(...)` with the
 * midpoint lat/lon embedded and reset the baseline to the new heading.
 *
 * Why this, not "bearing from voyage origin": on long straight legs the
 * origin-bearing barely changes when you turn (1km north + small turn
 * → bearing-from-origin moves a degree or two). The recent-vector
 * approach is sensitive to short turns.
 *
 * Threshold tuning (2026-05-17):
 * Raised the firing threshold from 22.5° (one compass point) to 30°.
 * At 22.5°, under-sail helm corrections and minor course adjustments
 * triggered visible waypoint pins ("Auto: COG ENE → E") which cluttered
 * the chart with non-meaningful markers. 30° catches deliberate
 * direction changes only:
 *   - Tacks   (90°+ wind-to-wind under sail)
 *   - Gybes   (120°+ downwind under sail)
 *   - Harbour turns (typically 45-90°)
 *   - Waypoint approaches / channel bends
 * Trim adjustments (5-15°), minor lulls, and GPS jitter at the
 * speed-tier edge no longer paint a pin.
 *
 * NOTE: this is the WAYPOINT-EMISSION threshold (visible map markers).
 * The track polyline force-keep threshold in GpsTrackBuffer.thinTrack
 * stays at 22.5° so the rendered LINE still curves accurately around
 * gentler bends — only the named PIN density is reduced here.
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
/**
 * Minimum heading delta (degrees) for a course change to fire a
 * waypoint marker. Raised 22.5 → 30 on 2026-05-17 — see the file-
 * level docstring for the full rationale.
 */
const COURSE_CHANGE_THRESHOLD_DEG = 30;
/**
 * Smaller heading delta (degrees) that marks "the turn has STARTED."
 * When `delta` first crosses this threshold we remember the position
 * as `turnStartPos`. When `delta` later reaches the fire threshold
 * (30°) the pin is placed at midpoint(turnStartPos, currentPos)
 * rather than at currentPos.
 *
 * Added 2026-05-19 (option B from Shane's review): for sharp turns
 * (tack/gybe/harbour entry) start-of-drift and end-of-drift sit
 * within metres of each other, so behaviour is unchanged. For long
 * gradual turns (e.g. a 30° drift over 12 hours) the old logic
 * dropped a pin at the END of the turn — could be 20–60 NM downstream
 * of where the sailor would intuitively say "the turn happened here."
 * Midpoint placement fixes that.
 *
 * If drift starts (≥5°) then steadies back (<5°) before reaching 30°,
 * the start anchor is abandoned (false-start protection).
 */
const TURN_START_THRESHOLD_DEG = 5;

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
    /**
     * Latitude of the geometric midpoint of the turn — average of
     * start-of-drift position and end-of-drift position. If no
     * start-of-drift was captured (e.g. the turn went from 0° to
     * 30° in a single tick — sharp helm input) this falls back to
     * the current position.
     */
    lat: number;
    /** Longitude of the geometric midpoint of the turn. */
    lon: number;
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
     * Set when `delta` first crosses TURN_START_THRESHOLD_DEG. Holds
     * the position right BEFORE the drift began (the previous tick's
     * anchor). When the fire threshold is reached, the pin is placed
     * at midpoint(turnStartPos, currentPos). Cleared on fire, or on
     * `delta` falling back below the start threshold (false-start).
     */
    private turnStartPos: { lat: number; lon: number } | null = null;

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
        this.turnStartPos = null;
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

        // Capture the PRE-SLIDE anchor so we can use it as the "drift
        // started here" position if we cross the start threshold this
        // tick. After this point lastValidPos becomes currentPos.
        const previousAnchor = this.lastValidPos;

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

        // 6a. Track turn-start position for midpoint pin placement.
        // First tick where drift crosses the start threshold → remember
        // the pre-slide anchor (≈ where we were 15s ago, right at the
        // edge of the still-on-baseline window). If drift falls back
        // below the threshold without ever reaching fire, abandon.
        if (delta >= TURN_START_THRESHOLD_DEG) {
            if (!this.turnStartPos) {
                this.turnStartPos = previousAnchor;
            }
        } else if (this.turnStartPos) {
            // False start — boat steadied back inside the start band.
            this.turnStartPos = null;
        }

        if (delta < COURSE_CHANGE_THRESHOLD_DEG) return;

        const oldDeg = this.baselineHeading;
        const newDeg = recentBearing;
        const oldCardinal = degreesToCardinal16(oldDeg);
        const newCardinal = degreesToCardinal16(newDeg);

        // 7. Compute pin position — midpoint of (start-of-drift, now).
        // Fallback to current position if no start anchor was captured
        // (happens when the turn goes 0° → 30° in a SINGLE tick — sharp
        // helm input, no intermediate "started drifting" sample). Even
        // then start ≈ end so the result reads correctly.
        const pinPos = this.turnStartPos ? lonLatMidpoint(this.turnStartPos, currentPos) : currentPos;

        // Lock baseline to the new direction for the next leg. Clear
        // the turn-start anchor — the next turn starts fresh.
        this.baselineHeading = newDeg;
        this.turnStartPos = null;

        log.info(
            `Turn detected: ${oldCardinal} → ${newCardinal} (Δ${delta.toFixed(1)}°) ` +
                `pin @ ${pinPos.lat.toFixed(5)},${pinPos.lon.toFixed(5)}`,
        );

        try {
            opts.onTurn({
                oldDeg,
                newDeg,
                oldCardinal,
                newCardinal,
                deltaDeg: delta,
                lat: pinPos.lat,
                lon: pinPos.lon,
            });
        } catch (e) {
            // Defensive: an exception inside onTurn would kill the timer
            // and we'd silently stop detecting course changes for the
            // rest of the voyage.
            log.warn('onTurn handler threw — continuing', e);
        }
    }
}

/**
 * Linear midpoint of two lat/lon points, with antimeridian-aware
 * longitude handling. For waypoint pins at the scale of a single
 * turn (≤60 NM), great-circle vs flat-earth midpoint differs by a
 * few hundred metres at most — not worth the geodetic complexity.
 */
function lonLatMidpoint(
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
): { lat: number; lon: number } {
    const lat = (a.lat + b.lat) / 2;
    let dLon = b.lon - a.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = a.lon + dLon / 2;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return { lat, lon };
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
