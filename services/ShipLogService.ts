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
 */

import { Preferences } from '@capacitor/preferences';
import { Geolocation, Position } from '@capacitor/geolocation';
import { supabase } from './supabase';
import { ShipLogEntry } from '../types';
import { windToBeaufort, waveToSeaState, getWatchPeriod } from '../utils/marineFormatters';
import { loadLargeData, DATA_CACHE_KEY } from './nativeStorage';

// --- CONSTANTS ---
const TRACKING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STATIONARY_THRESHOLD_NM = 0.05; // Less than 0.05nm movement = anchored
const STATIONARY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour without movement = auto-pause
const EARTH_RADIUS_NM = 3440.065; // Earth's radius in nautical miles

// --- STORAGE KEYS ---
const TRACKING_STATE_KEY = 'ship_log_tracking_state';
const LAST_POSITION_KEY = 'ship_log_last_position';
const VOYAGE_START_KEY = 'ship_log_voyage_start';
const OFFLINE_QUEUE_KEY = 'ship_log_offline_queue'; // Queue for offline entries

// --- INTERFACES ---

interface TrackingState {
    isTracking: boolean;
    isPaused: boolean;
    currentVoyageId?: string; // Unique ID for current voyage
    voyageStartTime?: string;
    lastMovementTime?: string;
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
            console.log('[ShipLogService] No weather cache found');
            return { watchPeriod };
        }

        const current = cache?.current;
        if (!current) {
            console.log('[ShipLogService] No current weather in cache');
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
        console.error('[ShipLogService] Error fetching weather snapshot:', error);
        return { watchPeriod };
    }
}

// --- MAIN SERVICE CLASS ---

class ShipLogServiceClass {
    private intervalId?: NodeJS.Timeout;
    private syncIntervalId?: NodeJS.Timeout;
    private trackingState: TrackingState = { isTracking: false, isPaused: false };

    /**
     * Initialize the service and restore state from storage
     */
    async initialize(): Promise<void> {
        try {
            const { value } = await Preferences.get({ key: TRACKING_STATE_KEY });
            if (value) {
                this.trackingState = JSON.parse(value);

                // Resume tracking if it was active
                if (this.trackingState.isTracking && !this.trackingState.isPaused) {
                    console.log('[ShipLogService] Resuming tracking from previous session');
                    await this.startTracking(true); // Resume without creating new voyage
                }
            }

            // Start sync interval to process offline queue
            this.startSyncInterval();

            // Try initial sync
            await this.syncOfflineQueue();
        } catch (error) {
            console.error('[ShipLogService] Error initializing:', error);
        }
    }

    /**
     * Start automatic GPS tracking
     * @param resume - If true, resume existing voyage. If false, start new voyage.
     * @param continueVoyageId - Optional: specify a voyage ID to continue
     */
    async startTracking(resume: boolean = false, continueVoyageId?: string): Promise<void> {
        if (this.trackingState.isTracking) {
            console.log('[ShipLogService] Tracking already active');
            return;
        }

        console.log('[ShipLogService] Requesting location permissions...');

        // Request location permissions
        const permission = await Geolocation.checkPermissions();
        if (permission.location !== 'granted') {
            const requested = await Geolocation.requestPermissions();
            if (requested.location !== 'granted') {
                throw new Error('Location permission denied');
            }
        }

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
            currentVoyageId: voyageId,
            voyageStartTime: (resume || continueVoyageId) ? this.trackingState.voyageStartTime : new Date().toISOString(),
            lastMovementTime: new Date().toISOString()
        };

        console.log(`[ShipLogService] ${resume || continueVoyageId ? 'Continuing' : 'Starting new'} voyage: ${voyageId}`);

        await this.saveTrackingState();

        // Capture first entry immediately
        await this.captureLogEntry();

        // Set up interval for 15-minute tracking
        this.intervalId = setInterval(() => {
            this.captureLogEntry();
        }, TRACKING_INTERVAL_MS);

        console.log('[ShipLogService] Tracking started - logging every 15 minutes');
    }

    /**
     * Pause tracking (user initiated)
     */
    async pauseTracking(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

        this.trackingState.isTracking = false;
        this.trackingState.isPaused = true;
        await this.saveTrackingState();

        console.log('[ShipLogService] Tracking paused');
    }

    /**
     * Stop tracking and end voyage
     */
    async stopTracking(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

        // Capture final entry
        await this.captureLogEntry();

        this.trackingState = { isTracking: false, isPaused: false };
        await this.saveTrackingState();

        // Clear voyage data
        await Preferences.remove({ key: LAST_POSITION_KEY });
        await Preferences.remove({ key: VOYAGE_START_KEY });

        console.log('[ShipLogService] Tracking stopped - voyage complete');
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
            console.log('[ShipLogService] Capturing log entry...');

            // Get current position
            const position: Position = await Geolocation.getCurrentPosition({
                enableHighAccuracy: true,
                timeout: 10000
            });

            const { latitude, longitude, heading } = position.coords;
            const timestamp = new Date(position.timestamp).toISOString();

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

                // Calculate speed (distance / time)
                const timeDiffMs = new Date(timestamp).getTime() - new Date(lastPos.timestamp).getTime();
                const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
                speedKts = timeDiffHours > 0 ? distanceNM / timeDiffHours : 0;

                cumulativeDistanceNM = lastPos.cumulativeDistanceNM + distanceNM;

                // Auto-pause detection: Check if vessel is stationary
                if (entryType === 'auto' && distanceNM < STATIONARY_THRESHOLD_NM) {
                    const timeSinceMovement = new Date().getTime() - new Date(this.trackingState.lastMovementTime || timestamp).getTime();

                    if (timeSinceMovement > STATIONARY_TIMEOUT_MS) {
                        console.log('[ShipLogService] Vessel stationary for 1 hour - auto-pausing');
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
                courseDeg: heading !== null && heading !== undefined ? Math.round(heading) : undefined,
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
                            .from('ship_log')
                            .insert({ ...entry, userId: user.id })
                            .select()
                            .single();

                        if (error) {
                            // Network error or offline - queue for later
                            console.warn('[ShipLogService] Failed to save online, queueing locally:', error.message);
                            await this.queueOfflineEntry(entry);
                        } else {
                            console.log('[ShipLogService] ✓ Log entry saved online:', data.id);

                            // Update last position in storage
                            await this.saveLastPosition({
                                latitude,
                                longitude,
                                timestamp,
                                cumulativeDistanceNM
                            });

                            return data as ShipLogEntry;
                        }
                    } else {
                        // Not authenticated - queue offline
                        console.log('[ShipLogService] Not authenticated - queuing entry');
                        await this.queueOfflineEntry(entry);
                    }
                } catch (networkError) {
                    // Offline - queue for later
                    console.warn('[ShipLogService] Offline detected, queueing entry');
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

            return entry as ShipLogEntry;
        } catch (error) {
            console.error('[ShipLogService] Error capturing log entry:', error);
            return null;
        }
    }

    /**
     * Add a manual log entry (user-initiated)
     */
    async addManualEntry(
        notes?: string,
        waypointName?: string,
        eventCategory?: 'navigation' | 'weather' | 'equipment' | 'crew' | 'arrival' | 'departure' | 'safety' | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string
    ): Promise<ShipLogEntry | null> {
        const entryType = waypointName ? 'waypoint' : 'manual';
        return this.captureLogEntry(entryType, notes, waypointName, eventCategory, engineStatus, voyageId);
    }

    /**
     * Get tracking status
     */
    getTrackingStatus(): TrackingState {
        return { ...this.trackingState };
    }

    /**
     * Get current voyage ID
     */
    getCurrentVoyageId(): string | undefined {
        return this.trackingState.currentVoyageId;
    }

    /**
     * Delete a voyage and all its entries
     */
    async deleteVoyage(voyageId: string): Promise<boolean> {
        console.log(`[ShipLogService] Attempting to delete voyage: ${voyageId}`);

        // First, try to delete from offline queue (local storage)
        const offlineDeleted = await this.deleteVoyageFromOfflineQueue(voyageId);

        // If Supabase is available, also delete from there
        if (supabase) {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    let query = supabase
                        .from('ship_log')
                        .delete()
                        .eq('userId', user.id);

                    // Handle 'default_voyage' - these are entries with null/empty voyageId
                    if (voyageId === 'default_voyage') {
                        query = query.or('voyageId.is.null,voyageId.eq.');
                    } else {
                        query = query.eq('voyageId', voyageId);
                    }

                    const { error } = await query;
                    if (error) {
                        console.error('[ShipLogService] Error deleting voyage from Supabase:', error);
                    } else {
                        console.log(`[ShipLogService] Deleted voyage from Supabase: ${voyageId}`);
                    }
                }
            } catch (error) {
                console.warn('[ShipLogService] Supabase delete failed (offline?):', error);
            }
        }

        // Return true if we deleted from offline queue (or if nothing was there)
        console.log(`[ShipLogService] Successfully deleted voyage ${voyageId}`);
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

            console.log(`[ShipLogService] Deleted ${originalLength - filteredQueue.length} entries from offline queue`);
            return true;
        } catch (error) {
            console.error('[ShipLogService] Error deleting voyage from offline queue:', error);
            return false;
        }
    }

    /**
     * Delete a single entry by ID
     */
    async deleteEntry(entryId: string): Promise<boolean> {
        console.log(`[ShipLogService] Attempting to delete entry: ${entryId}`);

        // First, try to delete from offline queue (local storage)
        const offlineDeleted = await this.deleteEntryFromOfflineQueue(entryId);

        // If Supabase is available, also delete from there
        if (supabase) {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    const { error } = await supabase
                        .from('ship_log')
                        .delete()
                        .eq('id', entryId)
                        .eq('userId', user.id);

                    if (error) {
                        console.error('[ShipLogService] Error deleting entry from Supabase:', error);
                    } else {
                        console.log(`[ShipLogService] Deleted entry from Supabase: ${entryId}`);
                    }
                }
            } catch (error) {
                console.warn('[ShipLogService] Supabase delete failed (offline?):', error);
            }
        }

        console.log(`[ShipLogService] Successfully deleted entry ${entryId}`);
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

            console.log(`[ShipLogService] Deleted entry ${entryId} from offline queue`);
            return true;
        } catch (error) {
            console.error('[ShipLogService] Error deleting entry from offline queue:', error);
            return false;
        }
    }

    /**
     * Fetch log entries for current user
     */
    async getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
        if (!supabase) {
            console.log('[ShipLogService] Supabase not available');
            return [];
        }

        try {
            // Check if user is authenticated
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                console.warn('[ShipLogService] No authenticated user - cannot fetch logs');
                return [];
            }

            const { data, error } = await supabase
                .from('ship_log')
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('[ShipLogService] Error fetching logs:', error);
                return [];
            }

            console.log(`[ShipLogService] Fetched ${data?.length || 0} log entries`);
            return data as ShipLogEntry[];
        } catch (error) {
            console.error('[ShipLogService] Error in getLogEntries:', error);
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

            console.log(`[ShipLogService] Entry queued offline (${queue.length} in queue)`);
        } catch (error) {
            console.error('[ShipLogService] Error queueing offline entry:', error);
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

            console.log(`[ShipLogService] Syncing ${queue.length} offline entries...`);

            // Try to insert all queued entries
            const { data, error } = await supabase
                .from('ship_log')
                .insert(queue)
                .select();

            if (error) {
                console.error('[ShipLogService] Sync failed:', error);
                return 0;
            }

            // Success - clear queue
            await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
            console.log(`[ShipLogService] ✓ Synced ${data.length} entries from offline queue`);

            return data.length;
        } catch (error) {
            console.error('[ShipLogService] Error syncing offline queue:', error);
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
            console.error('[ShipLogService] Error getting offline entries:', error);
            return [];
        }
    }
}

// Export singleton instance
export const ShipLogService = new ShipLogServiceClass();
