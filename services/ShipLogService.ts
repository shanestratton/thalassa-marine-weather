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
import { windToBeaufort, waveToSeaState, getWatchPeriod } from '../utils/marineFormatters';
import { loadLargeData, DATA_CACHE_KEY } from './nativeStorage';
import { BgGeoManager, CachedPosition } from './BgGeoManager';
import { EnvironmentService } from './EnvironmentService';

// Staleness threshold: if cached GPS is older than this, fetch fresh
const GPS_STALE_LIMIT_MS = 60_000; // 60 seconds

// --- CONSTANTS ---
const TRACKING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (legacy default / offshore)
const RAPID_INTERVAL_MS = 5 * 1000; // 5 seconds for marina/shore navigation (manual override)
const STATIONARY_THRESHOLD_NM = 0.05; // Less than 0.05nm movement = anchored
const STATIONARY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour without movement = auto-pause
const DEDUP_THRESHOLD_NM = 0.0027; // ~5 meters — discard auto entry if vessel hasn't moved
const VOYAGE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours — start new voyage instead of resuming
const EARTH_RADIUS_NM = 3440.065; // Earth's radius in nautical miles

// --- ADAPTIVE LOGGING INTERVALS ---
// Intervals adjust based on distance from shore for optimal detail vs battery/storage
const NEARSHORE_INTERVAL_MS = 30 * 1000;      // 30 seconds (< 1nm from shore / on land)
const COASTAL_INTERVAL_MS = 2 * 60 * 1000;    // 2 minutes (1-5nm from shore)
const OFFSHORE_INTERVAL_MS = 15 * 60 * 1000;  // 15 minutes (> 5nm offshore)

// Shore distance thresholds in kilometers (1nm = 1.852km)
const NEARSHORE_THRESHOLD_KM = 1.852;   // < 1nm from shore
const COASTAL_THRESHOLD_KM = 9.26;      // < 5nm from shore

type LoggingZone = 'nearshore' | 'coastal' | 'offshore';

// --- STORAGE KEYS ---
const TRACKING_STATE_KEY = 'ship_log_tracking_state';
const LAST_POSITION_KEY = 'ship_log_last_position';
const VOYAGE_START_KEY = 'ship_log_voyage_start';
const OFFLINE_QUEUE_KEY = 'ship_log_offline_queue'; // Queue for offline entries

// --- INTERFACES ---

interface TrackingState {
    isTracking: boolean;
    isPaused: boolean;
    isRapidMode: boolean; // 5-second rapid GPS mode for marina/shore navigation
    currentVoyageId?: string; // Unique ID for current voyage
    voyageStartTime?: string;
    voyageEndTime?: string;   // Stored immediately on stopTracking for reliability
    lastMovementTime?: string;
    lastEntryTime?: string;   // Track when last entry was created for catch-up
    loggingZone?: LoggingZone;       // Current adaptive logging zone
    currentIntervalMs?: number;       // Current interval in ms (for display/debugging)
}

interface StoredPosition {
    latitude: number;
    longitude: number;
    timestamp: string;
    cumulativeDistanceNM: number;
}

// --- HELPER FUNCTIONS ---

/**
 * Calculate distance between two coordinates using Haversine formula
 * @returns Distance in nautical miles
 */
function calculateDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_NM * c;
}

/**
 * Calculate initial bearing (COG) between two coordinates
 * @returns Bearing in degrees True (0-360)
 */
function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const x = Math.sin(dLon) * Math.cos(lat2Rad);
    const y = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
        Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

    let bearing = Math.atan2(x, y) * 180 / Math.PI;

    // Normalize to 0-360
    bearing = (bearing + 360) % 360;

    return bearing;
}

/**
 * Format coordinates as DMS (Degrees Minutes Seconds)
 * Example: "27°28.5'S 153°22.1'E"
 */
function formatPositionDMS(lat: number, lon: number): string {
    const latDeg = Math.abs(lat);
    const latMin = (latDeg % 1) * 60;
    const latDir = lat >= 0 ? 'N' : 'S';

    const lonDeg = Math.abs(lon);
    const lonMin = (lonDeg % 1) * 60;
    const lonDir = lon >= 0 ? 'E' : 'W';

    return `${Math.floor(latDeg)}°${latMin.toFixed(1)}'${latDir} ${Math.floor(lonDeg)}°${lonMin.toFixed(1)}'${lonDir}`;
}

/**
 * Calculate the next quarter-hour time (snaps to :00, :15, :30, :45)
 * Example: If current time is 07:14, returns 07:15
 *          If current time is 07:15, returns 07:30
 * 
 * IMPORTANT: Adds 30-second buffer to account for GPS acquisition time.
 * Timer fires at :00:30, :15:30, :30:30, :45:30 to ensure the entry
 * timestamp falls on or after the quarter hour.
 */
function getNextQuarterHour(): { nextTime: Date; msUntil: number } {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ms = now.getMilliseconds();

    // Calculate next quarter hour
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    const next = new Date(now);

    if (nextQuarter >= 60) {
        next.setHours(next.getHours() + 1);
        next.setMinutes(0);
    } else {
        next.setMinutes(nextQuarter);
    }
    // Add 30-second buffer for GPS acquisition time
    // Entry will be captured at :00:30, :15:30, :30:30, :45:30
    next.setSeconds(30);
    next.setMilliseconds(0);

    const msUntil = next.getTime() - now.getTime();

    return { nextTime: next, msUntil };
}

// --- DATABASE FIELD MAPPING ---
// Supabase/PostgreSQL uses snake_case, TypeScript uses camelCase

/**
 * Convert ShipLogEntry to database format (snake_case)
 */
function toDbFormat(entry: Partial<ShipLogEntry>): Record<string, any> {
    const mapping: Record<string, string> = {
        id: 'id',
        userId: 'user_id',
        voyageId: 'voyage_id',
        timestamp: 'timestamp',
        latitude: 'latitude',
        longitude: 'longitude',
        positionFormatted: 'position_formatted',
        distanceNM: 'distance_nm',
        cumulativeDistanceNM: 'cumulative_distance_nm',
        speedKts: 'speed_kts',
        courseDeg: 'course_deg',
        windSpeed: 'wind_speed',
        windDirection: 'wind_direction',
        waveHeight: 'wave_height',
        pressure: 'pressure',
        airTemp: 'air_temp',
        waterTemp: 'water_temp',
        visibility: 'visibility',
        seaState: 'sea_state',
        beaufortScale: 'beaufort_scale',
        entryType: 'entry_type',
        source: 'source',
        eventCategory: 'event_category',
        engineStatus: 'engine_status',
        notes: 'notes',
        waypointName: 'waypoint_name',
        watchPeriod: 'watch_period',
        createdAt: 'created_at'
    };

    const dbEntry: Record<string, any> = {};
    for (const [key, value] of Object.entries(entry)) {
        const dbKey = mapping[key];
        // Only include fields that are explicitly mapped to DB columns
        if (dbKey && value !== undefined) {
            dbEntry[dbKey] = value;
        }
    }
    return dbEntry;
}

/**
 * Convert database row to ShipLogEntry format (camelCase)
 */
function fromDbFormat(row: Record<string, any>): ShipLogEntry {
    return {
        id: row.id,
        userId: row.user_id,
        voyageId: row.voyage_id,
        timestamp: row.timestamp,
        latitude: row.latitude,
        longitude: row.longitude,
        positionFormatted: row.position_formatted,
        distanceNM: row.distance_nm,
        cumulativeDistanceNM: row.cumulative_distance_nm,
        speedKts: row.speed_kts,
        courseDeg: row.course_deg,
        windSpeed: row.wind_speed,
        windDirection: row.wind_direction,
        waveHeight: row.wave_height,
        pressure: row.pressure,
        airTemp: row.air_temp,
        waterTemp: row.water_temp,
        visibility: row.visibility,
        seaState: row.sea_state,
        beaufortScale: row.beaufort_scale,
        entryType: row.entry_type || 'auto',
        source: row.source || 'device',
        eventCategory: row.event_category,
        engineStatus: row.engine_status,
        notes: row.notes,
        waypointName: row.waypoint_name,
        watchPeriod: row.watch_period,
        createdAt: row.created_at
    };
}

// Database table name
const SHIP_LOGS_TABLE = 'ship_logs';

/**
 * Get current weather data from cache for snapshot
 * Includes IMO-compliant calculations for Beaufort, sea state, and watch period
 */
async function getWeatherSnapshot(): Promise<Partial<ShipLogEntry>> {
    // Determine current watch period
    const now = new Date();
    const watchPeriod = getWatchPeriod(now.getHours());

    try {
        // Get weather from the correct cache using nativeStorage
        const cache = await loadLargeData(DATA_CACHE_KEY);
        if (!cache) {
            return { watchPeriod };
        }

        const current = cache?.current;
        if (!current) {
            return { watchPeriod };
        }

        // Extract base weather values
        const windSpeed = current.windSpeed ?? undefined;
        const waveHeight = current.waveHeight ?? undefined;
        const visibility = current.visibility ?? undefined;

        // Calculate IMO-compliant scales
        const beaufortScale = windSpeed !== undefined ? windToBeaufort(windSpeed) : undefined;
        const seaState = waveHeight !== undefined ? waveToSeaState(waveHeight) : undefined;

        return {
            windSpeed,
            windDirection: current.windDirectionCardinal || current.windDirection,
            waveHeight,
            pressure: current.pressure,
            airTemp: current.airTemperature,
            waterTemp: current.waterTemperature,
            visibility,
            beaufortScale,
            seaState,
            watchPeriod
        };
    } catch (error) {
        return { watchPeriod };
    }
}

// --- ADAPTIVE LOGGING ZONE DETECTION ---

/**
 * Determine the logging zone based on cached weather data's distance-to-land.
 * Uses the last weather report to avoid extra API calls per GPS fix.
 * 
 * SAFETY-FIRST: Falls back to 'nearshore' (30s) when uncertain.
 * On a boat, missing a GPS fix is worse than an extra one.
 */
async function determineLoggingZone(): Promise<LoggingZone> {
    try {
        // Read cached weather data (same cache used by the dashboard)
        const cachedDataStr = await loadLargeData(DATA_CACHE_KEY);
        if (!cachedDataStr) {
            return 'nearshore'; // No data = safe default, frequent fixes
        }

        const cachedData = JSON.parse(cachedDataStr);

        // IMMEDIATE CHECK: isLandlocked flag (set by transformers.ts when locationType === 'inland')
        // This is the most reliable signal — if we know we're on land, use 30s interval
        if (cachedData?.isLandlocked === true) {
            return 'nearshore'; // On land = high detail (30s)
        }

        // The weather data includes location type classification
        const locationType = cachedData?.locationType;

        // PRIORITY 1: Use locationType classification (most reliable signal)
        // Check this BEFORE distToLandKm because locationType accounts for
        // elevation, tides, and wave data — not just raw distance.
        if (locationType === 'inland') return 'nearshore';   // On land = 30s
        if (locationType === 'coastal') return 'coastal';    // Near shore = 2min
        if (locationType === 'offshore') {
            // Double-check: If we have distToLandKm, use it for zone refinement
            // within the "offshore" classification (might be just outside 5nm)
            if (cachedData?.distToLandKm !== undefined && cachedData.distToLandKm !== null) {
                const distKm = cachedData.distToLandKm;
                if (distKm <= NEARSHORE_THRESHOLD_KM) return 'nearshore';
                if (distKm <= COASTAL_THRESHOLD_KM) return 'coastal';
            }
            return 'offshore'; // Confirmed offshore = 15min
        }

        // PRIORITY 2: If locationType is missing but distToLandKm exists, use distance
        if (cachedData?.distToLandKm !== undefined && cachedData.distToLandKm !== null) {
            const distKm = cachedData.distToLandKm;
            if (distKm <= NEARSHORE_THRESHOLD_KM) return 'nearshore';
            if (distKm <= COASTAL_THRESHOLD_KM) return 'coastal';
            return 'offshore';
        }

        // SAFETY FALLBACK: No locationType AND no distToLandKm
        // Default to nearshore (30s) — safer to log too often than too rarely
        return 'nearshore';
    } catch (error) {
        return 'nearshore'; // Fail safe = frequent fixes
    }
}

/**
 * Get the appropriate logging interval for a given zone
 */
function getIntervalForZone(zone: LoggingZone): number {
    switch (zone) {
        case 'nearshore': return NEARSHORE_INTERVAL_MS;   // 30 seconds
        case 'coastal': return COASTAL_INTERVAL_MS;     // 2 minutes
        case 'offshore': return OFFSHORE_INTERVAL_MS;    // 15 minutes
    }
}

/**
 * Get a human-readable label for a logging zone
 */
function getZoneLabel(zone: LoggingZone): string {
    switch (zone) {
        case 'nearshore': return '< 1nm (30s intervals)';
        case 'coastal': return '1-5nm (2min intervals)';
        case 'offshore': return '> 5nm (15min intervals)';
    }
}

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
            } catch (err: any) {
            }
        }

        // Reschedule to next quarter-hour
        this.rescheduleAdaptiveInterval();
    }

    /**
     * Reschedule the interval to sync to the next quarter-hour
     */
    private rescheduleNextQuarterHour(): void {
        // Clear existing timers
        if (this.quarterTimeoutId) {
            clearTimeout(this.quarterTimeoutId);
            this.quarterTimeoutId = undefined;
        }
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

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
        // Clear existing timers
        if (this.quarterTimeoutId) {
            clearTimeout(this.quarterTimeoutId);
            this.quarterTimeoutId = undefined;
        }
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

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

        // IMMEDIATE ENTRY: Create first entry right now (at actual time, e.g., 07:14)
        // This entry is created immediately regardless of GPS - position will be added async
        this.captureImmediateEntry().catch(err => {
        });

        // ADAPTIVE SCHEDULING: Determine zone and set appropriate interval
        const initialZone = await determineLoggingZone();
        const initialInterval = getIntervalForZone(initialZone);
        this.trackingState.loggingZone = initialZone;
        this.trackingState.currentIntervalMs = initialInterval;
        await this.saveTrackingState();

        // Schedule clock-aligned entries (e.g. 15-min → fires at xx:00, xx:15, xx:30, xx:45)
        this.scheduleClockAlignedInterval(initialInterval, initialZone);
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
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.quarterTimeoutId) {
            clearTimeout(this.quarterTimeoutId);
            this.quarterTimeoutId = undefined;
        }

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
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.quarterTimeoutId) {
            clearTimeout(this.quarterTimeoutId);
            this.quarterTimeoutId = undefined;
        }

        // Clean up all GPS stream subscriptions
        this.cleanupGpsSubscriptions();

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

        // Capture final entry immediately with the exact end timestamp
        // This ensures the entry is created with the precise voyage end time
        // GPS position is fetched async - if unavailable, entry still saves with placeholder
        this.captureImmediateEntry(previousVoyageId).catch((err: any) => {
        });

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
    async captureImmediateEntry(voyageId?: string): Promise<ShipLogEntry | null> {
        const timestamp = new Date().toISOString();
        const effectiveVoyageId = voyageId || this.trackingState.currentVoyageId || `voyage_${Date.now()}`;


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
            entryType: 'auto',
            source: 'device'
        };

        // Flag to track if GPS failed and needs background retry
        let needsGpsRetry = false;

        // CACHED GPS — uses onLocation-streamed position (instant, no blocking).
        // Falls back to getCurrentPosition only if cache is stale (>60s).
        try {
            const bestPos = await this.getBestPosition();

            if (bestPos) {
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
            } else {
                // No GPS at all — will retry in background
                needsGpsRetry = true;
            }
        } catch (gpsError: any) {
            // Entry will be saved with placeholder position initially
            // We'll retry GPS in background and update the entry later
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
            } catch (gpsError: any) {
            }
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
                // more than ~5 meters, silently discard it to avoid cluttering the logbook.
                // This is separate from auto-pause (which triggers after 1 hour stationary).
                if (entryType === 'auto' && distanceNM < DEDUP_THRESHOLD_NM) {
                    return null;
                }

                // Calculate speed (distance / time)
                const timeDiffMs = new Date(timestamp).getTime() - new Date(lastPos.timestamp).getTime();
                const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
                speedKts = timeDiffHours > 0 ? distanceNM / timeDiffHours : 0;

                cumulativeDistanceNM = lastPos.cumulativeDistanceNM + distanceNM;

                // Auto-pause detection: Check if vessel is stationary
                if (entryType === 'auto' && distanceNM < STATIONARY_THRESHOLD_NM) {
                    const timeSinceMovement = new Date().getTime() - new Date(this.trackingState.lastMovementTime || timestamp).getTime();

                    if (timeSinceMovement > STATIONARY_TIMEOUT_MS) {
                        await this.pauseTracking();
                        // Still log this entry before pausing
                    }
                } else {
                    // Movement detected - update last movement time
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
                entryType,
                eventCategory,
                engineStatus,
                notes,
                waypointName
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
            await this.saveTrackingState();

            // Re-evaluate logging zone after each successful fix
            // This allows the interval to adapt as the vessel moves closer/further from shore
            this.rescheduleAdaptiveInterval().catch(err => {
            });

            return entry as ShipLogEntry;
        } catch (error) {
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
        } catch (gpsError: any) {
            // Entry will be saved with placeholder position - that's OK
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

    /**
     * Delete a voyage and all its entries
     */
    async deleteVoyage(voyageId: string): Promise<boolean> {

        // First, try to delete from offline queue (local storage)
        const offlineDeleted = await this.deleteVoyageFromOfflineQueue(voyageId);

        // If Supabase is available, also delete from there
        if (supabase) {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    let query = supabase
                        .from(SHIP_LOGS_TABLE)
                        .delete()
                        .eq('user_id', user.id);

                    // Handle 'default_voyage' - these are entries with null/empty voyageId
                    if (voyageId === 'default_voyage') {
                        query = query.or('voyage_id.is.null,voyage_id.eq.');
                    } else {
                        query = query.eq('voyage_id', voyageId);
                    }

                    const { error } = await query;
                    if (error) {
                    } else {
                    }
                }
            } catch (error) {
            }
        }

        // Return true if we deleted from offline queue (or if nothing was there)
        return true;
    }

    /**
     * Delete entries from offline queue by voyage ID
     */
    private async deleteVoyageFromOfflineQueue(voyageId: string): Promise<boolean> {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            if (!value) return false;

            const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
            const originalLength = queue.length;

            // Filter out entries matching voyageId (or null/empty for default_voyage)
            const filteredQueue = queue.filter(entry => {
                if (voyageId === 'default_voyage') {
                    return entry.voyageId && entry.voyageId !== '';
                }
                return entry.voyageId !== voyageId;
            });

            if (filteredQueue.length === originalLength) return false;

            await Preferences.set({
                key: OFFLINE_QUEUE_KEY,
                value: JSON.stringify(filteredQueue)
            });

            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Delete a single entry by ID
     */
    async deleteEntry(entryId: string): Promise<boolean> {

        // First, try to delete from offline queue (local storage)
        const offlineDeleted = await this.deleteEntryFromOfflineQueue(entryId);

        // If Supabase is available, also delete from there
        if (supabase) {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    const { error } = await supabase
                        .from(SHIP_LOGS_TABLE)
                        .delete()
                        .eq('id', entryId)
                        .eq('user_id', user.id);

                    if (error) {
                    } else {
                    }
                }
            } catch (error) {
            }
        }

        return true;
    }

    /**
     * Delete entry from offline queue by ID
     */
    private async deleteEntryFromOfflineQueue(entryId: string): Promise<boolean> {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            if (!value) return false;

            const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
            const originalLength = queue.length;

            const filteredQueue = queue.filter(entry => entry.id !== entryId);

            if (filteredQueue.length === originalLength) return false;

            await Preferences.set({
                key: OFFLINE_QUEUE_KEY,
                value: JSON.stringify(filteredQueue)
            });

            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Fetch log entries for current user
     */
    async getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
        if (!supabase) {
            return [];
        }

        try {
            // Check if user is authenticated
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                return [];
            }

            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(limit);

            if (error) {
                return [];
            }

            return (data || []).map(row => fromDbFormat(row));
        } catch (error) {
            return [];
        }
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
            return null;
        }
    }

    private async saveLastPosition(position: StoredPosition): Promise<void> {
        await Preferences.set({
            key: LAST_POSITION_KEY,
            value: JSON.stringify(position)
        });
    }

    // --- OFFLINE QUEUE METHODS ---

    /**
     * Queue entry for offline sync
     */
    private async queueOfflineEntry(entry: Partial<ShipLogEntry>): Promise<void> {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            const queue: Partial<ShipLogEntry>[] = value ? JSON.parse(value) : [];

            queue.push(entry);

            await Preferences.set({
                key: OFFLINE_QUEUE_KEY,
                value: JSON.stringify(queue)
            });

        } catch (error) {
        }
    }

    /**
     * Sync offline queue to Supabase when connection restored
     */
    async syncOfflineQueue(): Promise<number> {
        if (!supabase) return 0;

        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            if (!value) return 0;

            const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
            if (queue.length === 0) return 0;


            // Try to insert all queued entries
            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .insert(queue)
                .select();

            if (error) {
                return 0;
            }

            // Success - clear queue
            await Preferences.remove({ key: OFFLINE_QUEUE_KEY });

            return data.length;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Start background sync interval (every 2 minutes)
     */
    private startSyncInterval(): void {
        if (this.syncIntervalId) return;

        this.syncIntervalId = setInterval(() => {
            this.syncOfflineQueue();
        }, 2 * 60 * 1000); // 2 min interval
    }

    /**
     * Get count of offline queue
     */
    async getOfflineQueueCount(): Promise<number> {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            if (!value) return 0;
            const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
            return queue.length;
        } catch {
            return 0;
        }
    }

    /**
     * Get offline queued entries for display (when not connected to database)
     */
    async getOfflineEntries(): Promise<ShipLogEntry[]> {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            if (!value) return [];

            const queue: Partial<ShipLogEntry>[] = JSON.parse(value);

            // Add temporary IDs for display
            return queue.map((entry, index) => ({
                id: `offline_${index}`,
                ...entry
            } as ShipLogEntry));
        } catch (error) {
            return [];
        }
    }

    /**
     * Import GPX entries as a new voyage in the database.
     * All entries are stamped with source: 'gpx_import' to prevent
     * them from being used as an official logbook record.
     */
    async importGPXVoyage(entries: Partial<ShipLogEntry>[]): Promise<{ voyageId: string; savedCount: number }> {
        if (entries.length === 0) {
            throw new Error('No entries to import');
        }

        const voyageId = crypto.randomUUID();

        if (!supabase) {
            throw new Error('Database not available — connect to import tracks');
        }

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            throw new Error('Login required to import tracks');
        }

        // Prepare all entries for batch insert
        const dbEntries = entries.map((entry, index) => {
            const fullEntry: Partial<ShipLogEntry> = {
                ...entry,
                id: crypto.randomUUID(),
                userId: user.id,
                voyageId,
                source: (entry as any).source || 'gpx_import',
                distanceNM: entry.distanceNM || 0,
                cumulativeDistanceNM: entry.cumulativeDistanceNM || 0,
                speedKts: entry.speedKts || 0,
            };
            return toDbFormat(fullEntry);
        });

        // Batch insert in chunks of 100 to avoid payload limits
        const CHUNK_SIZE = 100;
        let savedCount = 0;

        for (let i = 0; i < dbEntries.length; i += CHUNK_SIZE) {
            const chunk = dbEntries.slice(i, i + CHUNK_SIZE);
            const { error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .insert(chunk);

            if (error) {
                throw new Error(`Import failed at entry ${i}: ${error.message}`);
            }
            savedCount += chunk.length;
        }

        return { voyageId, savedCount };
    }
}

// Export singleton instance
export const ShipLogService = new ShipLogServiceClass();
