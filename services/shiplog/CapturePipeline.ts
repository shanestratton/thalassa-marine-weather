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
import { createLogger } from '../../utils/logger';
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
const MAX_PLAUSIBLE_SPEED_KTS = 25;
const MAX_ACCELERATION_KTS = 8;

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
    const timestamp = new Date().toISOString();
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

    // GPS COLD-START WARM-UP. If no cached fix is fresh, do a single
    // 500ms wait for the onLocation stream to produce one. If that
    // also misses, fall back to a blocking getCurrentPosition.
    let needsGpsRetry = false;
    const GPS_WARMUP_DELAY_MS = 500;
    let bestPos = ctx.getCachedFix();
    if (!bestPos || Date.now() - bestPos.receivedAt > GPS_STALE_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, GPS_WARMUP_DELAY_MS));
        bestPos = ctx.getCachedFix();
        if (!bestPos || Date.now() - bestPos.receivedAt >= GPS_STALE_LIMIT_MS) {
            // Final fallback — blocking fresh fetch.
            bestPos = ctx.isNative
                ? await BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 10)
                : await webGetFreshPosition();
        }
    }

    if (bestPos && Date.now() - bestPos.receivedAt < GPS_STALE_LIMIT_MS) {
        entry.latitude = bestPos.latitude;
        entry.longitude = bestPos.longitude;
        entry.positionFormatted = formatPositionDMS(bestPos.latitude, bestPos.longitude);

        if (bestPos.heading !== null && bestPos.heading !== undefined && bestPos.heading !== 0) {
            entry.courseDeg = Math.round(bestPos.heading);
        }

        await saveLastPosition({
            latitude: bestPos.latitude,
            longitude: bestPos.longitude,
            timestamp,
            cumulativeDistanceNM: 0,
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
}

/**
 * Core logging path. Computes deltas vs last saved position, applies
 * sanity gates, persists, and asks the scheduler to re-evaluate the
 * adaptive interval.
 */
export async function captureLog(ctx: CaptureContext, opts: CaptureLogOptions = {}): Promise<ShipLogEntry | null> {
    const { entryType = 'auto', notes, waypointName, eventCategory, engineStatus, voyageId, skipDedup } = opts;

    try {
        const bestPos = await getBestPosition(ctx.getCachedFix(), ctx.isNative);
        if (!bestPos) {
            // No GPS — skip this auto entry (will retry on next tick).
            // Manual entries can proceed with zero position.
            if (entryType === 'auto') return null;
        }

        const latitude = bestPos?.latitude ?? 0;
        const longitude = bestPos?.longitude ?? 0;
        const heading = bestPos?.heading ?? null;

        // Quarter-hour timestamp snap for offshore auto entries (rapid
        // mode + nearshore/coastal use shorter intervals so keep exact ts).
        const entryTime = new Date(bestPos?.timestamp ?? Date.now());
        const isOffshoreMode = !ctx.trackingState.isRapidMode && ctx.trackingState.loggingZone === 'offshore';
        if (entryType === 'auto' && isOffshoreMode) {
            const minutes = entryTime.getMinutes();
            const nearestQuarter = Math.round(minutes / 15) * 15;
            entryTime.setMinutes(nearestQuarter, 0, 0);
            if (nearestQuarter === 60) {
                entryTime.setHours(entryTime.getHours() + 1);
                entryTime.setMinutes(0, 0, 0);
            }
        }
        const timestamp = entryTime.toISOString();

        const lastPos = await getLastPosition();
        let distanceNM = 0;
        let speedKts = 0;
        let cumulativeDistanceNM = 0;

        if (lastPos) {
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
            //   Layer 1: hard cap (25kn) — drop the entry, the spike's
            //     coordinates would still hop the polyline if we saved.
            //   Layer 2: acceleration gate — even a fast cat doesn't
            //     accelerate 8+kn between fixes.
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
            demotePreviousAutoWaypoint(voyageId || ctx.trackingState.currentVoyageId || '').catch(() => {
                /* best effort */
            });
        }

        const entry: Partial<ShipLogEntry> = {
            voyageId: voyageId || ctx.trackingState.currentVoyageId || `voyage_${Date.now()}`,
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
            engineStatus,
            notes,
            waypointName: effectiveWaypointName,
            isOnWater: ctx.getLastWaterStatus(),
        };

        const { saved } = await saveEntryOnlineOrOffline(entry);

        await saveLastPosition({
            latitude,
            longitude,
            timestamp,
            cumulativeDistanceNM,
            speedKts,
        });

        ctx.trackingState.lastEntryTime = timestamp;
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
            if (lastPos) {
                const distanceNM = calculateDistanceNM(lastPos.latitude, lastPos.longitude, latitude, longitude);
                entry.distanceNM = Math.round(distanceNM * 100) / 100;
                entry.cumulativeDistanceNM = Math.round((lastPos.cumulativeDistanceNM + distanceNM) * 100) / 100;
            }

            await saveLastPosition({
                latitude,
                longitude,
                timestamp,
                cumulativeDistanceNM: entry.cumulativeDistanceNM || 0,
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
export async function flushBufferedTrack(ctx: CaptureContext): Promise<void> {
    if (!ctx.trackingState.isTracking || ctx.trackingState.isPaused) return;

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
    for (const pos of rawPoints) {
        ctx.setCachedFix(pos);
        await captureLog(ctx, { skipDedup: true });
    }
}
