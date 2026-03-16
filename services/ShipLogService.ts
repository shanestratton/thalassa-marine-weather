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
import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase';
import { ShipLogEntry } from '../types';
import { BgGeoManager, CachedPosition } from './BgGeoManager';
import { GpsService } from './GpsService';
import { NmeaGpsProvider } from './NmeaGpsProvider';
import { EnvironmentService } from './EnvironmentService';
import { createLogger } from '../utils/logger';

// --- Extracted modules ---
import {
    calculateDistanceNM,
    calculateBearing,
    formatPositionDMS,
    getNextQuarterHour,
    toDbFormat,
    fromDbFormat,
    getWeatherSnapshot,
    determineLoggingZone,
    getIntervalForZone,
    getIntervalForSpeed,
    SHIP_LOGS_TABLE,
    type LoggingZone,
    type SpeedTier,
} from './shiplog/helpers';
import { GpsTrackBuffer, thinTrack, bearing, headingDelta } from './shiplog/GpsTrackBuffer';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
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

/**
 * Check if satellite mode is enabled (sync read from settings).
 * When true, all Supabase sync is suppressed — entries queue on-device.
 * Conserves bandwidth for Iridium GO! / metered satellite connections.
 */
function isSatelliteMode(): boolean {
    try {
        // Capacitor Preferences stores under CapacitorStorage.{key} in localStorage
        const raw = localStorage.getItem('CapacitorStorage.thalassa_settings');
        if (!raw) return false;
        const settings = JSON.parse(raw);
        return !!settings?.satelliteMode;
    } catch {
        return false;
    }
}

// Staleness threshold: if cached GPS is older than this, fetch fresh
const GPS_STALE_LIMIT_MS = 60_000; // 60 seconds

// --- CONSTANTS ---
const TRACKING_INTERVAL_MS = 30 * 1000; // 30 seconds (fallback / offshore default)
const RAPID_INTERVAL_MS = 5 * 1000; // 5 seconds for marina/shore navigation (manual override)
const STATIONARY_THRESHOLD_NM = 0.05; // Less than 0.05nm movement = anchored

const DEDUP_THRESHOLD_NM = 0.00054; // ~1 meter — discard auto entry if vessel hasn't moved
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
    // Platform detection: native (iOS/Android) uses Transistorsoft BgGeo;
    // web uses navigator.geolocation + setInterval fallbacks.
    private readonly isNative = Capacitor.isNativePlatform();
    private intervalId?: NodeJS.Timeout;
    private quarterTimeoutId?: NodeJS.Timeout; // For initial quarter-hour alignment
    private syncIntervalId?: NodeJS.Timeout;
    private rapidModeTimeoutId?: NodeJS.Timeout; // 15-minute auto-disable for rapid mode
    private envCheckIntervalId?: NodeJS.Timeout; // 60s environment polling (water/land + zone)
    private webWatchId?: number; // navigator.geolocation.watchPosition ID (web only)
    private webHeartbeatId?: NodeJS.Timeout; // 60s setInterval heartbeat (web only)
    private trackingState: TrackingState = { isTracking: false, isPaused: false, isRapidMode: false };

    // Cached water detection status — updated every 60s by environment polling.
    // Stamped onto every log entry so career totals can filter out land tracks.
    private lastWaterStatus: boolean | undefined = undefined;

    // --- BATTLE-HARDENED GPS STREAMING ---
    // onLocation continuously caches the latest position. Timers decide WHEN to log,
    // but never block on getCurrentPosition. This survives background, suspension,
    // and cold starts — the position is always available.
    private lastBgLocation: CachedPosition | null = null;
    private bgUnsubscribers: (() => void)[] = []; // Cleanup handles for BgGeoManager subscriptions

    // --- GPS COLD-START WARM-UP ---
    // The first few seconds of GPS fixes after engine start can contain
    // "teleport" positions (stale cached fix from last session, hundreds of km away).
    // We still cache the position (for UI display) but don't buffer it for track
    // thinning or speed calculations until the warm-up period expires.
    private static readonly GPS_WARMUP_MS = 5_000; // 5 seconds
    private gpsWarmupStartTime: number = 0;

    // --- SPEED-ADAPTIVE INTERVAL ---
    // Tracks current speed tier and debounces tier changes to prevent
    // rapid flip-flopping when speed is borderline between tiers.
    private currentSpeedTier: SpeedTier | null = null;
    private pendingSpeedTier: SpeedTier | null = null;
    private speedTierConfirmCount = 0;
    private static readonly SPEED_TIER_DEBOUNCE = 3; // 3 consecutive fixes in new tier before switching

    // --- HIGH-FREQUENCY GPS BUFFER ---
    // Captures every GPS fix at device rate (1–10 Hz). On each interval tick,
    // the buffer is drained and RDP-thinned to keep only significant points.
    private trackBuffer = new GpsTrackBuffer();

    // --- POSITION-BASED COURSE CHANGE DETECTION ---
    // Uses decoupled position anchor + heading baseline:
    // lastValidPos: slides forward every tick (creates short recent vector)
    // baselineHeading: stays locked until a turn ≥22.5° is detected
    private courseCheckIntervalId?: NodeJS.Timeout;
    private lastValidPos: { lat: number; lon: number } | null = null;
    private baselineHeading: number | null = null;
    private static readonly COURSE_CHECK_INTERVAL_MS = 15_000; // Check every 15 seconds
    private static readonly COURSE_CHANGE_THRESHOLD_DEG = 22.5; // One compass point
    // MIN_MOVEMENT_M is now adaptive via GpsPrecision.getAdaptedThresholds()

    /**
     * Convert degrees (0-360) to 16-point compass cardinal.
     * N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW, NW, NNW
     */
    private static degreesToCardinal16(deg: number): string {
        const cardinals = [
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
        const index = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
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
     * Clear logging-interval timers (interval + quarter-hour timeout).
     * NOTE: Does NOT clear courseCheckIntervalId or envCheckIntervalId —
     * those have independent lifecycles managed by startCourseChangeDetection()
     * and startEnvironmentPolling() respectively, and must survive interval rescheduling.
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
            this.captureLogEntry()
                .then((entry) => {
                    if (entry) {
                    } else {
                    }
                })
                .catch((err) => {
                    log.warn(``, err);
                });

            // Start regular interval
            this.intervalId = setInterval(() => {
                this.captureLogEntry()
                    .then((entry) => {
                        if (entry) {
                        } else {
                        }
                    })
                    .catch((err) => {
                        log.warn(``, err);
                    });
            }, TRACKING_INTERVAL_MS);
        }, msUntil);
    }

    /**
     * Reschedule the logging interval based on current speed (primary)
     * or shore proximity (fallback).
     * Called after each GPS fix and from environment polling.
     * Does NOT apply when rapid mode is active.
     */
    private async rescheduleAdaptiveInterval(): Promise<void> {
        // Don't interfere with rapid mode
        if (this.trackingState.isRapidMode) return;
        if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

        // PRIMARY: Speed-adaptive interval (if we have GPS speed)
        const pos = this.lastBgLocation;
        if (pos && pos.speed != null && pos.speed >= 0) {
            const { interval, tier } = getIntervalForSpeed(pos.speed);
            const currentInterval = this.trackingState.currentIntervalMs;

            // Only reschedule if interval actually changed
            if (interval !== currentInterval || !this.intervalId) {
                this.trackingState.currentIntervalMs = interval;
                this.trackingState.loggingZone = undefined; // Speed-based, not zone-based
                await this.saveTrackingState();
                this.scheduleClockAlignedInterval(interval, `speed:${tier}`);
            }
            return;
        }

        // FALLBACK: Zone-based interval (no speed data yet — cold start)
        const newZone = determineLoggingZone();
        const newInterval = getIntervalForZone(newZone);
        const oldZone = this.trackingState.loggingZone || 'offshore';

        // Only reschedule if zone actually changed
        if (newZone === oldZone && this.intervalId) return;

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
            this.flushBufferedTrack()
                .then(() => {})
                .catch((err) => {
                    log.warn(``, err);
                });

            // Now setInterval for every subsequent mark
            this.intervalId = setInterval(() => {
                this.flushBufferedTrack()
                    .then(() => {})
                    .catch((err) => {
                        log.warn(``, err);
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

        // Initialize GPS engine (native-only: Transistorsoft BgGeo).
        // On web, GPS is started via navigator.geolocation in wireGpsSubscriptions().
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
        // Wire up continuous position caching via onLocation.
        // The timer decides WHEN to log; onLocation ensures GPS is ALWAYS fresh.
        this.gpsWarmupStartTime = Date.now(); // Start cold-start warm-up timer
        this.wireGpsSubscriptions();

        // IMMEDIATE ENTRY: Fire-and-forget — GPS acquisition runs in background
        // so the UI is not blocked by the 3s GPS warm-up loop.
        this.captureImmediateEntry().catch((e) => {
            log.warn(``, e);
        });

        // Reset position-based bearing tracker for new voyage
        this.lastValidPos = null;
        this.baselineHeading = null;
        this.startCourseChangeDetection();

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
        this.rescheduleAdaptiveInterval().catch((e) => {
            log.warn(``, e);
        });

        // --- 60-SECOND ENVIRONMENT POLLING ---
        // Checks water/land status and re-evaluates logging zone every minute.
        // This lets GPS interval adapt faster when transitioning environments
        // (e.g. leaving marina → offshore, or driving from land to coast).
        this.startEnvironmentPolling();
    }

    /**
     * Start 60-second environment polling.
     * Checks water/land status and updates the logging zone adaptively.
     */
    private startEnvironmentPolling(): void {
        // Clear any existing timer
        if (this.envCheckIntervalId) {
            clearInterval(this.envCheckIntervalId);
        }

        this.envCheckIntervalId = setInterval(async () => {
            if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

            const pos = this.lastBgLocation;
            if (!pos) return;

            try {
                // 1. Water/Land check
                const isWater = await checkIsOnWater(pos.latitude, pos.longitude);
                // Cache for stamping onto subsequent log entries
                this.lastWaterStatus = isWater;
                // Update EnvironmentService for UI consumers
                EnvironmentService.updateWaterStatus(isWater);

                // 2. Re-evaluate logging zone (nearshore/coastal/offshore)
                await this.rescheduleAdaptiveInterval();
            } catch (e) {
                console.warn('[ShipLog]', e);
                // Best effort — don't crash tracking
            }
        }, 60_000); // Every 60 seconds
    }

    /**
     * Wire up BgGeoManager subscriptions for GPS, heartbeat, and activity.
     * Called from startTracking() and when resuming from pause.
     */
    private wireGpsSubscriptions(): void {
        // Cleanup any stale subscriptions first
        this.cleanupGpsSubscriptions();

        // ── Shared position handler (used by both native and web GPS) ──
        const onGpsFix = (pos: CachedPosition) => {
            this.lastBgLocation = pos;

            // Feed accuracy into precision tracker (detects Bad Elf Pro+ etc.)
            GpsPrecision.feed(pos.accuracy);

            // Buffer fix for high-fidelity track thinning
            // COLD-START GUARD: Skip buffering during the first 5 seconds after
            // GPS engine start to filter out stale cached "teleport" fixes.
            const warmupElapsed = Date.now() - this.gpsWarmupStartTime;
            if (warmupElapsed < ShipLogServiceClass.GPS_WARMUP_MS) return;

            // SPEED-ADAPTIVE INTERVAL: Check if speed tier has changed.
            if (pos.speed != null && pos.speed >= 0 && !this.trackingState.isRapidMode) {
                const { tier } = getIntervalForSpeed(pos.speed);
                if (tier !== this.currentSpeedTier) {
                    if (tier === this.pendingSpeedTier) {
                        this.speedTierConfirmCount++;
                        if (this.speedTierConfirmCount >= ShipLogServiceClass.SPEED_TIER_DEBOUNCE) {
                            this.currentSpeedTier = tier;
                            this.pendingSpeedTier = null;
                            this.speedTierConfirmCount = 0;
                            this.rescheduleAdaptiveInterval().catch((e) => {
                                log.warn(``, e);
                            });
                        }
                    } else {
                        this.pendingSpeedTier = tier;
                        this.speedTierConfirmCount = 1;
                    }
                } else {
                    this.pendingSpeedTier = null;
                    this.speedTierConfirmCount = 0;
                }
            }

            // ACCURACY GATE: Drop fixes with >100m horizontal accuracy
            if (this.trackingState.isTracking && !this.trackingState.isPaused) {
                if (pos.accuracy <= 100) {
                    this.trackBuffer.push(pos);
                }
            }

            // Feed altitude to EnvironmentService for on-water/on-land detection
            if (pos.altitude !== null && pos.altitude !== undefined) {
                EnvironmentService.updateFromGPS({ altitude: pos.altitude });
            }
        };

        // ── 1a. Native GPS stream (BgGeoManager / Transistorsoft) ──
        if (this.isNative) {
            const unsubLoc = BgGeoManager.subscribeLocation(onGpsFix);
            this.bgUnsubscribers.push(unsubLoc);
        } else {
            // ── 1a-WEB. Browser geolocation.watchPosition ──
            if (navigator.geolocation) {
                this.webWatchId = navigator.geolocation.watchPosition(
                    (geoPos) => {
                        onGpsFix({
                            latitude: geoPos.coords.latitude,
                            longitude: geoPos.coords.longitude,
                            accuracy: geoPos.coords.accuracy,
                            altitude: geoPos.coords.altitude,
                            heading: geoPos.coords.heading ?? 0,
                            speed: geoPos.coords.speed ?? 0,
                            timestamp: geoPos.timestamp,
                            receivedAt: Date.now(),
                        } as CachedPosition);
                    },
                    (err) => console.warn('[ShipLog] web GPS error:', err.message),
                    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
                );
                this.bgUnsubscribers.push(() => {
                    if (this.webWatchId != null) {
                        navigator.geolocation.clearWatch(this.webWatchId);
                        this.webWatchId = undefined;
                    }
                });
            }
        }

        // ── 1b. NMEA/External GPS — works on ALL platforms ──
        const unsubNmea = NmeaGpsProvider.onPosition((nmeaPos) => {
            // Convert NmeaGpsPosition to CachedPosition shape for compatibility
            this.lastBgLocation = {
                latitude: nmeaPos.latitude,
                longitude: nmeaPos.longitude,
                accuracy: nmeaPos.accuracy,
                heading: nmeaPos.heading,
                speed: nmeaPos.speed / 1.94384, // SOG kts → m/s (BgGeo uses m/s)
                timestamp: nmeaPos.timestamp,
                receivedAt: Date.now(),
                altitude: null,
            } as CachedPosition;

            GpsPrecision.feed(nmeaPos.accuracy);

            if (this.trackingState.isTracking && !this.trackingState.isPaused) {
                this.trackBuffer.push(this.lastBgLocation);
            }
        });
        this.bgUnsubscribers.push(unsubNmea);

        // ── 2. HEARTBEAT — 60s safety net for missed entries ──
        if (this.isNative) {
            const unsubHb = BgGeoManager.subscribeHeartbeat((_event) => {
                if (!this.trackingState.isTracking || this.trackingState.isPaused) return;
                const lastEntry = this.trackingState.lastEntryTime;
                if (lastEntry) {
                    const elapsed = Date.now() - new Date(lastEntry).getTime();
                    const currentInterval = this.trackingState.currentIntervalMs || TRACKING_INTERVAL_MS;
                    if (elapsed >= currentInterval) {
                        this.flushBufferedTrack().catch((e) => {
                            log.warn(``, e);
                        });
                    }
                }
            });
            this.bgUnsubscribers.push(unsubHb);
        } else {
            // WEB: setInterval heartbeat (no native background wake-up on web)
            this.webHeartbeatId = setInterval(() => {
                if (!this.trackingState.isTracking || this.trackingState.isPaused) return;
                const lastEntry = this.trackingState.lastEntryTime;
                if (lastEntry) {
                    const elapsed = Date.now() - new Date(lastEntry).getTime();
                    const currentInterval = this.trackingState.currentIntervalMs || TRACKING_INTERVAL_MS;
                    if (elapsed >= currentInterval) {
                        this.flushBufferedTrack().catch((e) => {
                            log.warn(``, e);
                        });
                    }
                }
            }, 60_000);
            this.bgUnsubscribers.push(() => {
                if (this.webHeartbeatId) {
                    clearInterval(this.webHeartbeatId);
                    this.webHeartbeatId = undefined;
                }
            });
        }

        // ── 3. ACTIVITY CHANGE — native only (desktop has no motion sensors) ──
        if (this.isNative) {
            const unsubAct = BgGeoManager.subscribeActivity((_event) => {
                // Activity-based detection; auto-pause handled by distance in captureLogEntry
            });
            this.bgUnsubscribers.push(unsubAct);
        }
    }

    /**
     * Start position-based course change detection.
     * Every 15 seconds, computes a SHORT recent movement vector and
     * compares it against a locked baseline heading.
     *
     * ALGORITHM (decoupled position anchor + heading baseline):
     * - lastValidPos: slides forward EVERY tick → creates a short recent vector
     * - baselineHeading: stays locked until cumulative turn ≥22.5° is detected
     *
     * This fixes the old "bearing from origin" bug where long straight legs
     * diluted the turn signal (e.g. sail 1km N, turn NNE → bearing from
     * origin barely changes because the 1km leg dominates).
     */
    private startCourseChangeDetection(): void {
        // Clear any existing timer
        if (this.courseCheckIntervalId) {
            clearInterval(this.courseCheckIntervalId);
        }

        this.courseCheckIntervalId = setInterval(() => {
            if (!this.trackingState.isTracking || this.trackingState.isPaused) return;

            const pos = this.lastBgLocation;
            if (!pos) return;

            const currentPos = { lat: pos.latitude, lon: pos.longitude };

            // 1. Seed the initial position
            if (!this.lastValidPos) {
                this.lastValidPos = currentPos;
                return;
            }

            // 2. Distance check — filters GPS jitter when stationary
            const R = 6371000;
            const dLat = ((currentPos.lat - this.lastValidPos.lat) * Math.PI) / 180;
            const dLon = ((currentPos.lon - this.lastValidPos.lon) * Math.PI) / 180;
            const a =
                Math.sin(dLat / 2) ** 2 +
                Math.cos((this.lastValidPos.lat * Math.PI) / 180) *
                    Math.cos((currentPos.lat * Math.PI) / 180) *
                    Math.sin(dLon / 2) ** 2;
            const distM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

            const minMovement = GpsPrecision.getAdaptedThresholds().courseChangeMinMovementM;
            if (distM < minMovement) return;

            // 3. Calculate RECENT bearing — short vector from last position to current
            const recentBearing = bearing(this.lastValidPos.lat, this.lastValidPos.lon, currentPos.lat, currentPos.lon);

            // 4. CRITICAL: Slide position anchor forward EVERY tick.
            //    This ensures the bearing vector is always SHORT and RECENT,
            //    not diluted by long straight legs behind us.
            this.lastValidPos = currentPos;

            // 5. Seed the baseline heading on first valid movement
            if (this.baselineHeading === null) {
                this.baselineHeading = recentBearing;
                return;
            }

            // 6. Compare recent movement vector against locked baseline
            const delta = headingDelta(this.baselineHeading, recentBearing);

            if (delta >= ShipLogServiceClass.COURSE_CHANGE_THRESHOLD_DEG) {
                const oldCardinal = ShipLogServiceClass.degreesToCardinal16(this.baselineHeading);
                const newCardinal = ShipLogServiceClass.degreesToCardinal16(recentBearing);

                // Reset baseline heading to new direction of travel
                this.baselineHeading = recentBearing;

                log.info(`Turn detected: ${oldCardinal} → ${newCardinal} (Δ${delta.toFixed(1)}°)`);

                // Fire-and-forget waypoint entry
                this.captureLogEntry(
                    'waypoint',
                    `Auto: COG ${oldCardinal} → ${newCardinal}`,
                    `COG ${oldCardinal} → ${newCardinal}`,
                    'navigation',
                ).catch(() => {
                    /* best effort */
                });
            }
            // No else — baseline heading stays locked at last committed turn
        }, ShipLogServiceClass.COURSE_CHECK_INTERVAL_MS);
    }

    /**
     * Clean up all BgGeoManager subscriptions.
     */
    private cleanupGpsSubscriptions(): void {
        this.bgUnsubscribers.forEach((unsub) => {
            try {
                unsub();
            } catch (e) {
                console.warn('[ShipLog] already cleaned up:', e);
            }
        });
        this.bgUnsubscribers = [];
    }

    /**
     * Get the best available GPS position.
     * Uses cached onLocation position if fresh, otherwise falls back to getCurrentPosition.
     * This is the ONLY place that should resolve GPS for log entries.
     */
    private async getBestPosition(): Promise<CachedPosition | null> {
        // Prefer NMEA/external GPS if available (higher accuracy)
        const nmeaPos = NmeaGpsProvider.getPosition();
        if (nmeaPos) {
            return {
                latitude: nmeaPos.latitude,
                longitude: nmeaPos.longitude,
                accuracy: nmeaPos.accuracy,
                heading: nmeaPos.heading,
                speed: nmeaPos.speed / 1.94384, // SOG kts → m/s
                timestamp: nmeaPos.timestamp,
                receivedAt: Date.now(),
                altitude: null,
            } as CachedPosition;
        }

        // Check cached phone GPS position freshness
        if (this.lastBgLocation) {
            const age = Date.now() - this.lastBgLocation.receivedAt;
            if (age < GPS_STALE_LIMIT_MS) {
                return this.lastBgLocation;
            }
        }

        // Cache is stale or empty — fetch fresh (blocking, but only as fallback)
        if (this.isNative) {
            return BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 15);
        }
        // Web: use GpsService (navigator.geolocation with permission prompt)
        const webPos = await GpsService.getCurrentPosition({ staleLimitMs: GPS_STALE_LIMIT_MS, timeoutSec: 15 });
        if (!webPos) return null;
        return {
            latitude: webPos.latitude,
            longitude: webPos.longitude,
            accuracy: webPos.accuracy,
            altitude: webPos.altitude,
            heading: webPos.heading ?? 0,
            speed: webPos.speed,
            timestamp: webPos.timestamp,
            receivedAt: Date.now(),
        } as CachedPosition;
    }

    /**
     * Web fallback for BgGeoManager.getFreshPosition() — uses GpsService
     * which calls navigator.geolocation.getCurrentPosition with permission prompt.
     */
    private async _webGetFreshPosition(): Promise<CachedPosition | null> {
        const pos = await GpsService.getCurrentPosition({ staleLimitMs: 10_000, timeoutSec: 10 });
        if (!pos) return null;
        return {
            latitude: pos.latitude,
            longitude: pos.longitude,
            accuracy: pos.accuracy,
            altitude: pos.altitude,
            heading: pos.heading ?? 0,
            speed: pos.speed,
            timestamp: pos.timestamp,
            receivedAt: Date.now(),
        } as CachedPosition;
    }

    /**
     * GPS HEALTH STATUS — Public API for UI indicators.
     * Returns the current GPS fix quality:
     *   'locked'  — fresh fix received within 60s (green)
     *   'stale'   — last fix is 60s–300s old (amber)
     *   'none'    — no fix ever received, or older than 5min (red)
     */
    getGpsStatus(): 'locked' | 'stale' | 'none' {
        const pos = this.lastBgLocation || (this.isNative ? BgGeoManager.getLastPosition() : null);
        if (!pos) return 'none';

        const ageMs = Date.now() - pos.receivedAt;
        if (ageMs < GPS_STALE_LIMIT_MS) return 'locked'; // < 60s
        if (ageMs < 5 * 60 * 1000) return 'stale'; // 60s – 5min
        return 'none'; // > 5min
    }

    /**
     * Get GPS navigation data (SOG and COG) for dashboard display.
     * Returns speed over ground in knots and course over ground in degrees.
     */
    getGpsNavData(): { sogKts: number | null; cogDeg: number | null } {
        const pos = this.lastBgLocation || (this.isNative ? BgGeoManager.getLastPosition() : null);
        if (!pos) return { sogKts: null, cogDeg: null };

        const ageMs = Date.now() - pos.receivedAt;
        if (ageMs > GPS_STALE_LIMIT_MS) return { sogKts: null, cogDeg: null };

        const sogKts =
            pos.speed != null && pos.speed >= 0
                ? parseFloat((pos.speed * 1.94384).toFixed(1)) // m/s → knots
                : null;
        const cogDeg = pos.heading != null && pos.heading >= 0 ? Math.round(pos.heading) : null;
        return { sogKts, cogDeg };
    }

    /**
     * Pause tracking (user initiated)
     */
    async pauseTracking(): Promise<void> {
        this.clearAllTimers();

        // Stop course change detection + environment polling while paused
        if (this.courseCheckIntervalId) {
            clearInterval(this.courseCheckIntervalId);
            this.courseCheckIntervalId = undefined;
        }
        if (this.envCheckIntervalId) {
            clearInterval(this.envCheckIntervalId);
            this.envCheckIntervalId = undefined;
        }

        // Clear GPS buffer — no points to log while paused
        this.trackBuffer.clear();

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

        // Flush any remaining buffered GPS points before stopping
        try {
            await this.flushBufferedTrack();
        } catch (e) {
            console.warn('[ShipLog] best effort:', e);
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

        // Reset course change detection
        this.lastValidPos = null;
        this.baselineHeading = null;
        if (this.courseCheckIntervalId) {
            clearInterval(this.courseCheckIntervalId);
            this.courseCheckIntervalId = undefined;
        }
        // Stop environment polling
        if (this.envCheckIntervalId) {
            clearInterval(this.envCheckIntervalId);
            this.envCheckIntervalId = undefined;
        }

        // Reset precision GPS tracker for next voyage
        GpsPrecision.reset();

        // Capture final entry BEFORE cleaning up GPS — ensures end coordinates are captured
        // GPS subscriptions are still alive here so getBestPosition() can use cached fix
        await this.captureImmediateEntry(previousVoyageId, 'Voyage End').catch((err) => {
            log.warn(``, err);
        });

        // NOW clean up GPS stream subscriptions (after final entry has GPS)
        this.cleanupGpsSubscriptions();

        // Clear voyage data
        await Preferences.remove({ key: LAST_POSITION_KEY });
        await Preferences.remove({ key: VOYAGE_START_KEY });

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
                        : await this._webGetFreshPosition();
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
                console.warn('[ShipLog]', e);
                entry.isOnWater = true; // Fail open
            }
        } else {
            // No GPS at all after warm-up — will retry in background
            needsGpsRetry = true;
        }

        // Track entry ID for potential GPS update later
        let savedEntryId: string | null = null;

        // Save the entry (online or offline queue)
        // OFFLINE-FAST-PATH: If we know we're offline, skip Supabase entirely.
        // This prevents the tracking pipeline from stalling on hung network calls.
        const isOnline = typeof navigator !== 'undefined' && navigator.onLine && !isSatelliteMode();
        if (supabase && isOnline) {
            try {
                // 5-second timeout: safety net in case navigator.onLine lies
                const saveResult = await Promise.race([
                    (async () => {
                        const {
                            data: { user },
                        } = await supabase.auth.getUser();
                        if (user) {
                            const { data, error } = await supabase
                                .from(SHIP_LOGS_TABLE)
                                .insert(toDbFormat({ ...entry, userId: user.id }))
                                .select()
                                .single();
                            if (error) return 'offline' as const;
                            savedEntryId = data.id;
                            return fromDbFormat(data);
                        }
                        return 'offline' as const;
                    })(),
                    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
                ]);

                if (saveResult === 'offline' || saveResult === 'timeout') {
                    await this.queueOfflineEntry(entry);
                } else {
                    // If GPS failed initially, retry in background
                    if (needsGpsRetry && savedEntryId) {
                        this.retryGpsAndUpdateEntry(savedEntryId);
                    }
                    return saveResult;
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
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

            try {
                // Use fresh position (native: BgGeoManager, web: GpsService)
                const pos = this.isNative
                    ? await BgGeoManager.getFreshPosition(5000, 10)
                    : await this._webGetFreshPosition();
                if (!pos) continue; // No GPS yet, retry

                const { latitude, longitude, heading } = pos;
                const positionFormatted = formatPositionDMS(latitude, longitude);

                // Update the database entry with the acquired position
                if (supabase) {
                    const updateData = toDbFormat({
                        latitude,
                        longitude,
                        positionFormatted,
                    });
                    if (heading !== null && heading !== undefined && heading !== 0) {
                        updateData.course_deg = Math.round(heading);
                    }

                    const { error } = await supabase.from(SHIP_LOGS_TABLE).update(updateData).eq('id', entryId);

                    if (error) {
                    } else {
                        // Update last position
                        await this.saveLastPosition({
                            latitude,
                            longitude,
                            timestamp: new Date().toISOString(),
                            cumulativeDistanceNM: 0,
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
            const {
                data: { user },
            } = await supabase.auth.getUser();
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
        } catch (e) {
            console.warn('[ShipLog]', e);
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

                // SPEED SANITY: Final safety net — clamp at 600 kn.
                // Cold-start GPS teleports are handled by the 5-second warm-up filter
                // in wireGpsSubscriptions, so this cap only catches truly absurd values.
                // 600 kn covers all legitimate use cases (planes, fast vessels).
                if (speedKts > 600) speedKts = 0;
                // Ignore speed when previous position was the 0,0 placeholder from captureImmediateEntry
                if (lastPos.latitude === 0 && lastPos.longitude === 0) speedKts = 0;

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

            // Try to save to Supabase (online)
            // OFFLINE-FAST-PATH: Skip Supabase entirely when we know we're offline.
            // This is the critical fix for airplane mode tracking — without it,
            // supabase.auth.getUser() hangs indefinitely, stalling the entire
            // flushBufferedTrack pipeline and stopping GPS logging.
            const isOnline = typeof navigator !== 'undefined' && navigator.onLine && !isSatelliteMode();
            if (supabase && isOnline) {
                try {
                    // 5-second timeout: safety net in case navigator.onLine lies
                    const saveResult = await Promise.race([
                        (async () => {
                            const {
                                data: { user },
                            } = await supabase.auth.getUser();
                            if (user) {
                                const { data, error } = await supabase
                                    .from(SHIP_LOGS_TABLE)
                                    .insert(toDbFormat({ ...entry, userId: user.id }))
                                    .select()
                                    .single();

                                if (error) return 'offline' as const;

                                // Update last position in storage
                                await this.saveLastPosition({
                                    latitude,
                                    longitude,
                                    timestamp,
                                    cumulativeDistanceNM,
                                });

                                return fromDbFormat(data);
                            }
                            return 'offline' as const;
                        })(),
                        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
                    ]);

                    if (saveResult === 'offline' || saveResult === 'timeout') {
                        await this.queueOfflineEntry(entry);
                    } else {
                        return saveResult;
                    }
                } catch (networkError) {
                    // Offline - queue for later
                    await this.queueOfflineEntry(entry);
                }
            } else {
                // Offline or no Supabase - queue locally
                await this.queueOfflineEntry(entry);
            }

            // Still update last position even if queued
            await this.saveLastPosition({
                latitude,
                longitude,
                timestamp,
                cumulativeDistanceNM,
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

            return entry as ShipLogEntry;
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

        // Save the entry (online or offline queue)
        const isOnline = typeof navigator !== 'undefined' && navigator.onLine && !isSatelliteMode();
        if (supabase && isOnline) {
            try {
                const saveResult = await Promise.race([
                    (async () => {
                        const {
                            data: { user },
                        } = await supabase.auth.getUser();
                        if (user) {
                            const { data, error } = await supabase
                                .from(SHIP_LOGS_TABLE)
                                .insert(toDbFormat({ ...entry, userId: user.id }))
                                .select()
                                .single();
                            if (error) return 'offline' as const;
                            return fromDbFormat(data);
                        }
                        return 'offline' as const;
                    })(),
                    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
                ]);

                if (saveResult === 'offline' || saveResult === 'timeout') {
                    await this.queueOfflineEntry(entry);
                } else {
                    return saveResult;
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
            this.captureLogEntry().catch((err) => {
                log.warn(``, err);
            });

            // Start 5-second interval
            this.intervalId = setInterval(() => {
                this.captureLogEntry()
                    .then((entry) => {
                        if (entry) {
                        }
                    })
                    .catch((err) => {
                        log.warn(``, err);
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

    private async saveTrackingState(): Promise<void> {
        await Preferences.set({
            key: TRACKING_STATE_KEY,
            value: JSON.stringify(this.trackingState),
        });
    }

    private async getLastPosition(): Promise<StoredPosition | null> {
        try {
            const { value } = await Preferences.get({ key: LAST_POSITION_KEY });
            return value ? JSON.parse(value) : null;
        } catch (e) {
            console.warn('[ShipLog]', e);
            /* Preferences read/parse failure — null signals no cached position */
            return null;
        }
    }

    private async saveLastPosition(position: StoredPosition): Promise<void> {
        await Preferences.set({
            key: LAST_POSITION_KEY,
            value: JSON.stringify(position),
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

    /**
     * Save a passage plan's route to the logbook as a "planned_route" voyage.
     * These entries show as suggested/uncharted tracks with restricted actions.
     */
    async savePassagePlanToLogbook(plan: import('../types').VoyagePlan): Promise<string | null> {
        try {
            const voyageId = `planned_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            const now = new Date().toISOString();

            // Build waypoint chain: origin → waypoints → destination
            const allPoints: { lat: number; lon: number; name: string; isWP: boolean }[] = [];

            if (plan.originCoordinates) {
                allPoints.push({
                    lat: plan.originCoordinates.lat,
                    lon: plan.originCoordinates.lon,
                    name: typeof plan.origin === 'string' ? plan.origin.split(',')[0] : 'Departure',
                    isWP: false,
                });
            }

            for (const wp of plan.waypoints || []) {
                if (wp.coordinates) {
                    allPoints.push({
                        lat: wp.coordinates.lat,
                        lon: wp.coordinates.lon,
                        name: wp.name || 'Waypoint',
                        isWP: true,
                    });
                }
            }

            if (plan.destinationCoordinates) {
                allPoints.push({
                    lat: plan.destinationCoordinates.lat,
                    lon: plan.destinationCoordinates.lon,
                    name: typeof plan.destination === 'string' ? plan.destination.split(',')[0] : 'Arrival',
                    isWP: false,
                });
            }

            if (allPoints.length < 2) {
                log.error('Passage plan has insufficient waypoints');
                return null;
            }

            // Create entries with distance calculations
            let cumulativeNM = 0;
            const entries: Partial<ShipLogEntry>[] = [];

            for (let i = 0; i < allPoints.length; i++) {
                const pt = allPoints[i];
                let distNM = 0;
                let courseDeg: number | undefined;

                if (i > 0) {
                    const prev = allPoints[i - 1];
                    distNM = calculateDistanceNM(prev.lat, prev.lon, pt.lat, pt.lon);
                    courseDeg = calculateBearing(prev.lat, prev.lon, pt.lat, pt.lon);
                }
                cumulativeNM += distNM;

                // Timestamps: spread entries over the estimated duration
                const depDate = plan.departureDate ? new Date(plan.departureDate) : new Date();
                const fraction = allPoints.length > 1 ? i / (allPoints.length - 1) : 0;
                // Rough duration estimate: parse from plan or default 12h
                const durationHrs = parseFloat(plan.durationApprox) || 12;
                const entryTime = new Date(depDate.getTime() + fraction * durationHrs * 3600000);

                entries.push({
                    id: `${voyageId}_${i}`,
                    voyageId,
                    timestamp: entryTime.toISOString(),
                    latitude: pt.lat,
                    longitude: pt.lon,
                    positionFormatted: formatPositionDMS(pt.lat, pt.lon),
                    distanceNM: Math.round(distNM * 100) / 100,
                    cumulativeDistanceNM: Math.round(cumulativeNM * 100) / 100,
                    courseDeg,
                    entryType: pt.isWP ? 'waypoint' : 'auto',
                    source: 'planned_route',
                    waypointName: pt.name,
                    notes: i === 0 ? `Planned: ${plan.origin} → ${plan.destination}` : undefined,
                    isOnWater: true,
                    createdAt: now,
                });
            }

            // Try Supabase first, fall back to offline queue
            let savedOnline = false;
            if (supabase) {
                try {
                    const {
                        data: { user },
                    } = await supabase.auth.getUser();
                    if (user) {
                        const dbEntries = entries.map((e) => toDbFormat({ ...e, userId: user.id }));
                        const { error } = await supabase.from(SHIP_LOGS_TABLE).insert(dbEntries);
                        if (error) {
                            log.warn('savePassagePlan: Supabase insert failed, queuing offline:', error.message);
                        } else {
                            savedOnline = true;
                        }
                    } else {
                        log.warn('savePassagePlan: No authenticated user, queuing offline');
                    }
                } catch (networkError) {
                    log.warn('savePassagePlan: Network error, queuing offline');
                }
            }

            // Fallback: queue all entries to offline queue
            if (!savedOnline) {
                for (const entry of entries) {
                    await this.queueOfflineEntry(entry);
                }
            }

            log.info(
                `✓ Saved planned route "${plan.origin} → ${plan.destination}" with ${entries.length} waypoints (${cumulativeNM.toFixed(1)} NM) [${savedOnline ? 'online' : 'offline'}]`,
            );
            return voyageId;
        } catch (err) {
            log.error('savePassagePlanToLogbook error:', err);
            return null;
        }
    }

    async getOfflineEntries(): Promise<ShipLogEntry[]> {
        return _getOfflineEntries();
    }
}

// Export singleton instance
export const ShipLogService = new ShipLogServiceClass();
