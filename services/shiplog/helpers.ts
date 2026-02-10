/**
 * Ship Log Helper Functions
 *
 * Pure utility functions extracted from ShipLogService:
 * - Haversine distance/bearing calculations
 * - Coordinate formatting (DMS)
 * - Quarter-hour time alignment
 * - Database field mapping (camelCase ↔ snake_case)
 * - Weather snapshot assembly
 * - Adaptive logging zone detection
 */

import { ShipLogEntry } from '../../types';
import { windToBeaufort, waveToSeaState, getWatchPeriod } from '../../utils/marineFormatters';
import { loadLargeData, DATA_CACHE_KEY } from '../nativeStorage';

// --- CONSTANTS ---
const EARTH_RADIUS_NM = 3440.065;

// Shore distance thresholds in kilometers (1nm = 1.852km)
const NEARSHORE_THRESHOLD_KM = 1.852;   // < 1nm from shore
const COASTAL_THRESHOLD_KM = 9.26;      // < 5nm from shore

// Adaptive logging intervals
export const NEARSHORE_INTERVAL_MS = 30 * 1000;      // 30 seconds (< 1nm from shore / on land)
export const COASTAL_INTERVAL_MS = 2 * 60 * 1000;    // 2 minutes (1-5nm from shore)
export const OFFSHORE_INTERVAL_MS = 15 * 60 * 1000;  // 15 minutes (> 5nm offshore)

export type LoggingZone = 'nearshore' | 'coastal' | 'offshore';

// Database table name
export const SHIP_LOGS_TABLE = 'ship_logs';

/**
 * Calculate distance between two coordinates using Haversine formula
 * @returns Distance in nautical miles
 */
export function calculateDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
export function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
export function formatPositionDMS(lat: number, lon: number): string {
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
export function getNextQuarterHour(): { nextTime: Date; msUntil: number } {
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
export function toDbFormat(entry: Partial<ShipLogEntry>): Record<string, any> {
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
export function fromDbFormat(row: Record<string, any>): ShipLogEntry {
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

/**
 * Get current weather data from cache for snapshot
 * Includes IMO-compliant calculations for Beaufort, sea state, and watch period
 */
export async function getWeatherSnapshot(): Promise<Partial<ShipLogEntry>> {
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
 * Determine the logging zone for adaptive GPS intervals.
 *
 * Uses the cached weather data — which reflects the dashboard's selected location.
 * If the dashboard is set to "Current Location" (GPS), this is the vessel's real position.
 *
 * SAFETY-FIRST RULES:
 * 1. Default = 'nearshore' (30s) — extra entries are cheap, missed ones are not.
 * 2. Only go 'offshore' (15min) when we have CONFIRMED distance > 5nm from land.
 * 3. Never trust locationType alone for offshore — require distToLandKm confirmation.
 */
export async function determineLoggingZone(): Promise<LoggingZone> {
    try {
        const cachedData = await loadLargeData(DATA_CACHE_KEY);
        if (!cachedData) return 'nearshore'; // No data = safe default

        // Landlocked = on land = nearshore (30s)
        if (cachedData?.isLandlocked === true) return 'nearshore';

        const locationType = cachedData?.locationType;
        const distKm = cachedData?.distToLandKm;

        // If we have actual distance to land, use it (most reliable signal)
        if (distKm !== undefined && distKm !== null && typeof distKm === 'number') {
            if (distKm <= NEARSHORE_THRESHOLD_KM) return 'nearshore';   // < 1nm
            if (distKm <= COASTAL_THRESHOLD_KM) return 'coastal';       // < 5nm
            return 'offshore';                                           // > 5nm — confirmed
        }

        // Fall back to locationType classification
        if (locationType === 'inland') return 'nearshore';
        if (locationType === 'coastal') return 'coastal';
        // NOTE: Do NOT trust locationType === 'offshore' without distance confirmation.
        // The weather cache might be for a different location (user browsing offshore WPs).
        // Default to nearshore — rescheduleAdaptiveInterval will refine after next GPS fix.

        return 'nearshore'; // Safe default
    } catch {
        return 'nearshore'; // Fail safe
    }
}

/**
 * Get the appropriate logging interval for a given zone
 */
export function getIntervalForZone(zone: LoggingZone): number {
    switch (zone) {
        case 'nearshore': return NEARSHORE_INTERVAL_MS;   // 30 seconds
        case 'coastal': return COASTAL_INTERVAL_MS;     // 2 minutes
        case 'offshore': return OFFSHORE_INTERVAL_MS;    // 15 minutes
    }
}

/**
 * Get a human-readable label for a logging zone
 */
export function getZoneLabel(zone: LoggingZone): string {
    switch (zone) {
        case 'nearshore': return '< 1nm (30s intervals)';
        case 'coastal': return '1-5nm (2min intervals)';
        case 'offshore': return '> 5nm (15min intervals)';
    }
}
