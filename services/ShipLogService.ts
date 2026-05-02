/**
 * @filesize-justified Service class with 6 sub-modules (shiplog/helpers, EntrySave, OfflineQueue, EntryCrud, GpsTrackBuffer, waterDetection). Core orchestrator cannot be further decomposed.
 */
/**
 * Ship's Log Service
 * Automatic GPS-based logging for maritime navigation
 *
 * Features:
 * - 15-minute automatic position tracking
 * - Distance/speed calculations (Haversine formula)
 * - Weather snapshots per entry
 * - Auto-pause when anchored (no movement for 1 hour)
 * - Manual entry support
 *
 * GPS Engine: @transistorsoft/capacitor-background-geolocation (Premium)
 * - Bulletproof background tracking (survives app kill, screen lock)
 * - Native SQLite persistence (zero data loss on crash)
 * - Battery-conscious motion detection
 * - Works with screen locked, app backgrounded, or terminated
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { ShipLogEntry } from '../types';
import { BgGeoManager, CachedPosition } from './BgGeoManager';
import { EnvironmentService } from './EnvironmentService';
import { createLogger } from '../utils/logger';

// --- Extracted modules ---
import {
    retryGpsAndUpdateEntry as _retryGpsAndUpdateEntry,
    demotePreviousAutoWaypoint as _demotePreviousAutoWaypoint,
} from './shiplog/EntrySave';
import { savePassagePlanToLogbook as _savePassagePlanToLogbook } from './shiplog/PassagePlanSave';
import {
    calculateDistanceNM,
    calculateBearing,
    formatPositionDMS,
    getWeatherSnapshot,
    determineLoggingZone,
    getIntervalForZone,
    getIntervalForSpeed,
    type LoggingZone,
} from './shiplog/helpers';
import { GpsTrackBuffer, thinTrack } from './shiplog/GpsTrackBuffer';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
import {
    loadTrackingState,
    saveTrackingState as _saveTrackingState,
    getLastPosition as _getLastPosition,
    saveLastPosition as _saveLastPosition,
    clearVoyageState as _clearVoyageState,
    type TrackingState,
    type StoredPosition,
} from './shiplog/TrackingStateStore';
import { CourseChangeDetector } from './shiplog/CourseChangeDetector';
import { EnvironmentPoller } from './shiplog/EnvironmentPoller';
import { AdaptiveScheduler } from './shiplog/AdaptiveScheduler';
import { GpsSubscriptionManager } from './shiplog/GpsSubscriptionManager';
import {
    getBestPosition as _getBestPosition,
    getGpsStatus as _getGpsStatus,
    getGpsNavData as _getGpsNavData,
} from './shiplog/PositionResolver';
import {
    queueOfflineEntry as _queueOfflineEntry,
    syncOfflineQueue as _syncOfflineQueue,
    getOfflineQueueCount as _getOfflineQueueCount,
    getOfflineEntries as _getOfflineEntries,
    deleteVoyageFromOfflineQueue as _deleteVoyageFromOfflineQueue,
    deleteEntryFromOfflineQueue as _deleteEntryFromOfflineQueue,
} from './shiplog/OfflineQueue';
import {
    getLogEntries as _getLogEntries,
    getArchivedEntries as _getArchivedEntries,
    getAllEntriesForCareer as _getAllEntriesForCareer,
    archiveVoyage as _archiveVoyage,
    unarchiveVoyage as _unarchiveVoyage,
    deleteVoyage as _deleteVoyage,
    deleteEntry as _deleteEntry,
    importGPXVoyage as _importGPXVoyage,
} from './shiplog/EntryCrud';
import { checkIsOnWater } from './shiplog/waterDetection';

const log = createLogger('ShipLog');

// Save-or-queue + web GPS fresh-fetch live in shiplog/EntrySave.ts.
import { webGetFreshPosition, saveEntryOnlineOrOffline } from './shiplog/EntrySave';

// Staleness threshold: if cached GPS is older than this, fetch fresh
const GPS_STALE_LIMIT_MS = 60_000; // 60 seconds

// --- CONSTANTS ---
const TRACKING_INTERVAL_MS = 60 * 1000; // 60 seconds (fallback / offshore default)
const RAPID_INTERVAL_MS = 10 * 1000; // 10 seconds for marina/shore navigation (manual override)
const STATIONARY_THRESHOLD_NM = 0.05; // Less than 0.05nm movement = anchored

const DEDUP_THRESHOLD_NM = 0.005; // ~10 meters — discard auto entry if vessel hasn't moved
const VOYAGE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours — start new voyage instead of resuming

// --- SPEED SANITY ---
// Hard cap: 25 knots is generous for any sailing yacht (most top out at 8-12).
// GPS spikes routinely report 20-30kn jumps; this catches them.
const MAX_PLAUSIBLE_SPEED_KTS = 25;

// Acceleration gate: reject if speed jumps more than this between consecutive fixes.
// Even a fast cat going from 0 to hull speed takes tens of seconds, not one GPS fix.
const MAX_ACCELERATION_KTS = 8; // Max knot increase per fix interval

// Storage keys + interfaces moved to ./shiplog/TrackingStateStore.ts.
// `TrackingState` and `StoredPosition` types are re-imported above.

// Helper functions, DB mapping, weather snapshot, and zone detection
// are now in ./shiplog/helpers.ts — imported above.

// --- MAIN SERVICE CLASS ---

class ShipLogServiceClass {
    // Platform detection: native (iOS/Android) uses Transistorsoft BgGeo;
    // web uses navigator.geolocation + setInterval fallbacks.
    private readonly isNative = Capacitor.isNativePlatform();
    // Tick scheduling lives in AdaptiveScheduler — it owns the
    // alignment-timeout + recurring-interval pair and exposes isRunning().
    private scheduler = new AdaptiveScheduler();
    private syncIntervalId?: NodeJS.Timeout;
    private rapidModeTimeoutId?: NodeJS.Timeout; // 15-minute auto-disable for rapid mode
    // (envCheckIntervalId moved into EnvironmentPoller — see this.envPoller below)
    // GPS subscriptions, fix-acceptance gate, speed-tier debounce, and
    // heartbeat all live in GpsSubscriptionManager.
    private gpsSubs = new GpsSubscriptionManager();
    private trackingState: TrackingState = { isTracking: false, isPaused: false, isRapidMode: false };

    // Cached water detection status — updated every 60s by environment polling.
    // Stamped onto every log entry so career totals can filter out land tracks.
    private lastWaterStatus: boolean | undefined = undefined;

    // --- BATTLE-HARDENED GPS STREAMING ---
    // onLocation continuously caches the latest position. Timers decide WHEN to log,
    // but never block on getCurrentPosition. This survives background, suspension,
    // and cold starts — the position is always available. The GpsSubscriptionManager
    // keeps this in sync via its `onFix` callback.
    private lastBgLocation: CachedPosition | null = null;

    // --- HIGH-FREQUENCY GPS BUFFER ---
    // Captures every GPS fix at device rate (1–10 Hz). On each interval tick,
    // the buffer is drained and RDP-thinned to keep only significant points.
    private trackBuffer = new GpsTrackBuffer();

    // --- POSITION-BASED COURSE CHANGE DETECTION ---
    // Implementation lives in ./shiplog/CourseChangeDetector.ts. This
    // orchestrator just owns the instance and wires the callbacks.
    private courseDetector = new CourseChangeDetector();

    // --- 60s ENVIRONMENT POLLING ---
    // Implementation lives in ./shiplog/EnvironmentPoller.ts. Same pattern.
    private envPoller = new EnvironmentPoller();

    /**
     * Initialize the ship log service. Sets up GPS listeners, app lifecycle
     * handlers, and restores persisted tracking state from Preferences.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    async initialize(): Promise<void> {
        try {
            const persisted = await loadTrackingState();
            if (persisted) {
                this.trackingState = persisted;

                // STALE STATE DETECTION: If tracking was left on from a previous app session
                // but no interval is running (scheduler is idle on cold start),
                // this means the app was force-closed while tracking.
                //
                // Behavior depends on autoTrackEnabled:
                // - OFF: Reset to stopped state so the Start button shows correctly.
                // - ON:  Auto-resume the voyage (handled by autoStartIfEnabled called from App.tsx)
                //
                // IMPORTANT: When navigating between pages within an active session,
                // the scheduler IS running, so this won't affect active tracking.
                if (this.trackingState.isTracking && !this.trackingState.isPaused && !this.scheduler.isRunning()) {
                    // Mark as stopped — autoStartIfEnabled() will restart if setting is on
                    this.trackingState = {
                        isTracking: false,
                        isPaused: false,
                        isRapidMode: false,
                        // Preserve voyage info so autoStartIfEnabled can decide to resume or start fresh
                        currentVoyageId: this.trackingState.currentVoyageId,
                        voyageStartTime: this.trackingState.voyageStartTime,
                        voyageEndTime: this.trackingState.voyageEndTime || new Date().toISOString(),
                    };
                    await this.saveTrackingState();
                }
            }

            // Start sync interval to process offline queue
            this.startSyncInterval();

            // Try initial sync
            await this.syncOfflineQueue();

            // BACKGROUND RESUME HANDLER: Catch up on missed entries when app wakes up
            // Uses Capacitor App listener for native iOS/Android
            App.addListener('appStateChange', async ({ isActive }) => {
                if (isActive && this.trackingState.isTracking && !this.trackingState.isPaused) {
                    await this.checkMissedEntries();
                }
            });

            // WEB FALLBACK: Also listen for browser visibility changes (for PWA/web)
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', async () => {
                    if (
                        document.visibilityState === 'visible' &&
                        this.trackingState.isTracking &&
                        !this.trackingState.isPaused
                    ) {
                        await this.checkMissedEntries();
                    }
                });
            }
        } catch (error) {
            log.error('initialize failed', error);
        }
    }

    /**
     * Automatically resume tracking if the user has auto-track enabled
     * and there's a non-stale voyage in progress.
     * @param autoTrackEnabled - Whether the user's settings allow auto-tracking
     */
    async autoStartIfEnabled(autoTrackEnabled: boolean): Promise<void> {
        if (!autoTrackEnabled) return;
        if (this.trackingState.isTracking) return;

        const lastVoyageEnd = this.trackingState.voyageEndTime;
        const lastVoyageId = this.trackingState.currentVoyageId;

        if (lastVoyageEnd && lastVoyageId) {
            const elapsed = Date.now() - new Date(lastVoyageEnd).getTime();
            if (elapsed < VOYAGE_STALE_THRESHOLD_MS) {
                // Recent voyage — resume it
                await this.startTracking(true, lastVoyageId);
                return;
            }
        }

        // No recent voyage or too stale — start fresh
        await this.startTracking(false);
    }

    /**
     * Check if any quarter-hour entries were missed while backgrounded and catch up
     */
    private async checkMissedEntries(): Promise<void> {
        if (!this.trackingState.lastEntryTime) return;

        const lastEntry = new Date(this.trackingState.lastEntryTime);
        const now = new Date();
        const msSinceLast = now.getTime() - lastEntry.getTime();

        // If more than 15 minutes since last entry, we missed at least one
        if (msSinceLast >= TRACKING_INTERVAL_MS) {
            const _missedCount = Math.floor(msSinceLast / TRACKING_INTERVAL_MS);

            // Capture ONE entry now (at current time, not backdated)
            // We don't backfill because GPS data from the past isn't available
            try {
                const entry = await this.captureLogEntry();
                if (entry) {
                    log.info('checkMissedEntries: catch-up entry saved');
                }
            } catch (err: unknown) {
                log.error('checkMissedEntries: catch-up entry failed', err);
            }
        }

        // Reschedule to next quarter-hour
        this.rescheduleAdaptiveInterval();
    }

    /**
     * Reschedule the logging interval based on current speed (primary)
     * or shore proximity (fallback).
     * Called after each GPS fix and from environment polling.
     * Does NOT apply when rapid mode is active.
     *
     * Timer ownership lives in `this.scheduler` (AdaptiveScheduler).
     * This method just decides the new `intervalMs` and asks the
     * scheduler to align to it.
     */
    private async rescheduleAdaptiveInterval(): Promise<void> {
        // Don't interfere with rapid mode
        if (this.trackingState.isRapidMode) return;
        if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

        // PRIMARY: Speed-adaptive interval (if we have GPS speed)
        const pos = this.lastBgLocation;
        if (pos && pos.speed != null && pos.speed >= 0) {
            const { interval } = getIntervalForSpeed(pos.speed);
            const currentInterval = this.trackingState.currentIntervalMs;

            // Only reschedule if interval actually changed
            if (interval !== currentInterval || !this.scheduler.isRunning()) {
                this.trackingState.currentIntervalMs = interval;
                this.trackingState.loggingZone = undefined; // Speed-based, not zone-based
                await this.saveTrackingState();
                this.scheduler.scheduleClockAligned(interval, () => this.flushBufferedTrack());
            }
            return;
        }

        // FALLBACK: Zone-based interval (no speed data yet — cold start)
        const newZone = determineLoggingZone();
        const newInterval = getIntervalForZone(newZone);
        const oldZone = this.trackingState.loggingZone || 'offshore';

        // Only reschedule if zone actually changed
        if (newZone === oldZone && this.scheduler.isRunning()) return;

        // Update state
        this.trackingState.loggingZone = newZone;
        this.trackingState.currentIntervalMs = newInterval;
        await this.saveTrackingState();

        // Use clock-aligned scheduling
        this.scheduler.scheduleClockAligned(newInterval, () => this.flushBufferedTrack());
    }

    /**
     * Begin GPS tracking for a new or resumed voyage.
     * Creates a voyage ID, aligns to the next quarter-hour, and starts
     * the position logging interval. On native, activates background GPS
     * via Transistorsoft; on web, uses navigator.geolocation.watchPosition.
     * @param resume - If true, continues the current voyage rather than starting fresh
     * @param continueVoyageId - Optional voyage ID to resume (e.g. after app restart)
     */
    async startTracking(resume: boolean = false, continueVoyageId?: string): Promise<void> {
        if (this.trackingState.isTracking) {
            return;
        }

        // Initialize GPS engine (native-only: Transistorsoft BgGeo).
        // On web, GPS is started via navigator.geolocation in gpsSubs.start().
        if (this.isNative) {
            await BgGeoManager.ensureReady();
            await BgGeoManager.requestStart();
        }

        // GPS engine confirmed running — NOW commit tracking state.
        // Determine voyage ID:
        // 1. If continueVoyageId is provided, use that
        // 2. If resume and currentVoyageId exists, use that
        // 3. Otherwise, generate new
        let voyageId: string;
        if (continueVoyageId) {
            voyageId = continueVoyageId;
        } else if (resume && this.trackingState.currentVoyageId) {
            voyageId = this.trackingState.currentVoyageId;
        } else {
            voyageId = `voyage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        this.trackingState = {
            isTracking: true,
            isPaused: false,
            isRapidMode: false, // Start in normal mode, user can activate rapid via long-press
            currentVoyageId: voyageId,
            voyageStartTime: resume || continueVoyageId ? this.trackingState.voyageStartTime : new Date().toISOString(),
            lastMovementTime: new Date().toISOString(),
        };

        await this.saveTrackingState();

        // --- BATTLE-HARDENED GPS STREAMING ---
        // Wire up continuous position caching + the speed-tier debounce +
        // fix-acceptance gate. The timer decides WHEN to log; the
        // subscription manager ensures GPS is ALWAYS fresh.
        this.gpsSubs.start({
            isNative: this.isNative,
            trackBuffer: this.trackBuffer,
            isActive: () => this.trackingState.isTracking && !this.trackingState.isPaused,
            isRapidMode: () => this.trackingState.isRapidMode === true,
            getIntervalMs: () => this.trackingState.currentIntervalMs ?? TRACKING_INTERVAL_MS,
            getLastEntryTime: () => this.trackingState.lastEntryTime,
            onFix: (pos) => {
                this.lastBgLocation = pos;
            },
            onSpeedTierChanged: () => {
                this.rescheduleAdaptiveInterval().catch((e) => {
                    log.warn(``, e);
                });
            },
            onHeartbeatTick: () => {
                this.flushBufferedTrack().catch((e) => {
                    log.warn(``, e);
                });
            },
        });

        // IMMEDIATE ENTRY: Fire-and-forget — GPS acquisition runs in background
        // so the UI is not blocked by the 3s GPS warm-up loop.
        this.captureImmediateEntry().catch((e) => {
            log.warn(``, e);
        });

        // Reset position-based bearing tracker for new voyage
        this.courseDetector.reset();
        this.courseDetector.start({
            getPos: () => this.lastBgLocation,
            isActive: () => this.trackingState.isTracking && !this.trackingState.isPaused,
            onTurn: ({ oldCardinal, newCardinal }) => {
                // Fire-and-forget waypoint entry on detected turn.
                this.captureLogEntry(
                    'waypoint',
                    `Auto: COG ${oldCardinal} → ${newCardinal}`,
                    `COG ${oldCardinal} → ${newCardinal}`,
                    'navigation',
                ).catch(() => {
                    /* best effort */
                });
            },
        });

        // ADAPTIVE SCHEDULING: Always start at nearshore (30s) — the safest default.
        // rescheduleAdaptiveInterval() runs after every GPS fix and will refine the
        // zone once weather-cache data is available (e.g. coastal → 2min, offshore → 15min).
        const initialZone: LoggingZone = 'nearshore';
        const initialInterval = getIntervalForZone(initialZone);
        this.trackingState.loggingZone = initialZone;
        this.trackingState.currentIntervalMs = initialInterval;
        await this.saveTrackingState();

        // Schedule clock-aligned entries (30s → fires at xx:xx:00, xx:xx:30)
        this.scheduler.scheduleClockAligned(initialInterval, () => this.flushBufferedTrack());

        // Kick off async zone refinement in the background — won't block UI
        this.rescheduleAdaptiveInterval().catch((e) => {
            log.warn(``, e);
        });

        // --- 60-SECOND ENVIRONMENT POLLING ---
        // Checks water/land status and re-evaluates logging zone every minute.
        // This lets GPS interval adapt faster when transitioning environments
        // (e.g. leaving marina → offshore, or driving from land to coast).
        this.envPoller.start({
            getPos: () => this.lastBgLocation,
            isActive: () => this.trackingState.isTracking && !this.trackingState.isPaused,
            onWaterStatus: (isWater) => {
                // Cache for stamping onto subsequent log entries.
                this.lastWaterStatus = isWater;
                // Update EnvironmentService for UI consumers.
                EnvironmentService.updateWaterStatus(isWater);
            },
            onZoneRecheck: () => this.rescheduleAdaptiveInterval(),
        });
    }

    // Fix-acceptance gate, GPS subscription wiring, NMEA ingest, heartbeat,
    // speed-tier debounce, cold-start warm-up, and cleanup all moved to
    // ./shiplog/GpsSubscriptionManager.ts. The orchestrator just owns
    // `lastBgLocation` (updated via the manager's `onFix` callback).
    //
    // startCourseChangeDetection moved to ./shiplog/CourseChangeDetector.ts.

    // GPS resolution moved to ./shiplog/PositionResolver.ts. The
    // orchestrator owns `lastBgLocation` and `isNative` and forwards them
    // through these one-line delegates. `_webGetFreshPosition` (the
    // duplicated copy of EntrySave.webGetFreshPosition) is gone.

    private getBestPosition(): Promise<CachedPosition | null> {
        return _getBestPosition(this.lastBgLocation, this.isNative);
    }

    getGpsStatus(): 'locked' | 'stale' | 'none' {
        return _getGpsStatus(this.lastBgLocation, this.isNative);
    }

    getGpsNavData(): { sogKts: number | null; cogDeg: number | null } {
        return _getGpsNavData(this.lastBgLocation, this.isNative);
    }

    /**
     * Pause tracking (user initiated)
     */
    async pauseTracking(): Promise<void> {
        this.scheduler.stop();

        // Stop course change detection + environment polling while paused
        this.courseDetector.stop();
        this.envPoller.stop();

        // Clear GPS buffer — no points to log while paused
        this.trackBuffer.clear();

        // Clean up GPS subscriptions to save battery while paused
        this.gpsSubs.stop();

        this.trackingState.isTracking = false;
        this.trackingState.isPaused = true;
        await this.saveTrackingState();
    }

    /**
     * Stop tracking and end voyage
     * Responds instantly - final entry capture happens in background
     */
    async stopTracking(): Promise<void> {
        this.scheduler.stop();

        // Flush any remaining buffered GPS points before stopping
        try {
            await this.flushBufferedTrack();
        } catch (e) {
            log.warn('[ShipLog] best effort:', e);
        }
        this.trackBuffer.clear();
        // Update state immediately so UI responds instantly
        // IMPORTANT: Store end time now (before async ops) to ensure it's always recorded
        const previousVoyageId = this.trackingState.currentVoyageId;
        const voyageEndTime = new Date().toISOString();

        this.trackingState = {
            isTracking: false,
            isPaused: false,
            isRapidMode: false,
            // Preserve voyage info for reference
            currentVoyageId: previousVoyageId,
            voyageStartTime: this.trackingState.voyageStartTime,
            voyageEndTime: voyageEndTime,
        };
        await this.saveTrackingState();

        // Reset course change detection + stop the timers
        this.courseDetector.stop();
        this.courseDetector.reset();
        this.envPoller.stop();

        // Reset precision GPS tracker for next voyage
        GpsPrecision.reset();

        // Capture final entry BEFORE cleaning up GPS — ensures end coordinates are captured
        // GPS subscriptions are still alive here so getBestPosition() can use cached fix
        await this.captureImmediateEntry(previousVoyageId, 'Voyage End').catch((err) => {
            log.warn(``, err);
        });

        // NOW clean up GPS stream subscriptions (after final entry has GPS)
        this.gpsSubs.stop();

        // Clear voyage-scoped persistence (last-position + legacy voyage-start key).
        await _clearVoyageState();

        // Stop Transistorsoft background tracking (ref-counted — only stops if no other consumer)
        if (this.isNative) {
            await BgGeoManager.requestStop();
        }
    }

    /**
     * Create an immediate log entry without waiting for GPS
     * The entry is created instantly with timestamp, GPS position is fetched async
     * This ensures the card appears in the UI immediately
     */
    async captureImmediateEntry(
        voyageId?: string,
        waypointLabel: string = 'Voyage Start',
    ): Promise<ShipLogEntry | null> {
        const timestamp = new Date().toISOString();
        const effectiveVoyageId = voyageId || this.trackingState.currentVoyageId || `voyage_${Date.now()}`;

        // Get weather snapshot (SYNC — instant from localStorage)
        const weatherSnapshot = getWeatherSnapshot();

        // Create entry immediately with placeholder position
        // First entry in a voyage is always a waypoint ('Voyage Start')
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

        // Flag to track if GPS failed and needs background retry
        let needsGpsRetry = false;

        // COLD START WARM-UP: If no cached GPS fix yet, wait briefly for the first one
        // Single fast check — background retry handles late fixes
        const GPS_WARMUP_ATTEMPTS = 1;
        const GPS_WARMUP_DELAY_MS = 500;

        let bestPos = this.lastBgLocation;
        if (!bestPos || Date.now() - bestPos.receivedAt > GPS_STALE_LIMIT_MS) {
            // No fresh cached position — try warm-up loop
            for (let i = 0; i < GPS_WARMUP_ATTEMPTS; i++) {
                await new Promise((resolve) => setTimeout(resolve, GPS_WARMUP_DELAY_MS));
                bestPos = this.lastBgLocation;
                if (bestPos && Date.now() - bestPos.receivedAt < GPS_STALE_LIMIT_MS) {
                    break; // Got a fresh fix
                }
                // Also try getCurrentPosition as a final fallback on last attempt
                if (i === GPS_WARMUP_ATTEMPTS - 1) {
                    bestPos = this.isNative
                        ? await BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 10)
                        : await webGetFreshPosition();
                }
            }
        }

        if (bestPos && Date.now() - bestPos.receivedAt < GPS_STALE_LIMIT_MS) {
            entry.latitude = bestPos.latitude;
            entry.longitude = bestPos.longitude;
            entry.positionFormatted = formatPositionDMS(bestPos.latitude, bestPos.longitude);

            if (bestPos.heading !== null && bestPos.heading !== undefined && bestPos.heading !== 0) {
                entry.courseDeg = Math.round(bestPos.heading);
            }

            // Update last position
            await this.saveLastPosition({
                latitude: bestPos.latitude,
                longitude: bestPos.longitude,
                timestamp,
                cumulativeDistanceNM: 0,
            });

            // On-water check (fire-and-forget, fail-open)
            try {
                entry.isOnWater = await checkIsOnWater(bestPos.latitude, bestPos.longitude);
                this.lastWaterStatus = entry.isOnWater; // Seed cache for subsequent entries
            } catch (e) {
                log.warn('[ShipLog]', e);
                entry.isOnWater = true; // Fail open
            }
        } else {
            // No GPS at all after warm-up — will retry in background
            needsGpsRetry = true;
        }

        // Save the entry (online or offline queue) via the consolidated
        // helper in EntrySave.ts. Eliminates the 3-way duplicate save-or-
        // queue block that used to live here, in captureLogEntry, and in
        // addManualEntry.
        const { saved, entryId, wasOffline } = await saveEntryOnlineOrOffline(entry);
        // If GPS failed initially and we DID persist online, retry in background
        // so the entry's lat/lon backfills when GPS arrives.
        if (!wasOffline && needsGpsRetry && entryId) {
            this.retryGpsAndUpdateEntry(entryId);
        }

        // Track when this entry was created for background resume catch-up
        this.trackingState.lastEntryTime = timestamp;
        await this.saveTrackingState();

        // Online success returns the DB-hydrated entry (with id); offline
        // path falls through with the in-memory entry shape.
        return saved ?? (entry as ShipLogEntry);
    }

    /**
     * Background GPS retry - attempts to get GPS position and update a saved entry
     * Retries every 5 seconds for up to 30 seconds total
     */
    /** Delegate to extracted module */
    private async retryGpsAndUpdateEntry(entryId: string): Promise<void> {
        return _retryGpsAndUpdateEntry(entryId);
    }

    /** Delegate to extracted module */
    private async demotePreviousAutoWaypoint(voyageId: string): Promise<void> {
        return _demotePreviousAutoWaypoint(voyageId);
    }

    /**
     * Capture a single log entry
     * Auto-pause detection: If vessel hasn't moved >0.05nm in 1 hour, pause tracking
     */
    async captureLogEntry(
        entryType: 'auto' | 'manual' | 'waypoint' = 'auto',
        notes?: string,
        waypointName?: string,
        eventCategory?:
            | 'navigation'
            | 'weather'
            | 'equipment'
            | 'crew'
            | 'arrival'
            | 'departure'
            | 'safety'
            | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string,
        skipDedup?: boolean,
    ): Promise<ShipLogEntry | null> {
        try {
            // Get current position from cached onLocation stream (instant, no blocking)
            const bestPos = await this.getBestPosition();
            if (!bestPos) {
                // No GPS available — skip this auto entry, will retry on next tick
                if (entryType === 'auto') return null;
                // For manual entries, allow entry with zero position
            }

            const latitude = bestPos?.latitude ?? 0;
            const longitude = bestPos?.longitude ?? 0;
            const heading = bestPos?.heading ?? null;

            // For auto entries in OFFSHORE mode, snap timestamp to exact quarter hour (00, 15, 30, 45)
            // Nearshore/Coastal entries use shorter intervals so keep exact timestamps
            // Rapid mode entries also keep exact timestamps
            const entryTime = new Date(bestPos?.timestamp ?? Date.now());
            const isOffshoreMode = !this.trackingState.isRapidMode && this.trackingState.loggingZone === 'offshore';
            if (entryType === 'auto' && isOffshoreMode) {
                const minutes = entryTime.getMinutes();
                const nearestQuarter = Math.round(minutes / 15) * 15;
                entryTime.setMinutes(nearestQuarter, 0, 0); // Set to quarter hour with 0 seconds
                // Handle rollover (60 -> next hour)
                if (nearestQuarter === 60) {
                    entryTime.setHours(entryTime.getHours() + 1);
                    entryTime.setMinutes(0, 0, 0);
                }
            }
            const timestamp = entryTime.toISOString();

            // Get last position for distance calculation
            const lastPos = await this.getLastPosition();

            let distanceNM = 0;
            let speedKts = 0;
            let cumulativeDistanceNM = 0;

            if (lastPos) {
                // Calculate distance from last position
                distanceNM = calculateDistanceNM(lastPos.latitude, lastPos.longitude, latitude, longitude);

                // DEDUP FILTER: If this is an auto entry and the vessel hasn't moved
                // more than ~5 meters, discard it to avoid cluttering the logbook.
                // Record the check so the UI can show "Position unchanged" feedback.
                // SKIP when called from flushBufferedTrack — the RDP thinning already
                // provides superior context-aware filtering (turns, speed, gaps).
                if (!skipDedup && entryType === 'auto' && distanceNM < DEDUP_THRESHOLD_NM) {
                    this.trackingState.lastCheckTime = Date.now();
                    this.trackingState.lastCheckDeduped = true;
                    return null;
                }

                // Calculate speed (distance / time)
                const timeDiffMs = new Date(timestamp).getTime() - new Date(lastPos.timestamp).getTime();
                const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
                speedKts = timeDiffHours > 0 ? distanceNM / timeDiffHours : 0;

                // SPEED SANITY: Multi-layer GPS spike filtering.
                //
                // Layer 1: Hard cap — 25kn is generous for any sailing yacht.
                // GPS cold-start teleports and multi-path reflections routinely produce
                // 20-30kn phantom speeds. Anything above the cap is zeroed.
                //
                // Layer 2: Acceleration gate — reject implausible speed jumps.
                // Even under full sail, a yacht doesn't accelerate 8+ kts between
                // consecutive fixes. This catches GPS "teleport" fixes that the
                // warm-up filter missed (e.g., second stale fix at 2s mark).
                //
                // Layer 3: Ignore speed when previous position was the 0,0 placeholder
                // from captureImmediateEntry (no real previous fix to compare against).
                if (lastPos.latitude === 0 && lastPos.longitude === 0) {
                    speedKts = 0;
                } else if (speedKts > MAX_PLAUSIBLE_SPEED_KTS) {
                    // Drop the entry entirely — saving with zeroed stats but the
                    // spike's lat/lon would still hop the polyline. Bail.
                    log.warn(
                        `Speed spike rejected: ${speedKts.toFixed(1)}kn > ${MAX_PLAUSIBLE_SPEED_KTS}kn cap — dropping entry`,
                    );
                    return null;
                } else if (lastPos.speedKts !== undefined && lastPos.speedKts >= 0) {
                    const accel = speedKts - lastPos.speedKts;
                    if (accel > MAX_ACCELERATION_KTS) {
                        // Same logic — bail rather than save the spike's coordinates.
                        log.warn(
                            `Acceleration spike rejected: +${accel.toFixed(1)}kn jump (${lastPos.speedKts.toFixed(1)} → ${speedKts.toFixed(1)}) — dropping entry`,
                        );
                        return null;
                    }
                }

                cumulativeDistanceNM = lastPos.cumulativeDistanceNM + distanceNM;

                // Track last movement time (for analytics/stats)
                if (distanceNM >= STATIONARY_THRESHOLD_NM) {
                    this.trackingState.lastMovementTime = timestamp;
                    await this.saveTrackingState();
                }
            }

            // Get weather snapshot (SYNC — instant from localStorage)
            const weatherSnapshot = getWeatherSnapshot();

            // Calculate COG: Use GPS heading if available, otherwise calculate from position change
            let courseDeg: number | undefined;
            if (heading !== null && heading !== undefined) {
                // GPS provides heading directly
                courseDeg = Math.round(heading);
            } else if (lastPos && distanceNM >= STATIONARY_THRESHOLD_NM) {
                // Calculate bearing from previous position (only if actually moved)
                courseDeg = Math.round(calculateBearing(lastPos.latitude, lastPos.longitude, latitude, longitude));
            }
            // If stationary or no previous position, courseDeg stays undefined

            // ROLLING WAYPOINT LIFECYCLE:
            // Every new auto entry is promoted to a waypoint ('Latest Position').
            // The previous auto-promoted waypoint is demoted back to 'auto'.
            // Turn waypoints, manual entries, and user-placed waypoints are never demoted.
            const effectiveEntryType = entryType === 'auto' ? 'waypoint' : entryType;
            const effectiveWaypointName = entryType === 'auto' ? 'Latest Position' : waypointName;

            // Demote previous auto-promoted waypoint (fire-and-forget)
            if (entryType === 'auto') {
                this.demotePreviousAutoWaypoint(voyageId || this.trackingState.currentVoyageId || '').catch(() => {
                    /* best effort */
                });
            }

            // Create log entry with voyage ID
            const entry: Partial<ShipLogEntry> = {
                voyageId: voyageId || this.trackingState.currentVoyageId || `voyage_${Date.now()}`,
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
                // Stamp water status from cached 60s environment polling.
                // Ensures career totals filter has enough data to classify land vs water tracks.
                isOnWater: this.lastWaterStatus,
            };

            // Save online or queue offline. The OFFLINE-FAST-PATH lives
            // inside saveEntryOnlineOrOffline (skips supabase.auth.getUser
            // when offline so airplane-mode tracking doesn't hang).
            const { saved } = await saveEntryOnlineOrOffline(entry);

            // Update last position whether saved online or queued.
            // (Used by the next captureLogEntry call to compute distanceNM
            // and the acceleration sanity gate, so it must run regardless.)
            await this.saveLastPosition({
                latitude,
                longitude,
                timestamp,
                cumulativeDistanceNM,
                speedKts,
            });

            // Track when this entry was created for background resume catch-up
            this.trackingState.lastEntryTime = timestamp;
            this.trackingState.lastCheckTime = Date.now();
            this.trackingState.lastCheckDeduped = false;
            await this.saveTrackingState();

            // Re-evaluate logging zone after each successful fix
            // This allows the interval to adapt as the vessel moves closer/further from shore
            this.rescheduleAdaptiveInterval().catch((err) => {
                log.warn('captureLogEntry: adaptive reschedule failed', err);
            });

            // Online success returns the DB-hydrated entry (with id);
            // offline path falls back to the in-memory entry shape.
            return saved ?? (entry as ShipLogEntry);
        } catch (error) {
            log.error('captureLogEntry failed', error);
            return null;
        }
    }

    /**
     * Flush the high-frequency GPS buffer.
     *
     * Called on every interval tick instead of captureLogEntry().
     * Drains all buffered GPS fixes, runs RDP thinning to extract only
     * significant positions (turns ≥22.5°, speed changes, signal recovery),
     * then creates a log entry for each kept point.
     *
     * Falls back to standard captureLogEntry() when the buffer is empty
     * (e.g., heartbeat catch-up when backgrounded).
     */
    private async flushBufferedTrack(): Promise<void> {
        if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

        const rawPoints = this.trackBuffer.drain();

        // If buffer is empty (GPS was quiet), fall back to single-point capture
        if (rawPoints.length === 0) {
            await this.captureLogEntry();
            return;
        }

        // Thin the track — RDP + force-keep turns/speed changes/gaps
        const epsilonMult = GpsPrecision.getAdaptedThresholds().trackThinningMultiplier;
        const significant = thinTrack(rawPoints, epsilonMult);

        // If thinning produced nothing (all noise), use the latest raw point
        if (significant.length === 0) {
            this.lastBgLocation = rawPoints[rawPoints.length - 1];
            await this.captureLogEntry();
            return;
        }

        // Log each significant point sequentially, accumulating distance correctly.
        // Override the cached position so captureLogEntry() picks it up via getBestPosition().
        // skipDedup=true: RDP thinning already filtered noise — don't re-apply the
        // blunt 5m dedup which would silently drop valid turn/speed-change points.
        for (const pos of significant) {
            this.lastBgLocation = pos;
            await this.captureLogEntry('auto', undefined, undefined, undefined, undefined, undefined, true);
        }
    }

    /**
     * Add a manual log entry (user-initiated)
     * Creates the entry immediately - GPS position is fetched async
     * IMPORTANT: Requires an active voyage (tracking or explicitly passed voyageId)
     */
    async addManualEntry(
        notes?: string,
        waypointName?: string,
        eventCategory?:
            | 'navigation'
            | 'weather'
            | 'equipment'
            | 'crew'
            | 'arrival'
            | 'departure'
            | 'safety'
            | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string,
    ): Promise<ShipLogEntry | null> {
        const timestamp = new Date().toISOString();
        const entryType = waypointName ? 'waypoint' : 'manual';

        // Determine the voyage to add to - NEVER create a new voyage implicitly
        const effectiveVoyageId = voyageId || this.trackingState.currentVoyageId;

        if (!effectiveVoyageId) {
            return null;
        }

        // Get weather snapshot (SYNC — instant from localStorage)
        const weatherSnapshot = getWeatherSnapshot();

        // Create entry immediately with placeholder position
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

        // Try to get GPS position from cached onLocation stream (instant)
        try {
            const bestPos = await this.getBestPosition();

            if (bestPos) {
                const { latitude, longitude, heading } = bestPos;
                entry.latitude = latitude;
                entry.longitude = longitude;
                entry.positionFormatted = formatPositionDMS(latitude, longitude);

                if (heading !== null && heading !== undefined && heading !== 0) {
                    entry.courseDeg = Math.round(heading);
                }

                // Get last position for distance calculation
                const lastPos = await this.getLastPosition();
                if (lastPos) {
                    const distanceNM = calculateDistanceNM(lastPos.latitude, lastPos.longitude, latitude, longitude);
                    entry.distanceNM = Math.round(distanceNM * 100) / 100;
                    entry.cumulativeDistanceNM = Math.round((lastPos.cumulativeDistanceNM + distanceNM) * 100) / 100;
                }

                // Update last position
                await this.saveLastPosition({
                    latitude,
                    longitude,
                    timestamp,
                    cumulativeDistanceNM: entry.cumulativeDistanceNM || 0,
                });
            }
        } catch (gpsError: unknown) {
            log.warn('addManualEntry: GPS failed, using placeholder', gpsError);
        }

        // Save online or queue offline via the consolidated EntrySave helper.
        const { saved } = await saveEntryOnlineOrOffline(entry);
        return saved ?? (entry as ShipLogEntry);
    }

    /**
     * Capture log entry with timeout - prevents blocking UI on slow GPS/network
     * @param timeoutMs - Maximum time to wait for capture (default 5000ms)
     * @param voyageId - Optional voyage ID to use for the entry
     */
    private async captureLogEntryWithTimeout(
        timeoutMs: number = 5000,
        voyageId?: string,
    ): Promise<ShipLogEntry | null> {
        return Promise.race([
            this.captureLogEntry('auto', undefined, undefined, undefined, undefined, voyageId),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error(`Capture timed out after ${timeoutMs}ms`)), timeoutMs),
            ),
        ]);
    }

    /**
     * Get tracking status
     */
    getTrackingStatus(): TrackingState {
        return { ...this.trackingState };
    }

    /**
     * Toggle rapid GPS mode (5-second intervals for marina/shore navigation)
     * Activated by 3-second long-press on tracking indicator
     */
    async setRapidMode(enabled: boolean): Promise<void> {
        if (!this.trackingState.isTracking) {
            return;
        }

        if (this.trackingState.isRapidMode === enabled) {
            return;
        }

        // Update state
        this.trackingState.isRapidMode = enabled;
        await this.saveTrackingState();

        // Always stop the existing scheduler chain — both modes restart it.
        this.scheduler.stop();

        if (enabled) {
            // RAPID MODE: 5-second intervals for high-precision marina navigation

            // Clear any existing rapid mode timeout
            if (this.rapidModeTimeoutId) {
                clearTimeout(this.rapidModeTimeoutId);
                this.rapidModeTimeoutId = undefined;
            }

            // AUTO-DISABLE: Set 15-minute timeout to revert to normal mode
            const RAPID_AUTO_DISABLE_MS = 15 * 60 * 1000; // 15 minutes
            this.rapidModeTimeoutId = setTimeout(async () => {
                await this.setRapidMode(false);
            }, RAPID_AUTO_DISABLE_MS);

            // Capture first entry immediately when entering rapid mode
            this.captureLogEntry().catch((err) => {
                log.warn(``, err);
            });

            // 5-second non-aligned cadence — marina navigation cares about
            // density, not clock marks.
            this.scheduler.scheduleEvery(RAPID_INTERVAL_MS, () => this.captureLogEntry());
        } else {
            // ADAPTIVE MODE: Restore zone-based intervals

            // Clear rapid mode timeout if it exists
            if (this.rapidModeTimeoutId) {
                clearTimeout(this.rapidModeTimeoutId);
                this.rapidModeTimeoutId = undefined;
            }

            // Re-evaluate zone and set adaptive interval
            await this.rescheduleAdaptiveInterval();
        }
    }

    /**
     * Get current voyage ID (only if actively tracking)
     */
    getCurrentVoyageId(): string | undefined {
        // Only return voyage ID if actively tracking - prevents stale "active" status
        return this.trackingState.isTracking ? this.trackingState.currentVoyageId : undefined;
    }

    // --- DELEGATED CRUD METHODS (implementation in ./shiplog/EntryCrud.ts) ---

    async deleteVoyage(voyageId: string): Promise<boolean> {
        return _deleteVoyage(voyageId);
    }

    async deleteEntry(entryId: string): Promise<boolean> {
        return _deleteEntry(entryId);
    }

    async getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
        return _getLogEntries(limit);
    }

    async importGPXVoyage(entries: Partial<ShipLogEntry>[]): Promise<{ voyageId: string; savedCount: number }> {
        return _importGPXVoyage(entries);
    }

    async getArchivedEntries(limit?: number): Promise<ShipLogEntry[]> {
        return _getArchivedEntries(limit);
    }

    async getAllEntriesForCareer(): Promise<ShipLogEntry[]> {
        return _getAllEntriesForCareer();
    }

    async archiveVoyage(voyageId: string): Promise<boolean> {
        return _archiveVoyage(voyageId);
    }

    async unarchiveVoyage(voyageId: string): Promise<boolean> {
        return _unarchiveVoyage(voyageId);
    }

    // --- PRIVATE METHODS ---
    // Persistence delegates to ./shiplog/TrackingStateStore.ts. Keeping
    // the private wrappers preserves the orchestrator's call-sites without
    // having to thread `this.trackingState` through every save call.

    private async saveTrackingState(): Promise<void> {
        await _saveTrackingState(this.trackingState);
    }

    private async getLastPosition(): Promise<StoredPosition | null> {
        return _getLastPosition();
    }

    private async saveLastPosition(position: StoredPosition): Promise<void> {
        await _saveLastPosition(position);
    }

    // --- DELEGATED OFFLINE QUEUE METHODS (implementation in ./shiplog/OfflineQueue.ts) ---

    private async queueOfflineEntry(entry: Partial<ShipLogEntry>): Promise<void> {
        return _queueOfflineEntry(entry);
    }

    async syncOfflineQueue(): Promise<number> {
        return _syncOfflineQueue();
    }

    private startSyncInterval(): void {
        if (this.syncIntervalId) return;
        this.syncIntervalId = setInterval(
            () => {
                this.syncOfflineQueue();
            },
            2 * 60 * 1000,
        );
    }

    async getOfflineQueueCount(): Promise<number> {
        return _getOfflineQueueCount();
    }

    /** Delegate to extracted module */
    async savePassagePlanToLogbook(plan: import('../types').VoyagePlan): Promise<string | null> {
        return _savePassagePlanToLogbook(plan);
    }

    async getOfflineEntries(): Promise<ShipLogEntry[]> {
        return _getOfflineEntries();
    }
}

// Export singleton instance
export const ShipLogService = new ShipLogServiceClass();
