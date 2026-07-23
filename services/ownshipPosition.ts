import { GpsService, type GpsPosition } from './GpsService';
import { NmeaStore } from './NmeaStore';
import { LocationStore } from '../stores/LocationStore';

const DEFAULT_MAX_NMEA_AGE_MS = 15_000;
const DEFAULT_MAX_GPS_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const METRES_PER_SECOND_TO_KNOTS = 1.9438444924;
let gpsRequestInFlight: Promise<GpsPosition | null> | null = null;

interface OwnshipMetric {
    value: number | null;
    lastUpdated: number;
    freshness: string;
}

export interface OwnshipNavigationInput {
    latitude?: OwnshipMetric;
    longitude?: OwnshipMetric;
    sog?: OwnshipMetric;
    cog?: OwnshipMetric;
}

export interface SelectedLocationInput {
    lat: number;
    lon: number;
    source: string;
    timestamp: number;
}

export interface OwnshipPosition {
    lat: number;
    lon: number;
    sog: number;
    cog: number;
    timestamp: number;
    source: 'nmea' | 'gps';
}

export interface OwnshipPositionOptions {
    maxNmeaAgeMs?: number;
    maxGpsAgeMs?: number;
    now?: number;
}

function validCoordinates(lat: number, lon: number): boolean {
    return Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function isFreshMetric(metric: OwnshipMetric | undefined, now: number, maxAgeMs: number): metric is OwnshipMetric {
    if (
        !metric ||
        metric.value == null ||
        !Number.isFinite(metric.value) ||
        !Number.isFinite(metric.lastUpdated) ||
        metric.freshness === 'dead'
    ) {
        return false;
    }
    const age = now - metric.lastUpdated;
    return age >= -MAX_FUTURE_SKEW_MS && age <= maxAgeMs;
}

function safeMovementMetric(
    metric: OwnshipMetric | undefined,
    now: number,
    maxAgeMs: number,
    upperExclusive?: number,
): number {
    if (!isFreshMetric(metric, now, maxAgeMs) || metric.value! < 0) return 0;
    if (upperExclusive !== undefined && metric.value! >= upperExclusive) return 0;
    return metric.value!;
}

export function resolveOwnshipPosition(
    nmea: OwnshipNavigationInput,
    selectedLocation: SelectedLocationInput,
    options: OwnshipPositionOptions | number = {},
): OwnshipPosition | null {
    const resolvedOptions = typeof options === 'number' ? { now: options } : options;
    const now = resolvedOptions.now ?? Date.now();
    const maxNmeaAgeMs = resolvedOptions.maxNmeaAgeMs ?? DEFAULT_MAX_NMEA_AGE_MS;
    const maxGpsAgeMs = resolvedOptions.maxGpsAgeMs ?? DEFAULT_MAX_GPS_AGE_MS;
    const nmeaLat = nmea.latitude;
    const nmeaLon = nmea.longitude;

    if (
        isFreshMetric(nmeaLat, now, maxNmeaAgeMs) &&
        isFreshMetric(nmeaLon, now, maxNmeaAgeMs) &&
        validCoordinates(nmeaLat.value!, nmeaLon.value!)
    ) {
        return {
            lat: nmeaLat.value!,
            lon: nmeaLon.value!,
            sog: safeMovementMetric(nmea.sog, now, maxNmeaAgeMs),
            cog: safeMovementMetric(nmea.cog, now, maxNmeaAgeMs, 360),
            timestamp: Math.min(nmeaLat.lastUpdated, nmeaLon.lastUpdated),
            source: 'nmea',
        };
    }

    const gpsAge = now - selectedLocation.timestamp;
    if (
        selectedLocation.source !== 'gps' ||
        !validCoordinates(selectedLocation.lat, selectedLocation.lon) ||
        !Number.isFinite(gpsAge) ||
        gpsAge < -MAX_FUTURE_SKEW_MS ||
        gpsAge > maxGpsAgeMs
    ) {
        return null;
    }

    return {
        lat: selectedLocation.lat,
        lon: selectedLocation.lon,
        sog: safeMovementMetric(nmea.sog, now, maxNmeaAgeMs),
        cog: safeMovementMetric(nmea.cog, now, maxNmeaAgeMs, 360),
        timestamp: selectedLocation.timestamp,
        source: 'gps',
    };
}

function fromGpsPosition(position: GpsPosition | null, now: number, maxAgeMs: number): OwnshipPosition | null {
    if (!position || !validCoordinates(position.latitude, position.longitude)) return null;
    const age = now - position.timestamp;
    if (!Number.isFinite(age) || age < -MAX_FUTURE_SKEW_MS || age > maxAgeMs) return null;
    const speedKnots =
        Number.isFinite(position.speed) && position.speed >= 0 ? position.speed * METRES_PER_SECOND_TO_KNOTS : 0;
    const heading =
        position.heading != null && Number.isFinite(position.heading) && position.heading >= 0 && position.heading < 360
            ? position.heading
            : 0;
    return {
        lat: position.latitude,
        lon: position.longitude,
        sog: speedKnots,
        cog: heading,
        timestamp: position.timestamp,
        source: 'gps',
    };
}

export function getCachedOwnshipPosition(options: OwnshipPositionOptions = {}): OwnshipPosition | null {
    return resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState(), options);
}

export async function acquireFreshOwnshipPosition(
    options: OwnshipPositionOptions & { timeoutSec?: number } = {},
): Promise<OwnshipPosition | null> {
    const now = options.now ?? Date.now();
    const maxGpsAgeMs = options.maxGpsAgeMs ?? 30_000;
    const cached = getCachedOwnshipPosition({ ...options, now, maxGpsAgeMs });
    if (cached) return cached;

    if (!gpsRequestInFlight) {
        const request = GpsService.getCurrentPosition({
            staleLimitMs: maxGpsAgeMs,
            timeoutSec: options.timeoutSec ?? 10,
        });
        const tracked = request.finally(() => {
            if (gpsRequestInFlight === tracked) gpsRequestInFlight = null;
        });
        gpsRequestInFlight = tracked;
    }
    try {
        const position = await gpsRequestInFlight;
        return fromGpsPosition(position, options.now ?? Date.now(), maxGpsAgeMs);
    } catch {
        // The service normally resolves null on permission or platform errors,
        // but a plugin/runtime rejection must still fail closed for safety callers.
        return null;
    }
}
