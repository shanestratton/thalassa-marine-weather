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
import { savePassagePlanToLogbook as _savePassagePlanToLogbook } from './shiplog/PassagePlanSave';
import { determineLoggingZone, getIntervalForZone, getIntervalForSpeed, type LoggingZone } from './shiplog/helpers';
import { GpsTrackBuffer } from './shiplog/GpsTrackBuffer';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
import {
    loadTrackingState,
    saveTrackingState as _saveTrackingState,
    clearVoyageState as _clearVoyageState,
    type TrackingState,
} from './shiplog/TrackingStateStore';
import { CourseChangeDetector } from './shiplog/CourseChangeDetector';
import { EnvironmentPoller } from './shiplog/EnvironmentPoller';
import { AdaptiveScheduler } from './shiplog/AdaptiveScheduler';
import { GpsSubscriptionManager } from './shiplog/GpsSubscriptionManager';
import {
    captureImmediate as _captureImmediate,
    captureLog as _captureLog,
    addManual as _addManual,
    flushBufferedTrack as _flushBufferedTrack,
    type CaptureContext,
    type CaptureLogOptions,
    type AddManualOptions,
} from './shiplog/CapturePipeline';
import { getGpsStatus as _getGpsStatus, getGpsNavData as _getGpsNavData } from './shiplog/PositionResolver';
import {
    syncOfflineQueue as _syncOfflineQueue,
    getOfflineQueueCount as _getOfflineQueueCount,
    getOfflineEntries as _getOfflineEntries,
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

const log = createLogger('ShipLog');

// --- CONSTANTS still owned by the orchestrator ---
//
// Constants used only inside the capture pipeline (DEDUP_THRESHOLD_NM,
// STATIONARY_THRESHOLD_NM, MAX_PLAUSIBLE_SPEED_KTS, MAX_ACCELERATION_KTS,
// GPS_STALE_LIMIT_MS) live in CapturePipeline.ts now. Storage keys +
// state interfaces live in TrackingStateStore.ts. Helper functions, DB
// mapping, and zone detection live in helpers.ts.

const TRACKING_INTERVAL_MS = 60 * 1000; // 60 seconds (fallback / offshore default)
const RAPID_INTERVAL_MS = 10 * 1000; // 10 seconds for marina/shore navigation (manual override)
const VOYAGE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours — start new voyage instead of resuming

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

    // GPS resolution lives in ./shiplog/PositionResolver.ts. CapturePipeline
    // calls getBestPosition() directly; the orchestrator only exposes the
    // two read-only convenience views (status + nav data) since the
    // Dashboard / SystemStatus components want them as instance methods.

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
        return _captureImmediate(this._captureCtx(), voyageId, waypointLabel);
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
        const opts: CaptureLogOptions = {
            entryType,
            notes,
            waypointName,
            eventCategory,
            engineStatus,
            voyageId,
            skipDedup,
        };
        return _captureLog(this._captureCtx(), opts);
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
    private flushBufferedTrack(): Promise<void> {
        return _flushBufferedTrack(this._captureCtx());
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
        const opts: AddManualOptions = { notes, waypointName, eventCategory, engineStatus, voyageId };
        return _addManual(this._captureCtx(), opts);
    }

    /**
     * Build the CaptureContext bag the pipeline functions consume.
     * Lives on `this` so each capture-invocation gets the live state +
     * the right hooks; the pipeline mutates `trackingState` in place.
     */
    private _captureCtx(): CaptureContext {
        return {
            trackingState: this.trackingState,
            saveTrackingState: () => this.saveTrackingState(),
            isNative: this.isNative,
            getCachedFix: () => this.lastBgLocation,
            setCachedFix: (pos) => {
                this.lastBgLocation = pos;
            },
            trackBuffer: this.trackBuffer,
            getLastWaterStatus: () => this.lastWaterStatus,
            setLastWaterStatus: (v) => {
                this.lastWaterStatus = v;
            },
            rescheduleAdaptiveInterval: () => this.rescheduleAdaptiveInterval(),
        };
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
    // saveTrackingState delegates to TrackingStateStore.ts. The pipeline
    // calls getLastPosition / saveLastPosition directly from the same
    // module, so we no longer wrap them on the orchestrator.

    private async saveTrackingState(): Promise<void> {
        await _saveTrackingState(this.trackingState);
    }

    // --- DELEGATED OFFLINE QUEUE METHODS (implementation in ./shiplog/OfflineQueue.ts) ---

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
