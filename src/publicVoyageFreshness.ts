/**
 * Client-side mirrors of the public voyage-log server's freshness contracts.
 * The dashboard keeps rendering the last successful payload during an outage,
 * so every present-tense surface must re-evaluate these bounds on its own clock.
 */

/** The edge function only considers a trickled voyage current for ten minutes. */
export const PUBLIC_POSITION_FRESH_MS = 10 * 60_000;

/** `vessels_nearby` never intentionally returns AIS positions older than two hours. */
export const PUBLIC_AIS_MAX_AGE_MS = 2 * 60 * 60_000;

/** Allow small cross-device/server clock skew, but never bank material future freshness. */
const MAX_FUTURE_SKEW_MS = 60_000;

export type NearbyVesselFreshness = 'fresh' | 'last-known' | 'expired';

export function publicTimestampAgeMs(value: string | number | null | undefined, nowMs: number): number | null {
    const timestampMs = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || timestampMs > nowMs + MAX_FUTURE_SKEW_MS) {
        return null;
    }
    return Math.max(0, nowMs - timestampMs);
}

export function isPublicPositionFresh(updatedAt: string | null | undefined, nowMs: number): boolean {
    const ageMs = publicTimestampAgeMs(updatedAt, nowMs);
    return ageMs !== null && ageMs < PUBLIC_POSITION_FRESH_MS;
}

export function classifyNearbyVesselFreshness(
    updatedAt: string | null | undefined,
    nowMs: number,
    connectionLost: boolean,
): NearbyVesselFreshness {
    const ageMs = publicTimestampAgeMs(updatedAt, nowMs);
    if (ageMs === null || ageMs >= PUBLIC_AIS_MAX_AGE_MS) return 'expired';
    if (connectionLost || ageMs >= PUBLIC_POSITION_FRESH_MS) return 'last-known';
    return 'fresh';
}

export function formatPublicAge(value: string | number | null | undefined, nowMs: number): string {
    const ageMs = publicTimestampAgeMs(value, nowMs);
    if (ageMs === null) return 'unknown';
    if (ageMs < 90_000) return 'just now';
    const minutes = Math.floor(ageMs / 60_000);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
}
