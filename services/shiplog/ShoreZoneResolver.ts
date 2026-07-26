/**
 * ShoreZoneResolver — position-scoped logging-zone evidence.
 *
 * Ship-log detail must follow the vessel, never the dashboard's selected
 * weather location. This resolver combines a *verified* water result with
 * OSM `natural=coastline` geometry around the GPS coordinate:
 *
 *   land / river / lake / unknown → nearshore (dense, safe fallback)
 *   < 1 nm from shore            → nearshore
 *   1–5 nm from shore            → coastal
 *   > 5 nm from shore            → offshore
 *
 * The coastline source is deliberately best-effort. A missing network result
 * must never make a track less detailed, so unresolved evidence is always
 * nearshore. The class is intentionally isolated from ShipLogService and the
 * GPS manager: callers can feed it actual GPS fixes and adopt its profile at
 * their own lifecycle boundary.
 */

import pointToLineDistance from '@turf/point-to-line-distance';
import { lineString, point as turfPoint } from '@turf/helpers';

import { fetchCoastlineSegments } from '../weather/shelter/coastlineSource';
import type { Segment } from '../weather/shelter/shelterGeometry';
import type { LoggingZone } from './helpers';
import type { WaterCheckResult } from './waterDetection';

/** Nautical miles per kilometre. */
const KM_TO_NM = 0.539956803;

/** A default 60 km coastline query is safely useful within this radius. */
const COASTLINE_COVERAGE_NM = 25;

/** Avoid repeatedly asking a known-unavailable coastline source near one fix. */
const FAILURE_RETRY_MS = 60_000;

// Hysteresis deliberately has a gap at both borders. The product boundary is
// one nautical mile: entering that inshore band restores dense detail
// immediately, while leaving it requires clearance to 1.25 nm plus the
// normal sparse-zone confirmation.
export const NEARSHORE_ENTER_NM = 1;
export const NEARSHORE_EXIT_NM = 1.25;
export const OFFSHORE_ENTER_NM = 4.5;
export const OFFSHORE_EXIT_NM = 5.5;
export const SPARSE_ZONE_CONFIRMATIONS = 2;

export type ShoreWaterStatus = Pick<WaterCheckResult, 'isWater' | 'feature' | 'failedOpen'>;

export interface ShoreZoneObservation {
    latitude: number;
    longitude: number;
    /**
     * A position-matched result from waterDetection. `undefined`, UNKNOWN,
     * or a fail-open response are deliberately not treated as proof of ocean.
     */
    waterStatus?: ShoreWaterStatus | null;
}

export interface ShoreZoneResolution {
    zone: LoggingZone;
    latitude: number;
    longitude: number;
    /** Null when no trustworthy shoreline distance was available. */
    coastDistanceNm: number | null;
    waterStatus: ShoreWaterStatus | null;
    /** True only when an actual OCEAN result and coastline geometry agreed. */
    confirmed: boolean;
}

export interface ShoreZoneResolverOptions {
    /** Injectable for focused tests and future offline chart-backed sources. */
    fetchSegments?: (latitude: number, longitude: number) => Promise<Segment[] | null>;
    /** Fires only after the resolver's committed zone actually changes. */
    onZoneChange?: (resolution: ShoreZoneResolution) => void;
}

interface CoastlineCache {
    latitude: number;
    longitude: number;
    segments: Segment[];
}

interface FailureCache {
    latitude: number;
    longitude: number;
    at: number;
}

interface RequestedObservation {
    generation: number;
    value: ShoreZoneObservation;
}

/** Great-circle distance in nautical miles for cache-coverage checks. */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True only for a real, ocean-water response — fail-open is not evidence. */
export function isConfirmedOcean(waterStatus?: ShoreWaterStatus | null): waterStatus is ShoreWaterStatus {
    return waterStatus?.isWater === true && waterStatus.feature === 'OCEAN' && waterStatus.failedOpen !== true;
}

/** A finite latitude/longitude that can safely be sent to geometry helpers. */
export function isValidCoordinate(latitude: number, longitude: number): boolean {
    return (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180 &&
        !(latitude === 0 && longitude === 0)
    );
}

/**
 * Smallest distance from a GPS point to any OSM coastline segment.
 *
 * `null` means there was no usable segment, not that the point is far from
 * land. Callers must retain the dense fallback in that case.
 */
export function nearestCoastDistanceNm(latitude: number, longitude: number, segments: Segment[]): number | null {
    if (!isValidCoordinate(latitude, longitude) || !Array.isArray(segments)) return null;

    const here = turfPoint([longitude, latitude]);
    let nearestKm = Infinity;

    for (const segment of segments) {
        const a = segment?.[0];
        const b = segment?.[1];
        if (
            !a ||
            !b ||
            !Number.isFinite(a[0]) ||
            !Number.isFinite(a[1]) ||
            !Number.isFinite(b[0]) ||
            !Number.isFinite(b[1])
        ) {
            continue;
        }

        try {
            const distanceKm = pointToLineDistance(here, lineString([a, b]));
            if (Number.isFinite(distanceKm) && distanceKm < nearestKm) nearestKm = distanceKm;
        } catch {
            // A malformed OSM fragment is non-authoritative; the remaining
            // valid segments can still prove the nearby coastline.
        }
    }

    return Number.isFinite(nearestKm) ? nearestKm * KM_TO_NM : null;
}

/**
 * Apply the zone thresholds without mutating confirmation state.
 *
 * This intentionally permits a direct nearshore → offshore candidate when a
 * vessel starts well clear of land; the resolver still requires two matching
 * observations before committing to that lower-detail profile.
 */
export function classifyShoreZone(
    previousZone: LoggingZone,
    waterStatus?: ShoreWaterStatus | null,
    coastDistanceNm?: number | null,
): LoggingZone {
    if (!isConfirmedOcean(waterStatus) || coastDistanceNm == null || !Number.isFinite(coastDistanceNm)) {
        return 'nearshore';
    }

    switch (previousZone) {
        case 'offshore':
            if (coastDistanceNm <= NEARSHORE_ENTER_NM) return 'nearshore';
            if (coastDistanceNm <= OFFSHORE_ENTER_NM) return 'coastal';
            return 'offshore';
        case 'coastal':
            if (coastDistanceNm <= NEARSHORE_ENTER_NM) return 'nearshore';
            if (coastDistanceNm > OFFSHORE_EXIT_NM) return 'offshore';
            return 'coastal';
        case 'nearshore':
        default:
            if (coastDistanceNm > OFFSHORE_EXIT_NM) return 'offshore';
            if (coastDistanceNm > NEARSHORE_EXIT_NM) return 'coastal';
            return 'nearshore';
    }
}

function densityRank(zone: LoggingZone): number {
    switch (zone) {
        case 'nearshore':
            return 0;
        case 'coastal':
            return 1;
        case 'offshore':
            return 2;
    }
}

/**
 * A position-bound, conservative zone resolver.
 *
 * Calls to observe() are coalesced: only the newest GPS observation may alter
 * the committed zone. Older callers resolve to null rather than reporting a
 * stale location's answer as though it described the live vessel.
 */
export class ShoreZoneResolver {
    private readonly fetchSegments: (latitude: number, longitude: number) => Promise<Segment[] | null>;
    private readonly onZoneChange?: (resolution: ShoreZoneResolution) => void;

    private zone: LoggingZone = 'nearshore';
    private latestResolution: ShoreZoneResolution | null = null;
    private coastlineCache: CoastlineCache | null = null;
    private failureCache: FailureCache | null = null;

    private pendingSparseZone: LoggingZone | null = null;
    private sparseConfirmationCount = 0;

    private requestedGeneration = 0;
    private processedGeneration = 0;
    private latestRequest: RequestedObservation | null = null;
    private processing: Promise<void> | null = null;

    constructor(options: ShoreZoneResolverOptions = {}) {
        this.fetchSegments = options.fetchSegments ?? fetchCoastlineSegments;
        this.onZoneChange = options.onZoneChange;
    }

    /** The last committed profile — useful when a caller does not need coordinates. */
    get currentZone(): LoggingZone {
        return this.zone;
    }

    /** Snapshot of the most recent committed evidence, if any. */
    getLastResolution(): ShoreZoneResolution | null {
        return this.latestResolution ? { ...this.latestResolution } : null;
    }

    /**
     * Start a fresh voyage/resume decision from the dense safe profile.
     *
     * Coastline geometry is static and remains useful across voyages, so it
     * is deliberately retained. Incrementing the generation invalidates any
     * in-flight answer from the prior voyage before it can commit a zone or
     * notify a new owner.
     */
    reset(): void {
        this.zone = 'nearshore';
        this.latestResolution = null;
        this.pendingSparseZone = null;
        this.sparseConfirmationCount = 0;

        this.requestedGeneration++;
        this.processedGeneration = this.requestedGeneration;
        this.latestRequest = null;
    }

    /**
     * Synchronous profile lookup for a live GPS callback.
     *
     * Reuse is limited to the real OSM coastline envelope that was fetched
     * for this voyage. `observe()` still runs for every raw fix and updates
     * threshold crossings asynchronously; retaining the existing profile
     * through that microtask avoids false nearshore→coastal→nearshore flaps
     * every few hundred metres while travelling along one cached coastline.
     * Anything outside the proven geometry envelope gets the dense fallback.
     */
    profileFor(latitude: number, longitude: number): LoggingZone {
        const resolution = this.latestResolution;
        if (!resolution || !resolution.confirmed || !isValidCoordinate(latitude, longitude)) return 'nearshore';
        const coastline = this.coastlineCache;
        if (
            !coastline ||
            distanceNm(latitude, longitude, coastline.latitude, coastline.longitude) > COASTLINE_COVERAGE_NM
        ) {
            return 'nearshore';
        }
        return this.zone;
    }

    /**
     * Resolve a zone from this exact GPS observation.
     *
     * Returns null only when this call was superseded by a newer observation;
     * an unresolved/unsafe answer is returned as the explicit `nearshore`
     * fallback so callers never accidentally retain an old offshore profile.
     */
    async observe(observation: ShoreZoneObservation): Promise<LoggingZone | null> {
        const generation = ++this.requestedGeneration;
        this.latestRequest = { generation, value: observation };
        this.ensureProcessing();
        return this.waitForGeneration(generation);
    }

    private ensureProcessing(): void {
        if (this.processing) return;
        this.processing = this.drainLatestRequests().finally(() => {
            this.processing = null;
            // A new request can land as the settled promise is unwinding.
            // Start its drain rather than exposing a stale result.
            if (this.processedGeneration < this.requestedGeneration) this.ensureProcessing();
        });
    }

    private async waitForGeneration(generation: number): Promise<LoggingZone | null> {
        while (true) {
            const active = this.processing;
            if (active) await active;

            if (generation !== this.requestedGeneration) return null;
            if (this.processedGeneration >= generation) return this.latestResolution?.zone ?? 'nearshore';

            this.ensureProcessing();
            // Let ensureProcessing install the next async task before looping.
            await Promise.resolve();
        }
    }

    private async drainLatestRequests(): Promise<void> {
        while (this.processedGeneration < this.requestedGeneration) {
            const request = this.latestRequest;
            if (!request) return;

            const resolution = await this.resolve(request.value);

            // A slow network result for an older coordinate is allowed to
            // populate the geometry cache, but it is never allowed to alter
            // the live profile or invoke the callback.
            if (request.generation !== this.requestedGeneration) continue;

            this.commit(resolution);
            this.processedGeneration = request.generation;
        }
    }

    private async resolve(observation: ShoreZoneObservation): Promise<ShoreZoneResolution> {
        const waterStatus = observation.waterStatus ?? null;
        const fallback = (): ShoreZoneResolution => ({
            zone: 'nearshore',
            latitude: observation.latitude,
            longitude: observation.longitude,
            coastDistanceNm: null,
            waterStatus,
            confirmed: false,
        });

        if (!isValidCoordinate(observation.latitude, observation.longitude) || !isConfirmedOcean(waterStatus)) {
            return fallback();
        }

        const segments = await this.coastlineFor(observation.latitude, observation.longitude);
        if (!segments) return fallback();

        const coastDistanceNm = nearestCoastDistanceNm(observation.latitude, observation.longitude, segments);
        if (coastDistanceNm == null) {
            // A successful empty OSM result means the point is clear of the
            // source's 60 km envelope. With confirmed OCEAN evidence this is
            // enough to consider it genuinely offshore.
            if (segments.length === 0) {
                // Represent “beyond the fetched envelope” as a finite lower
                // bound. The classifier intentionally rejects NaN/Infinity
                // as untrusted geometry, so do not pass Infinity here.
                const offshoreLowerBoundNm = COASTLINE_COVERAGE_NM + 1;
                return {
                    zone: classifyShoreZone(this.zone, waterStatus, offshoreLowerBoundNm),
                    latitude: observation.latitude,
                    longitude: observation.longitude,
                    coastDistanceNm: offshoreLowerBoundNm,
                    waterStatus,
                    confirmed: true,
                };
            }
            return fallback();
        }

        return {
            zone: classifyShoreZone(this.zone, waterStatus, coastDistanceNm),
            latitude: observation.latitude,
            longitude: observation.longitude,
            coastDistanceNm,
            waterStatus,
            confirmed: true,
        };
    }

    private async coastlineFor(latitude: number, longitude: number): Promise<Segment[] | null> {
        const cached = this.coastlineCache;
        if (cached && distanceNm(latitude, longitude, cached.latitude, cached.longitude) <= COASTLINE_COVERAGE_NM) {
            return cached.segments;
        }

        const failed = this.failureCache;
        if (
            failed &&
            distanceNm(latitude, longitude, failed.latitude, failed.longitude) <= COASTLINE_COVERAGE_NM &&
            Date.now() - failed.at < FAILURE_RETRY_MS
        ) {
            return null;
        }

        const segments = await this.fetchSegments(latitude, longitude);
        if (segments == null) {
            this.failureCache = { latitude, longitude, at: Date.now() };
            return null;
        }

        this.failureCache = null;
        this.coastlineCache = { latitude, longitude, segments };
        return segments;
    }

    private commit(resolution: ShoreZoneResolution): void {
        const previousZone = this.zone;
        const candidate = resolution.zone;

        if (candidate === previousZone) {
            this.pendingSparseZone = null;
            this.sparseConfirmationCount = 0;
            this.latestResolution = { ...resolution, zone: previousZone };
            return;
        }

        // Moving toward more detail is immediate: an approaching coastline
        // must never wait for another network or timer sample.
        if (densityRank(candidate) < densityRank(previousZone)) {
            this.pendingSparseZone = null;
            this.sparseConfirmationCount = 0;
            this.zone = candidate;
            this.latestResolution = { ...resolution, zone: candidate };
            this.onZoneChange?.(this.latestResolution);
            return;
        }

        // Less detail needs two matching observations. This lets a small
        // coastline/position disagreement cost a little storage, never track
        // fidelity near land.
        if (this.pendingSparseZone === candidate) {
            this.sparseConfirmationCount++;
        } else {
            this.pendingSparseZone = candidate;
            this.sparseConfirmationCount = 1;
        }

        if (this.sparseConfirmationCount >= SPARSE_ZONE_CONFIRMATIONS) {
            this.zone = candidate;
            this.pendingSparseZone = null;
            this.sparseConfirmationCount = 0;
            this.latestResolution = { ...resolution, zone: candidate };
            this.onZoneChange?.(this.latestResolution);
            return;
        }

        // Keep the committed dense zone until the candidate is corroborated.
        this.latestResolution = { ...resolution, zone: previousZone };
    }
}
