import { GpsService, type GpsPosition } from './GpsService';
import { NmeaStore } from './NmeaStore';
import { LocationStore } from '../stores/LocationStore';
import { collisionPairFor, type CollisionPairName } from '../utils/collisionRule';

const DEFAULT_MAX_NMEA_AGE_MS = 15_000;
const DEFAULT_MAX_GPS_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const METRES_PER_SECOND_TO_KNOTS = 1.9438444924;

/**
 * The same ownship resolver serves three materially different privacy
 * boundaries. Keeping the access intent explicit prevents a passive timer or
 * restored screen from accidentally borrowing the prompt/background-capable
 * path used by Cast Off.
 */
export type OwnshipLocationAccess = 'already-granted' | 'foreground-request' | 'background-safety';
const gpsRequestsInFlight = new Map<OwnshipLocationAccess, Promise<GpsPosition | null>>();

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
    /** NmeaStore's remote feed, when there is one: which lane, and when the Pi reported. */
    remote?: { via?: string; reportedAt?: number; positionSampleAt?: number } | null;
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
    /**
     * 'nmea' is the BOAT — her own receiver, by any lane (the chart, the
     * passage HUD and the diary all read it that way). 'gps' is this phone.
     */
    source: 'nmea' | 'gps';
    /**
     * Present only when the boat's fix came down the Pi's cloud row: relayed,
     * not the bus, and `timestamp` is when this phone READ it. `reportedAt` is
     * when her receiver (else the Pi) said it — the honest age (build 123,
     * package VL: a minute-old relayed fix must never pass as the live bus).
     */
    relay?: { reportedAt: number };
}

export interface OwnshipPositionOptions {
    maxNmeaAgeMs?: number;
    maxGpsAgeMs?: number;
    now?: number;
}

export interface AcquireOwnshipPositionOptions extends OwnshipPositionOptions {
    timeoutSec?: number;
    /**
     * `already-granted` is the fail-closed default for mounts and timers.
     * `foreground-request` is reserved for an ordinary direct user action.
     * `background-safety` may initialize the safety engine and is reserved for
     * MOB, Anchor Watch, or the explicit voyage-logging preflight.
     */
    locationAccess?: OwnshipLocationAccess;
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

/**
 * A movement reading (SOG, COG) while it is fresh and in range, else null:
 * unknown, which a display must say as unknown. `resolveOwnshipPosition`'s
 * `sog`/`cog` turn that into 0 for its existing callers; a badge that reads
 * them as 'Stopped' would invent a speed.
 */
export function freshMovementMetric(
    metric: OwnshipMetric | undefined,
    now = Date.now(),
    maxAgeMs = DEFAULT_MAX_NMEA_AGE_MS,
    upperExclusive?: number,
): number | null {
    if (!isFreshMetric(metric, now, maxAgeMs) || metric.value! < 0) return null;
    if (upperExclusive !== undefined && metric.value! >= upperExclusive) return null;
    return metric.value!;
}

function safeMovementMetric(
    metric: OwnshipMetric | undefined,
    now: number,
    maxAgeMs: number,
    upperExclusive?: number,
): number {
    return freshMovementMetric(metric, now, maxAgeMs, upperExclusive) ?? 0;
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
        const relayedAt =
            nmea.remote?.via === 'cloud'
                ? [nmea.remote.positionSampleAt, nmea.remote.reportedAt].find(
                      (at): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0,
                  )
                : undefined;
        return {
            lat: nmeaLat.value!,
            lon: nmeaLon.value!,
            sog: safeMovementMetric(nmea.sog, now, maxNmeaAgeMs),
            cog: safeMovementMetric(nmea.cog, now, maxNmeaAgeMs, 360),
            timestamp: Math.min(nmeaLat.lastUpdated, nmeaLon.lastUpdated),
            source: 'nmea',
            ...(relayedAt !== undefined ? { relay: { reportedAt: relayedAt } } : {}),
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

/** Own-ship motion for the collision rule. Unknown is null, never 0. */
export interface OwnMotion {
    sogKn: number | null;
    cogDeg: number | null;
    source: 'nmea' | 'phone' | null;
    /**
     * The skipper's threshold pair in use (utils/collisionRule.ts
     * collisionPairFor): offshore from 3 kn, inshore again only under 2.5 kn.
     * Carried here so the alarm, the chip and Calypso share one hysteresis.
     */
    pair: CollisionPairName;
}

/** The last pair in use, shared by every caller (the hysteresis needs a memory). */
let lastCollisionPair: CollisionPairName | null = null;

/**
 * Smoke builds only (THALASSA_DEBUG_AIS_INJECTOR=1, package 125-11): a
 * fictional own motion so the debug injector's crossing can sound at a berth.
 * The build-time constant is the literal false in every other build, so the
 * branch reading it folds away and nothing can set it.
 */
let debugOwnMotion: { sogKn: number; cogDeg: number; until: number } | null = null;

export function setDebugOwnMotion(next: { sogKn: number; cogDeg: number; until: number } | null): void {
    if (__THALASSA_DEBUG_AIS_INJECTOR__) debugOwnMotion = next;
}

function withPair(motion: Omit<OwnMotion, 'pair'>): OwnMotion {
    lastCollisionPair = collisionPairFor(motion.sogKn, lastCollisionPair);
    return { ...motion, pair: lastCollisionPair };
}

/**
 * Our own course and speed for the collision rule (build 125, 125-01): the
 * boat's own GPS (NmeaStore SOG/COG, any lane) is the truth, else this phone's
 * last fix. The two are never mixed, since a boat speed with a phone course
 * is a vector nobody measured, and nothing unknown becomes 0:
 * `resolveOwnshipPosition` keeps its 0s for its existing callers, but a CPA
 * from a made-up 0 kn own ship would grade every crossing as someone else's.
 * A phone fix whose platform gave no speed (speedUnknown) is unknown too.
 */
export function resolveOwnMotion(
    nmea: Pick<OwnshipNavigationInput, 'sog' | 'cog'>,
    phone: GpsPosition | null,
    now = Date.now(),
): OwnMotion {
    if (__THALASSA_DEBUG_AIS_INJECTOR__ && debugOwnMotion && now < debugOwnMotion.until) {
        return withPair({ sogKn: debugOwnMotion.sogKn, cogDeg: debugOwnMotion.cogDeg, source: 'nmea' });
    }
    const sog = freshMovementMetric(nmea.sog, now, DEFAULT_MAX_NMEA_AGE_MS);
    if (sog !== null) {
        return withPair({
            sogKn: sog,
            cogDeg: freshMovementMetric(nmea.cog, now, DEFAULT_MAX_NMEA_AGE_MS, 360),
            source: 'nmea',
        });
    }
    const age = phone ? now - phone.timestamp : Number.NaN;
    if (
        !phone ||
        phone.speedUnknown === true ||
        !Number.isFinite(phone.speed) ||
        phone.speed < 0 ||
        !(age >= -MAX_FUTURE_SKEW_MS && age <= DEFAULT_MAX_GPS_AGE_MS)
    ) {
        return withPair({ sogKn: null, cogDeg: null, source: null });
    }
    const heading = phone.heading;
    return withPair({
        sogKn: phone.speed * METRES_PER_SECOND_TO_KNOTS,
        cogDeg: heading != null && Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null,
        source: 'phone',
    });
}

/** Test seam: forget the pair hysteresis's memory. */
export function __resetOwnMotionForTests(): void {
    lastCollisionPair = null;
    debugOwnMotion = null;
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
    options: AcquireOwnshipPositionOptions = {},
): Promise<OwnshipPosition | null> {
    const now = options.now ?? Date.now();
    const maxGpsAgeMs = options.maxGpsAgeMs ?? 30_000;
    const cached = getCachedOwnshipPosition({ ...options, now, maxGpsAgeMs });
    if (cached) return cached;

    const locationAccess = options.locationAccess ?? 'already-granted';
    let gpsRequestInFlight = gpsRequestsInFlight.get(locationAccess);
    if (!gpsRequestInFlight) {
        const requestOptions = {
            staleLimitMs: maxGpsAgeMs,
            timeoutSec: options.timeoutSec ?? 10,
        };
        const request =
            locationAccess === 'background-safety'
                ? GpsService.getCurrentPosition(requestOptions)
                : locationAccess === 'foreground-request'
                  ? GpsService.requestCurrentForegroundPosition(requestOptions)
                  : GpsService.getCurrentPositionIfGranted(requestOptions);
        const tracked = request.finally(() => {
            if (gpsRequestsInFlight.get(locationAccess) === tracked) gpsRequestsInFlight.delete(locationAccess);
        });
        gpsRequestsInFlight.set(locationAccess, tracked);
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
