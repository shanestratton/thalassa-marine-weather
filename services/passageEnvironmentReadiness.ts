/**
 * Durable identity helpers for passage-environment readiness decisions.
 *
 * A readiness tick is only meaningful for the exact route, vessel inputs and
 * provider data the skipper reviewed.  These helpers deliberately keep the
 * identity payload small enough for passage_readiness_checks.metadata while
 * rejecting legacy boolean/index-only records as unverified.
 */

export interface PassageRoutePoint {
    lat: number;
    lon: number;
}

function canonicalise(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalise);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return String(value);
        return Number(value.toFixed(6));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, child]) => child !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, canonicalise(child)]),
        );
    }
    return value;
}

function fnv1a32(value: string, seed: number): string {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** Stable, compact fingerprint for JSON-compatible safety inputs. */
export function passageDataFingerprint(namespace: string, value: unknown): string {
    const canonical = `${namespace}:${JSON.stringify(canonicalise(value))}`;
    return `v1_${fnv1a32(canonical, 0x811c9dc5)}${fnv1a32(canonical, 0x9e3779b9)}`;
}

export function passageRouteFingerprint(
    routeCoordinates: ReadonlyArray<PassageRoutePoint> | null | undefined,
    departure?: PassageRoutePoint | null,
    destination?: PassageRoutePoint | null,
): string {
    const exactRoute = (routeCoordinates ?? []).filter(
        (point) =>
            Number.isFinite(point?.lat) &&
            Number.isFinite(point?.lon) &&
            Math.abs(point.lat) <= 90 &&
            Math.abs(point.lon) <= 180,
    );
    const points =
        exactRoute.length >= 2
            ? exactRoute
            : [departure, destination].filter(
                  (point): point is PassageRoutePoint =>
                      Boolean(point) &&
                      Number.isFinite(point?.lat) &&
                      Number.isFinite(point?.lon) &&
                      Math.abs(point!.lat) <= 90 &&
                      Math.abs(point!.lon) <= 180,
              );
    return passageDataFingerprint('passage-route', points);
}

/**
 * What an acknowledgement BINDS to: the skipper's own inputs — route,
 * speed, distance, bearing. Deliberately NOT the provider data fingerprint
 * (Shane 2026-08-26: 'i seem to have to go into that card everytime and
 * approve… once they are clicked they should stay green for a good week'):
 * currents frames refresh hourly and forecasts every few hours, so a
 * data-bound ack died before the page was reopened — a nag, and nagging
 * teaches punters to click without reading. The record still STORES the
 * data fingerprint so the card can note 'updated since your briefing',
 * and freshness is bounded by PASSAGE_ACK_TTL_MS instead.
 */
export interface CurrentReviewIdentity {
    routeFingerprint: string;
    cruisingSpeedKts: number;
    distanceNm: number;
    courseBearingDeg: number;
}

/** How long an environment acknowledgement stays green — 'a good week'. */
export const PASSAGE_ACK_TTL_MS = 7 * 24 * 3_600_000;

/** True while the ack's own timestamp is within the TTL (and not from the
 *  future — a wrong clock fails closed). */
export function isAcknowledgementFresh(acknowledgedAtIso: string, nowMs: number = Date.now()): boolean {
    const at = Date.parse(acknowledgedAtIso);
    if (!Number.isFinite(at)) return false;
    return nowMs - at >= -5 * 60_000 && nowMs - at <= PASSAGE_ACK_TTL_MS;
}

export interface CurrentAcknowledgementRecord {
    version: 1;
    fingerprint: string;
    routeFingerprint: string;
    dataFingerprint: string;
    acknowledgedAt: string;
}

export function currentReviewFingerprint(identity: CurrentReviewIdentity): string {
    return passageDataFingerprint('ocean-current-review', identity);
}

export function isCurrentAcknowledgementRecord(value: unknown): value is CurrentAcknowledgementRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<CurrentAcknowledgementRecord>;
    return (
        record.version === 1 &&
        typeof record.fingerprint === 'string' &&
        typeof record.routeFingerprint === 'string' &&
        typeof record.dataFingerprint === 'string' &&
        typeof record.acknowledgedAt === 'string'
    );
}

export interface WeatherAcceptanceIdentity {
    departureIso: string;
    routeFingerprint: string;
    vessel: {
        type?: string;
        cruisingSpeedKts?: number;
        maxWindKts?: number;
        maxWaveHeight?: number;
    };
    comfort: {
        maxWindKts?: number;
        maxWaveM?: number;
        maxGustKts?: number;
        preferredAngles?: ReadonlyArray<string>;
    };
    analysisContextFingerprint: string;
}

export interface WeatherWindowAcceptanceRecord {
    version: 1;
    fingerprint: string;
    routeFingerprint: string;
    dataFingerprint: string;
    departureIso: string;
    acceptedAt: string;
}

export function weatherWindowAcceptanceFingerprint(identity: WeatherAcceptanceIdentity): string {
    return passageDataFingerprint('weather-window-acceptance', identity);
}

export function isWeatherWindowAcceptanceRecord(value: unknown): value is WeatherWindowAcceptanceRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<WeatherWindowAcceptanceRecord>;
    return (
        record.version === 1 &&
        typeof record.fingerprint === 'string' &&
        typeof record.routeFingerprint === 'string' &&
        typeof record.dataFingerprint === 'string' &&
        typeof record.departureIso === 'string' &&
        typeof record.acceptedAt === 'string'
    );
}
