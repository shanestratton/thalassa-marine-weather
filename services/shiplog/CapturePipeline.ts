/**
 * CapturePipeline — the four ship-log capture paths, extracted from
 * ShipLogService.
 *
 * Four exports:
 *
 *   - `captureImmediate` — fired at voyage start ("Voyage Start") and
 *     voyage end ("Voyage End"). Creates an entry instantly with a
 *     placeholder position, attempts a brief GPS warm-up, and triggers
 *     a background GPS retry if no fix is available yet.
 *
 *   - `captureLog` — the core logging path. Called from the scheduler
 *     (every interval tick), the course-change detector (turn waypoints),
 *     and the heartbeat (catch-up flushes). Computes distance / speed
 *     deltas vs the previous position, applies the speed + acceleration
 *     sanity gates, and persists.
 *
 *   - `addManual` — the user-initiated entry path. Creates the entry
 *     immediately so the UI updates without waiting for GPS.
 *
 *   - `flushBufferedTrack` — drains the high-frequency GPS buffer,
 *     RDP-thins to keep only significant points, then calls captureLog
 *     for each kept point. The orchestrator wires this as the scheduler's
 *     onTick callback.
 *
 * Coupling: each function takes a `CaptureContext` with the mutable
 * state and persistence/scheduling hooks it needs. The orchestrator
 * owns the actual `TrackingState` object + `lastBgLocation` and exposes
 * them through the context — when these methods mutate them, the
 * orchestrator sees the change because it's the same reference.
 *
 * Behaviour preserved bit-for-bit from the original orchestrator,
 * including:
 *   - 5s GPS warm-up loop in captureImmediate
 *   - Quarter-hour timestamp snapping for offshore-mode auto entries
 *   - DEDUP filter (5m threshold) skipped when called from flushBufferedTrack
 *     (the RDP thinning already filtered for context, blunt dedup
 *     would re-strip valid turn/speed-change points)
 *   - Speed-spike + acceleration-spike rejection (drops the entry rather
 *     than save with zeroed numbers — preserves polyline integrity)
 *   - Rolling waypoint demotion ('Latest Position' → 'auto' on next tick)
 *   - lastBgLocation seeding inside flushBufferedTrack so each thinned
 *     point becomes the next captureLog's "current" fix
 */
import type { ShipLogEntry } from '../../types';
import type { CachedPosition } from '../BgGeoManager';
import { BgGeoManager } from '../BgGeoManager';
import { createLogger } from '../../utils/createLogger';
import {
    saveEntryOnlineOrOffline,
    retryGpsAndUpdateEntry,
    demotePreviousAutoWaypoint,
    webGetFreshPosition,
} from './EntrySave';
import { calculateBearing, calculateDistanceNM, formatPositionDMS, getWeatherSnapshot } from './helpers';
import { getLastPosition, saveLastPosition, type TrackingState } from './TrackingStateStore';
import { type GpsTrackBuffer } from './GpsTrackBuffer';
import { getBestPosition } from './PositionResolver';
import { checkIsOnWater } from './waterDetection';

const log = createLogger('ShipLog.Capture');

const GPS_STALE_LIMIT_MS = 60_000;
const STATIONARY_THRESHOLD_NM = 0.05;
const DEDUP_THRESHOLD_NM = 0.005; // ~10 m
// Both raised on 2026-05-19 after Shane's drive showed 7 stored points
// in 10 minutes (everything else rejected as GPS spike). The old caps
// were sailboat-assumptive: 25 kn absolute, 8 kn delta-per-fix. At
// 5 s sampling, a normal car accelerating 0→50 km/h hits 27 kn between
// consecutive fixes, which rejects every fix in the first 5 seconds
// AND every subsequent fix because 50 km/h itself exceeds the cap.
//
// New ceilings:
//   - 100 kn absolute (Tesla launch territory, fast power boat — beyond
//     any sail or normal driving but well below real-spike deltas)
//   - 50 kn acceleration per fix (= 10 kn/sec at 5 s cadence, covers
//     hard acceleration without letting through the typical GPS
//     teleport which looks like 500+ kn deltas)
const MAX_PLAUSIBLE_SPEED_KTS = 100;
const MAX_ACCELERATION_KTS = 50;

/**
 * Hooks the orchestrator hands to the pipeline. The pipeline mutates
 * `trackingState` in place and assumes the orchestrator persists via
 * `saveTrackingState()` (so other consumers — Dashboard, SystemStatus —
 * see the live state). `getCachedFix` / `setCachedFix` give read+write
 * access to `lastBgLocation`; flushBufferedTrack uses setCachedFix to
 * step through thinned points.
 */
export interface CaptureContext {
    trackingState: TrackingState;
    saveTrackingState: () => Promise<void>;

    isNative: boolean;
    getCachedFix: () => CachedPosition | null;
    setCachedFix: (pos: CachedPosition | null) => void;

    trackBuffer: GpsTrackBuffer;

    getLastWaterStatus: () => boolean | undefined;
    setLastWaterStatus: (v: boolean | undefined) => void;

    rescheduleAdaptiveInterval: () => Promise<void>;
}

// ── captureImmediate ────────────────────────────────────────────────

/**
 * Voyage start / end entry. Returns a populated entry immediately even
 * if GPS hasn't locked yet — needsGpsRetry kicks off a background
 * retry that backfills lat/lon when the first real fix arrives.
 */
export async function captureImmediate(
    ctx: CaptureContext,
    voyageId?: string,
    waypointLabel: string = 'Voyage Start',
): Promise<ShipLogEntry | null> {
    const startedAtMs = Date.now();
    const timestamp = new Date(startedAtMs).toISOString();
    const effectiveVoyageId = voyageId || ctx.trackingState.currentVoyageId || `voyage_${Date.now()}`;

    const weatherSnapshot = getWeatherSnapshot();

    const entry: Partial<ShipLogEntry> = {
        voyageId: effectiveVoyageId,
        timestamp,
        latitude: 0,
        longitude: 0,
        positionFormatted: 'Acquiring position...',
        distanceNM: 0,
        cumulativeDistanceNM: 0,
        speedKts: 0,
        ...weatherSnapshot,
        entryType: 'waypoint',
        waypointName: waypointLabel,
        source: 'device',
    };

    // A fix anchors the voyage pin only if the GPS PRODUCED it recently —
    // judged by the fix's own timestamp, never receivedAt. BgGeo replays
    // the previous session's location at engine start with a fresh
    // receivedAt, and getCurrentPosition can serve the OS's cached
    // last-known sample the same way: both pass any receivedAt check
    // while being spatially stale — that's how voyages opened with a
    // teleport-stale anchor and drew a phantom straight line to the
    // first real fix.
    const isFreshFix = (pos: CachedPosition | null): pos is CachedPosition =>
        !!pos &&
        !(pos.latitude === 0 && pos.longitude === 0) &&
        pos.timestamp >= startedAtMs - GPS_STALE_LIMIT_MS &&
        Date.now() - pos.receivedAt < GPS_STALE_LIMIT_MS;

    // GPS COLD-START WARM-UP.
    //
    // Voyage Start anchors ONLY on a buffer-accepted fix — one that
    // cleared the full acceptance gate including the first-fix
    // consistency check. The cached fix (lastBgLocation) and a blocking
    // getCurrentPosition are both unvetted: engine-start replays can be
    // RE-STAMPED with the current time, passing every timestamp and
    // receivedAt check while being spatially stale (the cold-start
    // phantom-line bug, round 2). If no vetted fix arrives in the
    // window, the pin keeps the placeholder — the track itself opens at
    // the first accepted fix, and the "Acquiring GPS fix…" UI explains
    // the wait. Voyage Start is fire-and-forget from startTracking, so
    // the wait never blocks the UI.
    //
    // Voyage End IS awaited by stopTracking, so it gets a short window
    // and may use the cached fix / a blocking fetch — subscriptions
    // have been live for the whole voyage, so replays aren't a concern.
    const isVoyageStart = waypointLabel === 'Voyage Start';
    const GPS_WARMUP_POLL_MS = 500;
    const GPS_WARMUP_MAX_MS = isVoyageStart ? 30_000 : 5_000;
    let needsGpsRetry = false;
    let bestPos: CachedPosition | null = ctx.trackBuffer.peek();
    if (!bestPos && !isVoyageStart) {
        const cached = ctx.getCachedFix();
        if (isFreshFix(cached)) bestPos = cached;
    }
    if (!bestPos) {
        let triedBlockingFetch = false;
        const deadline = startedAtMs + GPS_WARMUP_MAX_MS;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, GPS_WARMUP_POLL_MS));
            const buffered = ctx.trackBuffer.peek();
            if (buffered) {
                bestPos = buffered;
                break;
            }
            if (!isVoyageStart) {
                const cached = ctx.getCachedFix();
                if (isFreshFix(cached)) {
                    bestPos = cached;
                    break;
                }
                if (!triedBlockingFetch && Date.now() - startedAtMs > GPS_WARMUP_MAX_MS / 2) {
                    triedBlockingFetch = true;
                    const fetched = ctx.isNative
                        ? await BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 10)
                        : await webGetFreshPosition();
                    if (isFreshFix(fetched)) {
                        bestPos = fetched;
                        break;
                    }
                }
            }
        }
    }

    if (bestPos) {
        entry.latitude = bestPos.latitude;
        entry.longitude = bestPos.longitude;
        entry.positionFormatted = formatPositionDMS(bestPos.latitude, bestPos.longitude);

        if (bestPos.heading !== null && bestPos.heading !== undefined && bestPos.heading !== 0) {
            entry.courseDeg = Math.round(bestPos.heading);
        }

        // Cumulative distance: carry the accumulator forward when the
        // stored position belongs to THIS voyage (resume after a JS
        // reload, and the 'Voyage End' pin — which used to hardcode 0
        // and made every completed voyage's map header read "0.0 NM").
        // A different voyageId means a genuinely new voyage: start the
        // accumulator at zero. A MISSING voyageId is legacy data — for
        // 'Voyage End' it was necessarily written during this voyage
        // (the key clears at every stop), so it still carries; for
        // 'Voyage Start' it could be a crashed prior voyage's leftover,
        // so it conservatively resets.
        const lastPos = await getLastPosition();
        const sameVoyage =
            !!lastPos &&
            (lastPos.voyageId === effectiveVoyageId ||
                (lastPos.voyageId === undefined && waypointLabel !== 'Voyage Start'));
        let cumulativeDistanceNM = 0;
        if (lastPos && sameVoyage) {
            const legNM = calculateDistanceNM(lastPos.latitude, lastPos.longitude, bestPos.latitude, bestPos.longitude);
            cumulativeDistanceNM = lastPos.cumulativeDistanceNM + legNM;
            entry.distanceNM = Math.round(legNM * 100) / 100;
        }
        entry.cumulativeDistanceNM = Math.round(cumulativeDistanceNM * 100) / 100;

        await saveLastPosition({
            latitude: bestPos.latitude,
            longitude: bestPos.longitude,
            timestamp,
            cumulativeDistanceNM,
            voyageId: effectiveVoyageId,
        });

        // On-water check (fail-open: assume water if check throws,
        // since a false positive on land is less bad than a false negative
        // on water — the latter would make career totals miss real voyages).
        try {
            entry.isOnWater = await checkIsOnWater(bestPos.latitude, bestPos.longitude);
            ctx.setLastWaterStatus(entry.isOnWater);
        } catch (e) {
            log.warn('checkIsOnWater threw', e);
            entry.isOnWater = true;
        }
    } else {
        // No GPS at all — background retry will backfill if we
        // successfully persist online.
        needsGpsRetry = true;
    }

    const { saved, entryId, wasOffline } = await saveEntryOnlineOrOffline(entry);
    if (!wasOffline && needsGpsRetry && entryId) {
        retryGpsAndUpdateEntry(entryId);
    }

    ctx.trackingState.lastEntryTime = timestamp;
    await ctx.saveTrackingState();

    return saved ?? (entry as ShipLogEntry);
}

// ── captureLog ──────────────────────────────────────────────────────

export type EntryType = 'auto' | 'manual' | 'waypoint';
export type EventCategory =
    | 'navigation'
    | 'weather'
    | 'equipment'
    | 'crew'
    | 'arrival'
    | 'departure'
    | 'safety'
    | 'observation';
export type EngineStatus = 'running' | 'stopped' | 'maneuvering';

export interface CaptureLogOptions {
    entryType?: EntryType;
    notes?: string;
    waypointName?: string;
    eventCategory?: EventCategory;
    engineStatus?: EngineStatus;
    voyageId?: string;
    /**
     * Skip the 5m DEDUP filter. Used by flushBufferedTrack — RDP
     * thinning already gave us context-aware filtering (turns, speed
     * changes, GPS gaps), so re-applying the blunt 5m threshold would
     * silently drop valid turn/speed-change points.
     */
    skipDedup?: boolean;
    /**
     * Optional explicit lat/lon(/time) override for the entry. Used by
     * the CourseChangeDetector so waypoint pins land at the geometric
     * midpoint of the turn (computed inside the detector) rather than
     * at whatever the current cached GPS fix happens to be. The
     * timestamp travels WITH the position: the midpoint is a place the
     * boat occupied earlier, and stamping it with detection time made
     * timestamp-sorted polylines double back to it (the zig-zag bug).
     * Other entry fields (speed, weather, etc.) still come from the
     * live position resolver. Added 2026-05-19; timestamp 2026-06-12.
     */
    positionOverride?: { lat: number; lon: number; timestamp?: number };
    /**
     * Use THIS fix verbatim instead of live position resolution. Used by
     * flushBufferedTrack when replaying buffered historical points:
     * routing them through getBestPosition let a live NMEA fix (checked
     * first, unconditionally) or the 60 s receivedAt staleness check
     * silently replace a historical point's coordinates with the
     * current position — teleporting early-batch points to the flush
     * location (another zig-zag source). Added 2026-06-12.
     */
    fixOverride?: CachedPosition;
}

/**
 * Core logging path. Computes deltas vs last saved position, applies
 * sanity gates, persists, and asks the scheduler to re-evaluate the
 * adaptive interval.
 */
export async function captureLog(ctx: CaptureContext, opts: CaptureLogOptions = {}): Promise<ShipLogEntry | null> {
    const {
        entryType = 'auto',
        notes,
        waypointName,
        eventCategory,
        engineStatus,
        voyageId,
        skipDedup,
        positionOverride,
        fixOverride,
    } = opts;

    try {
        const bestPos = fixOverride ?? (await getBestPosition(ctx.getCachedFix(), ctx.isNative));
        if (!bestPos) {
            // No GPS — skip this auto entry (will retry on next tick).
            // Manual entries can proceed with zero position.
            if (entryType === 'auto') return null;
        }

        const entryVoyageId = voyageId || ctx.trackingState.currentVoyageId || `voyage_${Date.now()}`;

        // positionOverride wins for lat/lon (used by midpoint waypoint
        // pins from CourseChangeDetector). Speed, heading, weather still
        // come from the live fix — only the spatial coords (and their
        // matching time, when supplied) are overridden.
        const latitude = positionOverride?.lat ?? bestPos?.latitude ?? 0;
        const longitude = positionOverride?.lon ?? bestPos?.longitude ?? 0;
        const heading = bestPos?.heading ?? null;
        const isPinOverride = positionOverride !== undefined;

        // Quarter-hour timestamp snap for offshore auto entries (rapid
        // mode + nearshore/coastal use shorter intervals so keep exact ts).
        const exactTimeMs = positionOverride?.timestamp ?? bestPos?.timestamp ?? Date.now();
        const entryTime = new Date(exactTimeMs);
        const isOffshoreMode = !ctx.trackingState.isRapidMode && ctx.trackingState.loggingZone === 'offshore';
        if (entryType === 'auto' && isOffshoreMode) {
            const minutes = entryTime.getMinutes();
            const nearestQuarter = Math.round(minutes / 15) * 15;
            entryTime.setMinutes(nearestQuarter, 0, 0);
            if (nearestQuarter === 60) {
                entryTime.setHours(entryTime.getHours() + 1);
                entryTime.setMinutes(0, 0, 0);
            }
            // Never snap BACKWARD past the previous entry — "nearest"
            // can rewind up to 7.5 min, colliding/reordering timestamps
            // and destabilising every timestamp-sorted polyline.
            const lastEntryMs = ctx.trackingState.lastEntryTime ? Date.parse(ctx.trackingState.lastEntryTime) : 0;
            if (entryTime.getTime() < lastEntryMs) {
                entryTime.setTime(exactTimeMs);
            }
        }
        const timestamp = entryTime.toISOString();

        let lastPos = await getLastPosition();
        // A stored position from a DIFFERENT voyage is not a valid delta
        // reference — distance/speed must never bleed across voyages.
        // A MISSING voyageId is legacy data written during the active
        // voyage (pre-stamping builds): still a valid reference.
        if (lastPos && lastPos.voyageId !== undefined && lastPos.voyageId !== entryVoyageId) {
            lastPos = null;
        }
        let distanceNM = 0;
        let speedKts = 0;
        let cumulativeDistanceNM = 0;

        if (lastPos && isPinOverride) {
            // Turn pins mark a PAST position. They carry the running
            // total but contribute no distance — measuring lastPos →
            // midpoint-behind-the-boat → next fix would double-count
            // the backtrack and inflate the voyage total.
            cumulativeDistanceNM = lastPos.cumulativeDistanceNM;
        } else if (lastPos) {
            distanceNM = calculateDistanceNM(lastPos.latitude, lastPos.longitude, latitude, longitude);

            // DEDUP: skip if vessel hasn't actually moved (auto entries only).
            if (!skipDedup && entryType === 'auto' && distanceNM < DEDUP_THRESHOLD_NM) {
                ctx.trackingState.lastCheckTime = Date.now();
                ctx.trackingState.lastCheckDeduped = true;
                return null;
            }

            const timeDiffMs = new Date(timestamp).getTime() - new Date(lastPos.timestamp).getTime();
            const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
            speedKts = timeDiffHours > 0 ? distanceNM / timeDiffHours : 0;

            // SPEED SANITY: 3 layers
            //   Layer 1: hard cap (100kn) — drop the entry, the spike's
            //     coordinates would still hop the polyline if we saved.
            //   Layer 2: acceleration gate — beyond a 50 kn delta
            //     between consecutive fixes is GPS-teleport territory
            //     (a Tesla launch hits ~13 kn/sec = 65 kn/5s — under,
            //     but barely; real spikes are 500+ kn deltas, well over).
            //   Layer 3: ignore speed when prev pos was the 0,0
            //     placeholder from captureImmediate (no real reference).
            if (lastPos.latitude === 0 && lastPos.longitude === 0) {
                speedKts = 0;
            } else if (speedKts > MAX_PLAUSIBLE_SPEED_KTS) {
                log.warn(
                    `Speed spike rejected: ${speedKts.toFixed(1)}kn > ${MAX_PLAUSIBLE_SPEED_KTS}kn cap — dropping entry`,
                );
                return null;
            } else if (lastPos.speedKts !== undefined && lastPos.speedKts >= 0) {
                const accel = speedKts - lastPos.speedKts;
                if (accel > MAX_ACCELERATION_KTS) {
                    log.warn(
                        `Acceleration spike rejected: +${accel.toFixed(1)}kn jump (${lastPos.speedKts.toFixed(1)} → ${speedKts.toFixed(1)}) — dropping entry`,
                    );
                    return null;
                }
            }

            cumulativeDistanceNM = lastPos.cumulativeDistanceNM + distanceNM;

            if (distanceNM >= STATIONARY_THRESHOLD_NM) {
                ctx.trackingState.lastMovementTime = timestamp;
                await ctx.saveTrackingState();
            }
        }

        const weatherSnapshot = getWeatherSnapshot();

        // COG: GPS heading first, fallback to bearing-from-prev-pos
        // (only if actually moved; otherwise courseDeg stays undefined).
        let courseDeg: number | undefined;
        if (heading !== null && heading !== undefined) {
            courseDeg = Math.round(heading);
        } else if (lastPos && distanceNM >= STATIONARY_THRESHOLD_NM) {
            courseDeg = Math.round(calculateBearing(lastPos.latitude, lastPos.longitude, latitude, longitude));
        }

        // ROLLING WAYPOINT LIFECYCLE: every new auto entry is promoted
        // to a waypoint ('Latest Position'); the previous auto-promoted
        // waypoint is demoted back to 'auto'. Turn waypoints, manual
        // entries, and user-placed waypoints are never demoted.
        const effectiveEntryType: EntryType = entryType === 'auto' ? 'waypoint' : entryType;
        const effectiveWaypointName = entryType === 'auto' ? 'Latest Position' : waypointName;

        if (entryType === 'auto') {
            demotePreviousAutoWaypoint(entryVoyageId).catch(() => {
                /* best effort */
            });
        }

        // Engine state: an explicit per-call override wins; otherwise auto
        // entries inherit the voyage's user-set engine state (sticky in
        // trackingState) so the sail/motor split has real data. undefined
        // until the user first declares it — never guessed.
        const effectiveEngineStatus: EngineStatus | undefined =
            engineStatus ??
            (entryType === 'auto' && ctx.trackingState.engineRunning !== undefined
                ? ctx.trackingState.engineRunning
                    ? 'running'
                    : 'stopped'
                : undefined);

        const entry: Partial<ShipLogEntry> = {
            voyageId: entryVoyageId,
            timestamp,
            latitude,
            longitude,
            positionFormatted: formatPositionDMS(latitude, longitude),
            distanceNM: Math.round(distanceNM * 100) / 100,
            cumulativeDistanceNM: Math.round(cumulativeDistanceNM * 100) / 100,
            speedKts: Math.round(speedKts * 10) / 10,
            courseDeg,
            ...weatherSnapshot,
            entryType: effectiveEntryType,
            eventCategory,
            engineStatus: effectiveEngineStatus,
            notes,
            waypointName: effectiveWaypointName,
            isOnWater: ctx.getLastWaterStatus(),
        };

        const { saved } = await saveEntryOnlineOrOffline(entry);

        // Turn pins never advance the delta reference — their position
        // is BEHIND the boat, and anchoring lastPos there would measure
        // the next real fix against the past (phantom distance + a
        // corrupted speed/acceleration gate).
        if (!isPinOverride) {
            await saveLastPosition({
                latitude,
                longitude,
                timestamp,
                cumulativeDistanceNM,
                speedKts,
                voyageId: entryVoyageId,
            });
        }

        // Pins carry a backdated timestamp — rewinding lastEntryTime to
        // it would distort the heartbeat's elapsed check and the snap
        // clamp's monotonic reference.
        if (!isPinOverride) {
            ctx.trackingState.lastEntryTime = timestamp;
        }
        ctx.trackingState.lastCheckTime = Date.now();
        ctx.trackingState.lastCheckDeduped = false;
        await ctx.saveTrackingState();

        // Re-evaluate adaptive interval (fire-and-forget).
        ctx.rescheduleAdaptiveInterval().catch((err) => {
            log.warn('captureLog: adaptive reschedule failed', err);
        });

        return saved ?? (entry as ShipLogEntry);
    } catch (error) {
        log.error('captureLog failed', error);
        return null;
    }
}

// ── addManual ───────────────────────────────────────────────────────

export interface AddManualOptions {
    notes?: string;
    waypointName?: string;
    eventCategory?: EventCategory;
    engineStatus?: EngineStatus;
    voyageId?: string;
}

/**
 * User-initiated entry. Creates the entry immediately so the UI
 * updates without blocking on GPS — if a fresh fix is in the cache it
 * gets stamped, otherwise the entry persists with placeholder coords
 * (no background retry — the user knows what their position was when
 * they tapped the button).
 *
 * Returns null if there's no active voyage. The pipeline never
 * implicitly creates a voyage; the caller (LogPage) walks the user
 * through "Start tracking first" UX.
 */
export async function addManual(ctx: CaptureContext, opts: AddManualOptions = {}): Promise<ShipLogEntry | null> {
    const { notes, waypointName, eventCategory, engineStatus, voyageId } = opts;
    const timestamp = new Date().toISOString();
    const entryType: EntryType = waypointName ? 'waypoint' : 'manual';

    const effectiveVoyageId = voyageId || ctx.trackingState.currentVoyageId;
    if (!effectiveVoyageId) return null;

    const weatherSnapshot = getWeatherSnapshot();

    const entry: Partial<ShipLogEntry> = {
        voyageId: effectiveVoyageId,
        timestamp,
        latitude: 0,
        longitude: 0,
        positionFormatted: 'Acquiring position...',
        distanceNM: 0,
        cumulativeDistanceNM: 0,
        speedKts: 0,
        ...weatherSnapshot,
        entryType,
        eventCategory,
        engineStatus,
        notes,
        waypointName,
    };

    try {
        const bestPos = await getBestPosition(ctx.getCachedFix(), ctx.isNative);
        if (bestPos) {
            const { latitude, longitude, heading } = bestPos;
            entry.latitude = latitude;
            entry.longitude = longitude;
            entry.positionFormatted = formatPositionDMS(latitude, longitude);

            if (heading !== null && heading !== undefined && heading !== 0) {
                entry.courseDeg = Math.round(heading);
            }

            const lastPos = await getLastPosition();
            // Only delta against a position from THIS voyage (missing
            // voyageId = legacy data written mid-voyage — still valid).
            if (lastPos && (lastPos.voyageId === undefined || lastPos.voyageId === effectiveVoyageId)) {
                const distanceNM = calculateDistanceNM(lastPos.latitude, lastPos.longitude, latitude, longitude);
                entry.distanceNM = Math.round(distanceNM * 100) / 100;
                entry.cumulativeDistanceNM = Math.round((lastPos.cumulativeDistanceNM + distanceNM) * 100) / 100;
            }

            await saveLastPosition({
                latitude,
                longitude,
                timestamp,
                cumulativeDistanceNM: entry.cumulativeDistanceNM || 0,
                voyageId: effectiveVoyageId,
            });
        }
    } catch (gpsError) {
        log.warn('addManual: GPS failed, using placeholder', gpsError);
    }

    const { saved } = await saveEntryOnlineOrOffline(entry);
    return saved ?? (entry as ShipLogEntry);
}

// ── flushBufferedTrack ─────────────────────────────────────────────

/**
 * Drains the high-frequency GPS buffer, RDP-thins, and logs each
 * significant point. Wired into the AdaptiveScheduler as the onTick
 * callback.
 */
// Re-entrancy latch: the scheduler tick and the heartbeat catch-up can
// both call flushBufferedTrack; two interleaved drains would split one
// batch across two out-of-order replay loops.
let isFlushing = false;

export async function flushBufferedTrack(ctx: CaptureContext): Promise<void> {
    if (!ctx.trackingState.isTracking || ctx.trackingState.isPaused) return;
    if (isFlushing) return;
    isFlushing = true;
    try {
        await flushBufferedTrackInner(ctx);
    } finally {
        isFlushing = false;
    }
}

async function flushBufferedTrackInner(ctx: CaptureContext): Promise<void> {
    const rawPoints = ctx.trackBuffer.drain();

    // Empty buffer → fall back to single capture (heartbeat catch-up).
    if (rawPoints.length === 0) {
        await captureLog(ctx);
        return;
    }

    // 2026-05-19: log every raw point — no RDP, no thinTrack. Shane's
    // policy after the driving-speed disaster: 5 s cadence with full
    // retention beats sub-second cadence with smart culling, because
    // the cull was overly aggressive on straight high-speed legs. The
    // BgGeo 1 m distanceFilter already removes stationary jitter at
    // ingest. CourseChangeDetector still emits the visible turn pins
    // at 30°+ — that pipeline is independent of track storage.
    //
    // 2026-06-12: each buffered point now travels as an explicit
    // fixOverride. The old setCachedFix + getBestPosition route let a
    // live NMEA fix (always preferred) or the 60 s receivedAt check
    // replace HISTORICAL points with the current position — early-batch
    // points teleported to the flush location (zig-zag). It also left
    // lastBgLocation pinned to a stale replay point after the loop;
    // the live cache now stays live.
    for (const pos of rawPoints) {
        await captureLog(ctx, { skipDedup: true, fixOverride: pos });
    }
}
