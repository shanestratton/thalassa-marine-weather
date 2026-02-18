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

import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';
import { supabase } from './supabase';
import { ShipLogEntry } from '../types';
import { BgGeoManager, CachedPosition } from './BgGeoManager';
import { EnvironmentService } from './EnvironmentService';
import { createLogger } from '../utils/logger';

// --- Extracted modules ---
import {
    calculateDistanceNM, calculateBearing, formatPositionDMS,
    getNextQuarterHour, toDbFormat, fromDbFormat,
    getWeatherSnapshot, determineLoggingZone, getIntervalForZone, getZoneLabel,
    SHIP_LOGS_TABLE, NEARSHORE_INTERVAL_MS, COASTAL_INTERVAL_MS, OFFSHORE_INTERVAL_MS,
    type LoggingZone,
} from './shiplog/helpers';
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
    deleteVoyage as _deleteVoyage,
    deleteEntry as _deleteEntry,
    importGPXVoyage as _importGPXVoyage,
} from './shiplog/EntryCrud';
import { checkIsOnWater } from './shiplog/waterDetection';

const log = createLogger('ShipLog');

// Staleness threshold: if cached GPS is older than this, fetch fresh
const GPS_STALE_LIMIT_MS = 60_000; // 60 seconds

// --- CONSTANTS ---
const TRACKING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (legacy default / offshore)
const RAPID_INTERVAL_MS = 5 * 1000; // 5 seconds for marina/shore navigation (manual override)
const STATIONARY_THRESHOLD_NM = 0.05; // Less than 0.05nm movement = anchored

const DEDUP_THRESHOLD_NM = 0.0027; // ~5 meters — discard auto entry if vessel hasn't moved
const VOYAGE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours — start new voyage instead of resuming

// --- STORAGE KEYS ---
const TRACKING_STATE_KEY = 'ship_log_tracking_state';
const LAST_POSITION_KEY = 'ship_log_last_position';
const VOYAGE_START_KEY = 'ship_log_voyage_start';

// --- INTERFACES ---

interface TrackingState {
    isTracking: boolean;
    isPaused: boolean;
    isRapidMode: boolean;
    currentVoyageId?: string;
    voyageStartTime?: string;
    voyageEndTime?: string;
    lastMovementTime?: string;
    lastEntryTime?: string;
    loggingZone?: LoggingZone;
    currentIntervalMs?: number;
    /** Timestamp of the last position-check (whether saved or deduped) */
    lastCheckTime?: number;
    /** True if the last position-check was deduped (vessel hasn't moved) */
    lastCheckDeduped?: boolean;
}

interface StoredPosition {
    latitude: number;
    longitude: number;
    timestamp: string;
    cumulativeDistanceNM: number;
}

// Helper functions, DB mapping, weather snapshot, and zone detection
// are now in ./shiplog/helpers.ts — imported above.

// --- MAIN SERVICE CLASS ---

class ShipLogServiceClass {
    private intervalId?: NodeJS.Timeout;
    private quarterTimeoutId?: NodeJS.Timeout; // For initial quarter-hour alignment
    private syncIntervalId?: NodeJS.Timeout;
    private rapidModeTimeoutId?: NodeJS.Timeout; // 15-minute auto-disable for rapid mode
    private trackingState: TrackingState = { isTracking: false, isPaused: false, isRapidMode: false };

    // --- BATTLE-HARDENED GPS STREAMING ---
    // onLocation continuously caches the latest position. Timers decide WHEN to log,
    // but never block on getCurrentPosition. This survives background, suspension,
    // and cold starts — the position is always available.
    private lastBgLocation: CachedPosition | null = null;
    private bgUnsubscribers: (() => void)[] = []; // Cleanup handles for BgGeoManager subscriptions

    // --- AUTO-WAYPOINT ON CARDINAL BEARING CHANGE ---
    private lastCardinal: string | null = null;  // Last confirmed 16-point cardinal (e.g. 'NNE')
    private lastAutoWaypointTime: number = 0;          // Cooldown timestamp (ms)
    private static readonly AUTO_WP_COOLDOWN_MS = 60_000;   // 60s between auto-waypoints
    private static readonly MIN_SPEED_FOR_HEADING_KTS = 1;  // Ignore heading when drifting

    /**
     * Convert degrees (0-360) to 16-point compass cardinal.
     * N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW, NW, NNW
     */
    private static degreesToCardinal16(deg: number): string {
        const cardinals = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const index = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
        return cardinals[index];
    }

    /**
     * Initialize the service and restore state from storage
     */
    async initialize(): Promise<void> {
        try {
            const { value } = await Preferences.get({ key: TRACKING_STATE_KEY });
            if (value) {
                this.trackingState = JSON.parse(value);

                // STALE STATE DETECTION: If tracking was left on from a previous app session
                // but no interval is running (intervalId is undefined on cold start), 
                // this means the app was force-closed while tracking.
                //
                // Behavior depends on autoTrackEnabled:
                // - OFF: Reset to stopped state so the Start button shows correctly.
                // - ON:  Auto-resume the voyage (handled by autoStartIfEnabled called from App.tsx)
                // 
                // IMPORTANT: When navigating between pages within an active session,
                // intervalId WILL be set, so this won't affect active tracking.
                if (this.trackingState.isTracking && !this.trackingState.isPaused && !this.intervalId) {
                    // Mark as stopped — autoStartIfEnabled() will restart if setting is on
                    this.trackingState = {
                        isTracking: false,
                        isPaused: false,
                        isRapidMode: false,
                        // Preserve voyage info so autoStartIfEnabled can decide to resume or start fresh
                        currentVoyageId: this.trackingState.currentVoyageId,
                        voyageStartTime: this.trackingState.voyageStartTime,
                        voyageEndTime: this.trackingState.voyageEndTime || new Date().toISOString()
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
                    if (document.visibilityState === 'visible' && this.trackingState.isTracking && !this.trackingState.isPaused) {
                        await this.checkMissedEntries();
                    }
                });
            }

        } catch (error) {
            log.error('initialize failed', error);
        }
    }

    /**
     * Auto-start tracking if the user has opted in via Settings.
     * Called from App.tsx after initialize() completes.
     *
     * Logic:
     * - If already tracking → no-op
     * - If a previous voyage ended < 6 hours ago → resume it
     * - Otherwise → start a new voyage
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
            const missedCount = Math.floor(msSinceLast / TRACKING_INTERVAL_MS);

            // Capture ONE entry now (at current time, not backdated)
            // We don't backfill because GPS data from the past isn't available
            try {
                const entry = await this.captureLogEntry();
                if (entry) {
                } else {
                }
            } catch (err: unknown) {
                log.error('checkMissedEntries: catch-up entry failed', err);
            }
        }

        // Reschedule to next quarter-hour
        this.rescheduleAdaptiveInterval();
    }

    /**
     * Clear all active timers (interval + quarter-hour timeout)
     */
    private clearAllTimers(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.quarterTimeoutId) {
            clearTimeout(this.quarterTimeoutId);
            this.quarterTimeoutId = undefined;
        }
    }

    /**
     * Reschedule the interval to sync to the next quarter-hour
     */
    private rescheduleNextQuarterHour(): void {
        this.clearAllTimers();

        // Schedule next quarter-hour entry
        const { nextTime, msUntil } = getNextQuarterHour();

        this.quarterTimeoutId = setTimeout(() => {
            this.captureLogEntry().then(entry => {
                if (entry) {
                } else {
                }
            }).catch(err => {
            });

            // Start regular interval
            this.intervalId = setInterval(() => {
                this.captureLogEntry().then(entry => {
                    if (entry) {
                    } else {
                    }
                }).catch(err => {
                });
            }, TRACKING_INTERVAL_MS);
        }, msUntil);
    }

    /**
     * Reschedule the logging interval based on current shore proximity.
     * Called after each successful GPS fix to adapt the interval dynamically.
     * Does NOT apply when rapid mode is active (rapid mode always uses 5-sec).
     */
    private async rescheduleAdaptiveInterval(): Promise<void> {
        // Don't interfere with rapid mode
        if (this.trackingState.isRapidMode) return;
        if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

        const newZone = await determineLoggingZone();
        const newInterval = getIntervalForZone(newZone);
        const oldZone = this.trackingState.loggingZone || 'offshore';

        // Only reschedule if zone actually changed
        if (newZone === oldZone && this.intervalId) return;

        // Zone changed — log the transition
        if (newZone !== oldZone) {
        }

        // Update state
        this.trackingState.loggingZone = newZone;
        this.trackingState.currentIntervalMs = newInterval;
        await this.saveTrackingState();

        // Use clock-aligned scheduling
        this.scheduleClockAlignedInterval(newInterval, newZone);
    }

    /**
     * Schedule entries aligned to clock marks.
     * E.g. 15-min interval → fires at xx:00, xx:15, xx:30, xx:45
     *      2-min interval  → fires at xx:00, xx:02, xx:04, ...
     *      30-sec interval → fires at xx:xx:00, xx:xx:30
     */
    private scheduleClockAlignedInterval(intervalMs: number, zone: string): void {
        this.clearAllTimers();

        const now = Date.now();
        const msToNext = intervalMs - (now % intervalMs);
        const nextMark = new Date(now + msToNext);


        // Wait until the next clock-aligned mark, then fire
        this.quarterTimeoutId = setTimeout(() => {
            this.captureLogEntry().then(entry => {
            }).catch(err => {
            });

            // Now setInterval for every subsequent mark
            this.intervalId = setInterval(() => {
                this.captureLogEntry().then(entry => {
                }).catch(err => {
                });
            }, intervalMs);
        }, msToNext) as unknown as ReturnType<typeof setInterval>;
    }

    /**
     * Start automatic GPS tracking
     * @param resume - If true, resume existing voyage. If false, start new voyage.
     * @param continueVoyageId - Optional: specify a voyage ID to continue
     *
     * HARDENED ORDERING: GPS engine starts BEFORE state is committed.
     * If requestStart() fails, state rolls back and error propagates to UI.
     */
    async startTracking(resume: boolean = false, continueVoyageId?: string): Promise<void> {
        if (this.trackingState.isTracking) {
            return;
        }

        // Initialize shared BackgroundGeolocation engine
        await BgGeoManager.ensureReady();

        // Start Transistorsoft continuous background tracking FIRST (ref-counted).
        // If this fails (permission denied, plugin crash), we never set isTracking=true
        // and the error bubbles up to the UI via the calling function's catch block.
        await BgGeoManager.requestStart();

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
            voyageStartTime: (resume || continueVoyageId) ? this.trackingState.voyageStartTime : new Date().toISOString(),
            lastMovementTime: new Date().toISOString()
        };

        await this.saveTrackingState();

        // --- BATTLE-HARDENED GPS STREAMING ---
        // Wire up continuous position caching via onLocation.
        // The timer decides WHEN to log; onLocation ensures GPS is ALWAYS fresh.
        this.wireGpsSubscriptions();

        // IMMEDIATE ENTRY: Fire-and-forget — GPS acquisition runs in background
        // so the UI is not blocked by the 3s GPS warm-up loop.
        this.captureImmediateEntry().catch(() => { });

        // Reset cardinal tracker for new voyage
        this.lastCardinal = null;
        this.lastAutoWaypointTime = 0;

        // ADAPTIVE SCHEDULING: Always start at nearshore (30s) — the safest default.
        // rescheduleAdaptiveInterval() runs after every GPS fix and will refine the
        // zone once weather-cache data is available (e.g. coastal → 2min, offshore → 15min).
        const initialZone: LoggingZone = 'nearshore';
        const initialInterval = getIntervalForZone(initialZone);
        this.trackingState.loggingZone = initialZone;
        this.trackingState.currentIntervalMs = initialInterval;
        await this.saveTrackingState();

        // Schedule clock-aligned entries (30s → fires at xx:xx:00, xx:xx:30)
        this.scheduleClockAlignedInterval(initialInterval, initialZone);

        // Kick off async zone refinement in the background — won't block UI
        this.rescheduleAdaptiveInterval().catch(() => { });
    }

    /**
     * Wire up BgGeoManager subscriptions for GPS, heartbeat, and activity.
     * Called from startTracking() and when resuming from pause.
     */
    private wireGpsSubscriptions(): void {
        // Cleanup any stale subscriptions first
        this.cleanupGpsSubscriptions();

        // 1. LOCATION STREAM — Cache every GPS fix. Feed altitude to EnvironmentService.
        const unsubLoc = BgGeoManager.subscribeLocation((pos) => {
            this.lastBgLocation = pos;

            // Feed altitude to EnvironmentService for on-water/on-land detection
            if (pos.altitude !== null && pos.altitude !== undefined) {
                EnvironmentService.updateFromGPS({ altitude: pos.altitude });
            }

            // --- AUTO-WAYPOINT: Detect significant course changes ---
            this.checkHeadingChange(pos);
        });
        this.bgUnsubscribers.push(unsubLoc);

        // 2. HEARTBEAT — Fires every 60s when stationary (even backgrounded).
        //    Check if a log entry is due and capture it. This is the safety net
        //    that fires even when JS timers are suspended by iOS.
        const unsubHb = BgGeoManager.subscribeHeartbeat((_event) => {
            if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

            // Check if we've missed a scheduled entry
            const lastEntry = this.trackingState.lastEntryTime;
            if (lastEntry) {
                const elapsed = Date.now() - new Date(lastEntry).getTime();
                const currentInterval = this.trackingState.currentIntervalMs || TRACKING_INTERVAL_MS;
                if (elapsed >= currentInterval) {
                    // We missed a scheduled entry (timer was suspended) — capture now
                    this.captureLogEntry().catch(() => { });
                }
            }
        });
        this.bgUnsubscribers.push(unsubHb);

        // 3. ACTIVITY CHANGE — Detect stationary ↔ moving transitions.
        //    Inform adaptive interval logic (if vessel stops moving for extended period,
        //    the auto-pause in captureLogEntry will handle it via STATIONARY_TIMEOUT_MS).
        const unsubAct = BgGeoManager.subscribeActivity((_event) => {
            // Currently, auto-pause is handled by distance-based detection in captureLogEntry.
            // The activity change event gives us an earlier signal that the vessel has stopped,
            // which we can use for future enhancements. For now, just ensure zone re-evaluation
            // happens on the next log entry.
        });
        this.bgUnsubscribers.push(unsubAct);
    }

    /**
     * Check if the 16-point cardinal bearing has changed and create an auto-waypoint.
     * Fires when the compass direction changes (e.g. NE → ENE), not on raw degree delta.
     * Filters: speed > 1kt, valid heading, 60s cooldown.
     */
    private checkHeadingChange(pos: CachedPosition): void {
        if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

        const heading = pos.heading;
        const speedKts = (pos.speed ?? 0) * 1.94384; // m/s → knots

        // Ignore heading when stationary or drifting
        if (speedKts < ShipLogServiceClass.MIN_SPEED_FOR_HEADING_KTS) return;
        // Ignore invalid heading (null means GPS didn't provide one)
        if (heading === null || heading === undefined) return;

        const newCardinal = ShipLogServiceClass.degreesToCardinal16(heading);

        // First valid heading fix — seed it, no waypoint
        if (this.lastCardinal === null) {
            this.lastCardinal = newCardinal;
            return;
        }

        // No change in cardinal direction
        if (newCardinal === this.lastCardinal) return;

        // Cardinal changed — check cooldown
        const now = Date.now();
        if (now - this.lastAutoWaypointTime < ShipLogServiceClass.AUTO_WP_COOLDOWN_MS) {
            // Still in cooldown — update baseline silently
            this.lastCardinal = newCardinal;
            return;
        }

        const oldCardinal = this.lastCardinal;
        this.lastAutoWaypointTime = now;
        this.lastCardinal = newCardinal;

        // Fire-and-forget waypoint entry
        this.captureLogEntry(
            'waypoint',
            `Auto: COG ${oldCardinal} → ${newCardinal}`,
            `COG ${oldCardinal} → ${newCardinal}`,
            'navigation'
        ).catch(() => { /* best effort */ });
    }

    /**
     * Clean up all BgGeoManager subscriptions.
     */
    private cleanupGpsSubscriptions(): void {
        this.bgUnsubscribers.forEach(unsub => {
            try { unsub(); } catch { /* already cleaned up */ }
        });
        this.bgUnsubscribers = [];
    }

    /**
     * Get the best available GPS position.
     * Uses cached onLocation position if fresh, otherwise falls back to getCurrentPosition.
     * This is the ONLY place that should resolve GPS for log entries.
     */
    private async getBestPosition(): Promise<CachedPosition | null> {
        // Check cached position freshness
        if (this.lastBgLocation) {
            const age = Date.now() - this.lastBgLocation.receivedAt;
            if (age < GPS_STALE_LIMIT_MS) {
                return this.lastBgLocation;
            }
        }

        // Cache is stale or empty — fetch fresh (blocking, but only as fallback)
        return BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 15);
    }

    /**
     * GPS HEALTH STATUS — Public API for UI indicators.
     * Returns the current GPS fix quality:
     *   'locked'  — fresh fix received within 60s (green)
     *   'stale'   — last fix is 60s–300s old (amber)
     *   'none'    — no fix ever received, or older than 5min (red)
     */
    getGpsStatus(): 'locked' | 'stale' | 'none' {
        const pos = this.lastBgLocation || BgGeoManager.getLastPosition();
        if (!pos) return 'none';

        const ageMs = Date.now() - pos.receivedAt;
        if (ageMs < GPS_STALE_LIMIT_MS) return 'locked';   // < 60s
        if (ageMs < 5 * 60 * 1000) return 'stale';          // 60s – 5min
        return 'none';                                       // > 5min
    }

    /**
     * Pause tracking (user initiated)
     */
    async pauseTracking(): Promise<void> {
        this.clearAllTimers();

        // Clean up GPS subscriptions to save battery while paused
        this.cleanupGpsSubscriptions();

        this.trackingState.isTracking = false;
        this.trackingState.isPaused = true;
        await this.saveTrackingState();

    }

    /**
     * Stop tracking and end voyage
     * Responds instantly - final entry capture happens in background
     */
    async stopTracking(): Promise<void> {
        this.clearAllTimers();

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
            voyageEndTime: voyageEndTime
        };
        await this.saveTrackingState();

        // Reset cardinal tracker
        this.lastCardinal = null;

        // Capture final entry BEFORE cleaning up GPS — ensures end coordinates are captured
        // GPS subscriptions are still alive here so getBestPosition() can use cached fix
        await this.captureImmediateEntry(previousVoyageId, 'Voyage End').catch((err: unknown) => {
        });

        // NOW clean up GPS stream subscriptions (after final entry has GPS)
        this.cleanupGpsSubscriptions();

        // Clear voyage data
        await Preferences.remove({ key: LAST_POSITION_KEY });
        await Preferences.remove({ key: VOYAGE_START_KEY });

        // Stop Transistorsoft background tracking (ref-counted — only stops if no other consumer)
        await BgGeoManager.requestStop();

    }

    /**
     * Create an immediate log entry without waiting for GPS
     * The entry is created instantly with timestamp, GPS position is fetched async
     * This ensures the card appears in the UI immediately
     */
    async captureImmediateEntry(voyageId?: string, waypointLabel: string = 'Voyage Start'): Promise<ShipLogEntry | null> {
        const timestamp = new Date().toISOString();
        const effectiveVoyageId = voyageId || this.trackingState.currentVoyageId || `voyage_${Date.now()}`;


        // Get weather snapshot (fast, from cache)
        const weatherSnapshot = await getWeatherSnapshot();

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
            source: 'device'
        };

        // Flag to track if GPS failed and needs background retry
        let needsGpsRetry = false;

        // COLD START WARM-UP: If no cached GPS fix yet, wait briefly for the first one
        // Single fast check — background retry handles late fixes
        const GPS_WARMUP_ATTEMPTS = 1;
        const GPS_WARMUP_DELAY_MS = 500;

        let bestPos = this.lastBgLocation;
        if (!bestPos || (Date.now() - bestPos.receivedAt > GPS_STALE_LIMIT_MS)) {
            // No fresh cached position — try warm-up loop
            for (let i = 0; i < GPS_WARMUP_ATTEMPTS; i++) {
                await new Promise(resolve => setTimeout(resolve, GPS_WARMUP_DELAY_MS));
                bestPos = this.lastBgLocation;
                if (bestPos && (Date.now() - bestPos.receivedAt < GPS_STALE_LIMIT_MS)) {
                    break; // Got a fresh fix
                }
                // Also try getCurrentPosition as a final fallback on last attempt
                if (i === GPS_WARMUP_ATTEMPTS - 1) {
                    bestPos = await BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 10);
                }
            }
        }

        if (bestPos && (Date.now() - bestPos.receivedAt < GPS_STALE_LIMIT_MS)) {
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
                cumulativeDistanceNM: 0
            });

            // On-water check (fire-and-forget, fail-open)
            try {
                entry.isOnWater = await checkIsOnWater(bestPos.latitude, bestPos.longitude);
            } catch {
                entry.isOnWater = true; // Fail open
            }
        } else {
            // No GPS at all after warm-up — will retry in background
            needsGpsRetry = true;
        }

        // Track entry ID for potential GPS update later
        let savedEntryId: string | null = null;

        // Save the entry (online or offline queue)
        if (supabase) {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    const { data, error } = await supabase
                        .from(SHIP_LOGS_TABLE)
                        .insert(toDbFormat({ ...entry, userId: user.id }))
                        .select()
                        .single();

                    if (error) {
                        await this.queueOfflineEntry(entry);
                    } else {
                        savedEntryId = data.id;

                        // If GPS failed initially, retry in background
                        if (needsGpsRetry && savedEntryId) {
                            this.retryGpsAndUpdateEntry(savedEntryId);
                        }
                        return fromDbFormat(data);
                    }
                } else {
                    await this.queueOfflineEntry(entry);
                }
            } catch (networkError) {
                await this.queueOfflineEntry(entry);
            }
        } else {
            await this.queueOfflineEntry(entry);
        }

        // Track when this entry was created for background resume catch-up
        this.trackingState.lastEntryTime = timestamp;
        await this.saveTrackingState();

        return entry as ShipLogEntry;
    }

    /**
     * Background GPS retry - attempts to get GPS position and update a saved entry
     * Retries every 5 seconds for up to 30 seconds total
     */
    private async retryGpsAndUpdateEntry(entryId: string): Promise<void> {
        const maxRetries = 6;
        const retryDelayMs = 5000;


        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));

            try {
                // Use BgGeoManager fresh position (force a new sample for retry)
                const pos = await BgGeoManager.getFreshPosition(5000, 10);
                if (!pos) continue; // No GPS yet, retry

                const { latitude, longitude, heading } = pos;
                const positionFormatted = formatPositionDMS(latitude, longitude);

                // Update the database entry with the acquired position
                if (supabase) {
                    const updateData = toDbFormat({
                        latitude,
                        longitude,
                        positionFormatted
                    });
                    if (heading !== null && heading !== undefined && heading !== 0) {
                        updateData.course_deg = Math.round(heading);
                    }

                    const { error } = await supabase
                        .from(SHIP_LOGS_TABLE)
                        .update(updateData)
                        .eq('id', entryId);

                    if (error) {
                    } else {

                        // Update last position
                        await this.saveLastPosition({
                            latitude,
                            longitude,
                            timestamp: new Date().toISOString(),
                            cumulativeDistanceNM: 0
                        });
                    }
                }
                return; // Success - stop retrying
            } catch (gpsError: unknown) {
                log.warn('retryGpsAndUpdateEntry: GPS retry failed', gpsError);
            }
        }

    }

    /**
     * Demote the previous auto-promoted waypoint ('Latest Position') back to 'auto'.
     * Only demotes entries with waypointName === 'Latest Position' — turn waypoints,
     * manual entries, and user-placed waypoints are never demoted.
     */
    private async demotePreviousAutoWaypoint(voyageId: string): Promise<void> {
        if (!supabase || !voyageId) return;
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            // Find the most recent 'Latest Position' waypoint in this voyage
            const { data: rows } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select('id')
                .eq('user_id', user.id)
                .eq('voyage_id', voyageId)
                .eq('entry_type', 'waypoint')
                .eq('waypoint_name', 'Latest Position')
                .order('timestamp', { ascending: false })
                .limit(1);

            if (rows && rows.length > 0) {
                await supabase
                    .from(SHIP_LOGS_TABLE)
                    .update({ entry_type: 'auto', waypoint_name: null })
                    .eq('id', rows[0].id);
            }
        } catch {
            // Best effort — demotion is non-critical
        }
    }

    /**
     * Capture a single log entry
     * Auto-pause detection: If vessel hasn't moved >0.05nm in 1 hour, pause tracking
     */
    async captureLogEntry(
        entryType: 'auto' | 'manual' | 'waypoint' = 'auto',
        notes?: string,
        waypointName?: string,
        eventCategory?: 'navigation' | 'weather' | 'equipment' | 'crew' | 'arrival' | 'departure' | 'safety' | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string
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
            let entryTime = new Date(bestPos?.timestamp ?? Date.now());
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
                distanceNM = calculateDistanceNM(
                    lastPos.latitude,
                    lastPos.longitude,
                    latitude,
                    longitude
                );

                // DEDUP FILTER: If this is an auto entry and the vessel hasn't moved
                // more than ~5 meters, discard it to avoid cluttering the logbook.
                // Record the check so the UI can show "Position unchanged" feedback.
                if (entryType === 'auto' && distanceNM < DEDUP_THRESHOLD_NM) {
                    this.trackingState.lastCheckTime = Date.now();
                    this.trackingState.lastCheckDeduped = true;
                    return null;
                }

                // Calculate speed (distance / time)
                const timeDiffMs = new Date(timestamp).getTime() - new Date(lastPos.timestamp).getTime();
                const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
                speedKts = timeDiffHours > 0 ? distanceNM / timeDiffHours : 0;

                // SPEED SANITY: Clamp to 80 kn (fastest planing hulls).
                // GPS teleports after cold start can produce absurd values (e.g. 433 kn).
                if (speedKts > 80) speedKts = 0;
                // Ignore speed when previous position was the 0,0 placeholder from captureImmediateEntry
                if (lastPos.latitude === 0 && lastPos.longitude === 0) speedKts = 0;

                cumulativeDistanceNM = lastPos.cumulativeDistanceNM + distanceNM;

                // Track last movement time (for analytics/stats)
                if (distanceNM >= STATIONARY_THRESHOLD_NM) {
                    this.trackingState.lastMovementTime = timestamp;
                    await this.saveTrackingState();
                }
            }

            // Get weather snapshot
            const weatherSnapshot = await getWeatherSnapshot();

            // Calculate COG: Use GPS heading if available, otherwise calculate from position change
            let courseDeg: number | undefined;
            if (heading !== null && heading !== undefined) {
                // GPS provides heading directly
                courseDeg = Math.round(heading);
            } else if (lastPos && distanceNM >= STATIONARY_THRESHOLD_NM) {
                // Calculate bearing from previous position (only if actually moved)
                courseDeg = Math.round(calculateBearing(
                    lastPos.latitude,
                    lastPos.longitude,
                    latitude,
                    longitude
                ));
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
                this.demotePreviousAutoWaypoint(
                    voyageId || this.trackingState.currentVoyageId || ''
                ).catch(() => { /* best effort */ });
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
                waypointName: effectiveWaypointName
            };

            // Try to save to Supabase (online)
            if (supabase) {
                try {
                    const { data: { user } } = await supabase.auth.getUser();
                    if (user) {
                        const { data, error } = await supabase
                            .from(SHIP_LOGS_TABLE)
                            .insert(toDbFormat({ ...entry, userId: user.id }))
                            .select()
                            .single();

                        if (error) {
                            // Network error or offline - queue for later
                            await this.queueOfflineEntry(entry);
                        } else {

                            // Update last position in storage
                            await this.saveLastPosition({
                                latitude,
                                longitude,
                                timestamp,
                                cumulativeDistanceNM
                            });

                            return fromDbFormat(data);
                        }
                    } else {
                        // Not authenticated - queue offline
                        await this.queueOfflineEntry(entry);
                    }
                } catch (networkError) {
                    // Offline - queue for later
                    await this.queueOfflineEntry(entry);
                }
            } else {
                // No Supabase - queue locally
                await this.queueOfflineEntry(entry);
            }

            // Still update last position even if queued
            await this.saveLastPosition({
                latitude,
                longitude,
                timestamp,
                cumulativeDistanceNM
            });

            // Track when this entry was created for background resume catch-up
            this.trackingState.lastEntryTime = timestamp;
            this.trackingState.lastCheckTime = Date.now();
            this.trackingState.lastCheckDeduped = false;
            await this.saveTrackingState();

            // Re-evaluate logging zone after each successful fix
            // This allows the interval to adapt as the vessel moves closer/further from shore
            this.rescheduleAdaptiveInterval().catch(err => {
                log.warn('captureLogEntry: adaptive reschedule failed', err);
            });

            return entry as ShipLogEntry;
        } catch (error) {
            log.error('captureLogEntry failed', error);
            return null;
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
        eventCategory?: 'navigation' | 'weather' | 'equipment' | 'crew' | 'arrival' | 'departure' | 'safety' | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string
    ): Promise<ShipLogEntry | null> {
        const timestamp = new Date().toISOString();
        const entryType = waypointName ? 'waypoint' : 'manual';

        // Determine the voyage to add to - NEVER create a new voyage implicitly
        const effectiveVoyageId = voyageId || this.trackingState.currentVoyageId;

        if (!effectiveVoyageId) {
            return null;
        }


        // Get weather snapshot (fast, from cache)
        const weatherSnapshot = await getWeatherSnapshot();

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
            waypointName
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
                    const distanceNM = calculateDistanceNM(
                        lastPos.latitude, lastPos.longitude,
                        latitude, longitude
                    );
                    entry.distanceNM = Math.round(distanceNM * 100) / 100;
                    entry.cumulativeDistanceNM = Math.round((lastPos.cumulativeDistanceNM + distanceNM) * 100) / 100;
                }

                // Update last position
                await this.saveLastPosition({
                    latitude,
                    longitude,
                    timestamp,
                    cumulativeDistanceNM: entry.cumulativeDistanceNM || 0
                });
            }
        } catch (gpsError: unknown) {
            log.warn('addManualEntry: GPS failed, using placeholder', gpsError);
        }

        // Save the entry (online or offline queue)
        if (supabase) {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    const { data, error } = await supabase
                        .from(SHIP_LOGS_TABLE)
                        .insert(toDbFormat({ ...entry, userId: user.id }))
                        .select()
                        .single();

                    if (error) {
                        await this.queueOfflineEntry(entry);
                    } else {
                        return fromDbFormat(data);
                    }
                } else {
                    await this.queueOfflineEntry(entry);
                }
            } catch (networkError) {
                await this.queueOfflineEntry(entry);
            }
        } else {
            await this.queueOfflineEntry(entry);
        }

        return entry as ShipLogEntry;
    }

    /**
     * Capture log entry with timeout - prevents blocking UI on slow GPS/network
     * @param timeoutMs - Maximum time to wait for capture (default 5000ms)
     * @param voyageId - Optional voyage ID to use for the entry
     */
    private async captureLogEntryWithTimeout(timeoutMs: number = 5000, voyageId?: string): Promise<ShipLogEntry | null> {
        return Promise.race([
            this.captureLogEntry('auto', undefined, undefined, undefined, undefined, voyageId),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error(`Capture timed out after ${timeoutMs}ms`)), timeoutMs)
            )
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

        // Clear existing intervals
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.quarterTimeoutId) {
            clearTimeout(this.quarterTimeoutId);
            this.quarterTimeoutId = undefined;
        }

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
            this.captureLogEntry().catch(err => {
            });

            // Start 5-second interval
            this.intervalId = setInterval(() => {
                this.captureLogEntry().then(entry => {
                    if (entry) {
                    }
                }).catch(err => {
                });
            }, RAPID_INTERVAL_MS);
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

    // --- PRIVATE METHODS ---

    private async saveTrackingState(): Promise<void> {
        await Preferences.set({
            key: TRACKING_STATE_KEY,
            value: JSON.stringify(this.trackingState)
        });
    }

    private async getLastPosition(): Promise<StoredPosition | null> {
        try {
            const { value } = await Preferences.get({ key: LAST_POSITION_KEY });
            return value ? JSON.parse(value) : null;
        } catch {
            /* Preferences read/parse failure — null signals no cached position */
            return null;
        }
    }

    private async saveLastPosition(position: StoredPosition): Promise<void> {
        await Preferences.set({
            key: LAST_POSITION_KEY,
            value: JSON.stringify(position)
        });
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
        this.syncIntervalId = setInterval(() => {
            this.syncOfflineQueue();
        }, 2 * 60 * 1000);
    }

    async getOfflineQueueCount(): Promise<number> {
        return _getOfflineQueueCount();
    }

    async getOfflineEntries(): Promise<ShipLogEntry[]> {
        return _getOfflineEntries();
    }
}

// Export singleton instance
export const ShipLogService = new ShipLogServiceClass();
