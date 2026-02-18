/**
 * GpsTrackBuffer — High-frequency GPS capture + intelligent track thinning
 *
 * Buffers every GPS fix from the onLocation stream (1–10 Hz depending on
 * hardware) and applies Ramer-Douglas-Peucker line simplification with
 * speed-adaptive tolerance when flushed.
 *
 * Key invariants:
 *  - Turn points (≥22.5° heading change) are ALWAYS preserved
 *  - Speed transitions (±3 kts) are ALWAYS preserved
 *  - GPS signal recovery (>5s gap) points are ALWAYS preserved
 *  - First and last points are ALWAYS preserved
 *  - RDP epsilon adapts to speed: tighter at low speed, looser offshore
 */

import type { CachedPosition } from '../BgGeoManager';

// ── CONSTANTS ──────────────────────────────────────────────────────────

/** Maximum buffer size — ~2 minutes at 10 Hz, ~10 minutes at 1 Hz */
const MAX_BUFFER_SIZE = 1200;

/** Heading change threshold for forced waypoint (22.5° = 1/16 compass) */
const TURN_THRESHOLD_DEG = 22.5;

/** Speed change threshold for forced keep (knots) */
const SPEED_CHANGE_THRESHOLD_KTS = 3;

/** Time gap threshold for forced keep — GPS signal recovery (ms) */
const GAP_THRESHOLD_MS = 5_000;

/** Minimum distance between kept points (meters) — prevents sub-meter noise */
const MIN_POINT_SPACING_M = 1;

/** m/s → knots conversion factor */
const MS_TO_KTS = 1.94384;

// ── GEOMETRY HELPERS ───────────────────────────────────────────────────

/** Haversine distance in meters between two lat/lon points */
function haversineMeters(
    lat1: number, lon1: number,
    lat2: number, lon2: number
): number {
    const R = 6_371_000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Perpendicular distance from point P to line segment A→B, in meters.
 * Uses cross-track distance formula for spherical earth.
 */
function perpendicularDistanceMeters(
    pLat: number, pLon: number,
    aLat: number, aLon: number,
    bLat: number, bLon: number
): number {
    const dAP = haversineMeters(aLat, aLon, pLat, pLon);
    const dAB = haversineMeters(aLat, aLon, bLat, bLon);

    if (dAB < 0.01) return dAP; // A and B are the same point

    // Bearing from A to B
    const bearAB = bearing(aLat, aLon, bLat, bLon);
    // Bearing from A to P
    const bearAP = bearing(aLat, aLon, pLat, pLon);

    // Cross-track distance (signed)
    const R = 6_371_000;
    const crossTrack = Math.asin(
        Math.sin(dAP / R) * Math.sin((bearAP - bearAB) * Math.PI / 180)
    ) * R;

    return Math.abs(crossTrack);
}

/** Bearing in degrees from point A to point B */
function bearing(
    lat1: number, lon1: number,
    lat2: number, lon2: number
): number {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
        Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/**
 * Angular difference between two bearings (0–180°).
 * Handles wrap-around correctly (e.g., 350° → 10° = 20°, not 340°).
 */
function headingDelta(a: number, b: number): number {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
}

// ── SPEED-ADAPTIVE EPSILON ─────────────────────────────────────────────

/**
 * Returns RDP epsilon in meters based on average speed.
 * Tighter at low speed (walking, harbor) for maximum fidelity.
 * Looser at high speed (offshore passage) where slight deviations don't matter.
 */
function getEpsilonForSpeed(speedKts: number): number {
    if (speedKts < 3) return 2;    // Walking / harbor drifting → 2m tolerance
    if (speedKts < 8) return 5;    // Motoring / coastal sailing → 5m tolerance
    if (speedKts < 15) return 10;  // Fast passage → 10m tolerance
    return 15;                      // Racing / planing → 15m tolerance
}

// ── RAMER-DOUGLAS-PEUCKER ──────────────────────────────────────────────

/**
 * Ramer-Douglas-Peucker line simplification.
 * Returns array of indices into `points` that should be kept.
 * Always preserves first and last point.
 *
 * @param points  Array of positions to simplify
 * @param epsilon Tolerance in meters — points closer than this to the
 *                simplified line are discarded
 */
function rdpSimplify(points: CachedPosition[], epsilon: number): Set<number> {
    const keep = new Set<number>();
    if (points.length <= 2) {
        for (let i = 0; i < points.length; i++) keep.add(i);
        return keep;
    }

    // Iterative stack-based RDP (avoids stack overflow on large buffers)
    const stack: [number, number][] = [[0, points.length - 1]];
    keep.add(0);
    keep.add(points.length - 1);

    while (stack.length > 0) {
        const [start, end] = stack.pop()!;
        if (end - start < 2) continue;

        let maxDist = 0;
        let maxIdx = start;

        for (let i = start + 1; i < end; i++) {
            const dist = perpendicularDistanceMeters(
                points[i].latitude, points[i].longitude,
                points[start].latitude, points[start].longitude,
                points[end].latitude, points[end].longitude
            );
            if (dist > maxDist) {
                maxDist = dist;
                maxIdx = i;
            }
        }

        if (maxDist > epsilon) {
            keep.add(maxIdx);
            stack.push([start, maxIdx]);
            stack.push([maxIdx, end]);
        }
    }

    return keep;
}

// ── INTELLIGENT TRACK THINNING ─────────────────────────────────────────

/**
 * Thin a sequence of GPS positions to only significant points.
 *
 * Strategy:
 * 1. Force-keep turn points (heading Δ ≥ 22.5°)
 * 2. Force-keep speed transitions (Δ ≥ 3 kts)
 * 3. Force-keep GPS recovery points (time gap > 5s)
 * 4. Run RDP with speed-adaptive epsilon on remaining points
 * 5. Merge all kept indices
 * 6. Remove points too close together (< 2m) except force-kept
 */
export function thinTrack(points: CachedPosition[]): CachedPosition[] {
    if (points.length <= 2) return [...points];

    // --- Pass 1: Identify force-keep indices ---
    const forceKeep = new Set<number>();
    forceKeep.add(0);
    forceKeep.add(points.length - 1);

    let lastKeptHeading: number | null = null;
    let lastKeptSpeed: number = 0;

    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const speedKts = (p.speed ?? 0) * MS_TO_KTS;

        // GPS heading (if available and moving)
        const heading = p.heading;

        // Turn detection: compare to last kept heading
        if (heading !== null && heading !== undefined && speedKts > 1) {
            if (lastKeptHeading !== null) {
                const delta = headingDelta(heading, lastKeptHeading);
                if (delta >= TURN_THRESHOLD_DEG) {
                    forceKeep.add(i);
                    lastKeptHeading = heading;
                    lastKeptSpeed = speedKts;
                    continue;
                }
            } else {
                lastKeptHeading = heading;
            }
        }

        // Speed transition detection
        if (Math.abs(speedKts - lastKeptSpeed) >= SPEED_CHANGE_THRESHOLD_KTS) {
            forceKeep.add(i);
            lastKeptSpeed = speedKts;
            if (heading !== null) lastKeptHeading = heading;
            continue;
        }

        // GPS signal recovery (time gap > 5s from previous point)
        if (i > 0) {
            const gap = Math.abs(p.timestamp - points[i - 1].timestamp);
            if (gap >= GAP_THRESHOLD_MS) {
                forceKeep.add(i);
                forceKeep.add(i - 1); // Also keep the point before the gap
            }
        }
    }

    // --- Pass 2: RDP simplification with speed-adaptive epsilon ---
    // Calculate average speed across the buffer
    const avgSpeedKts = points.reduce((s, p) => s + (p.speed ?? 0), 0) / points.length * MS_TO_KTS;
    const epsilon = getEpsilonForSpeed(avgSpeedKts);

    const rdpKeep = rdpSimplify(points, epsilon);

    // --- Pass 3: Merge force-keep + RDP indices ---
    const allKeep = new Set([...forceKeep, ...rdpKeep]);

    // --- Pass 4: Filter out sub-spacing noise (except force-kept) ---
    const sortedIndices = Array.from(allKeep).sort((a, b) => a - b);
    const finalIndices: number[] = [];
    let lastKeptPos: CachedPosition | null = null;

    for (const idx of sortedIndices) {
        const p = points[idx];

        // Always keep force-kept points
        if (forceKeep.has(idx)) {
            finalIndices.push(idx);
            lastKeptPos = p;
            continue;
        }

        // Skip if too close to last kept point
        if (lastKeptPos) {
            const dist = haversineMeters(
                lastKeptPos.latitude, lastKeptPos.longitude,
                p.latitude, p.longitude
            );
            if (dist < MIN_POINT_SPACING_M) continue;
        }

        finalIndices.push(idx);
        lastKeptPos = p;
    }

    return finalIndices.map(i => points[i]);
}

// ── RING BUFFER ────────────────────────────────────────────────────────

/**
 * GpsTrackBuffer — Ring buffer for high-frequency GPS positions.
 *
 * Every onLocation callback pushes into this buffer. On each interval tick
 * the ShipLogService drains the buffer and runs thinTrack() to extract
 * only the significant positions for logging.
 */
export class GpsTrackBuffer {
    private buffer: CachedPosition[] = [];
    private maxSize: number;

    constructor(maxSize: number = MAX_BUFFER_SIZE) {
        this.maxSize = maxSize;
    }

    /** Push a new GPS fix into the buffer */
    push(pos: CachedPosition): void {
        this.buffer.push(pos);
        // Trim from front if over capacity
        if (this.buffer.length > this.maxSize) {
            this.buffer = this.buffer.slice(this.buffer.length - this.maxSize);
        }
    }

    /** Drain all positions and clear the buffer. Returns chronologically ordered array. */
    drain(): CachedPosition[] {
        const result = this.buffer;
        this.buffer = [];
        return result;
    }

    /** Peek at the most recent position without draining */
    peek(): CachedPosition | null {
        return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
    }

    /** Current buffer size */
    get length(): number {
        return this.buffer.length;
    }

    /** Clear the buffer without returning data */
    clear(): void {
        this.buffer = [];
    }
}
