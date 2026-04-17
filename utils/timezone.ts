/**
 * timezone.ts — Resolve IANA timezone IDs from lat/lon, with formatting helpers.
 *
 * Weather providers are inconsistent:
 *   - OpenMeteo returns a proper IANA tz (e.g. "America/Chicago")
 *   - Apple WeatherKit returns nothing — we set 'UTC' as a sentinel
 *   - Rainbow.ai returns nothing
 *
 * So we resolve from GPS coords via tz-lookup (offline, bundled polygon data,
 * ~500KB gzipped). Always prefer a valid hint from the provider if given,
 * else fall back to the geographic lookup.
 *
 * All formatters here are IANA-tz-aware.
 */
import tzLookup from 'tz-lookup';

/** Sentinel values we treat as "no real tz provided — please resolve". */
const NO_TZ_HINTS = new Set(['UTC', 'utc', '', 'GMT', 'Z']);

/**
 * Resolve the IANA timezone for a lat/lon, preferring a provider-supplied hint.
 *
 * @param lat    Latitude (-90..90)
 * @param lon    Longitude (-180..180)
 * @param hint   Optional tz string from the weather provider — used if valid
 * @returns      IANA timezone ID, e.g. "America/Chicago". Falls back to "UTC"
 *               only if tz-lookup throws (unreachable in practice).
 *
 * @example
 * resolveTimeZone(30.2, -97.7)               // "America/Chicago" (Austin, TX)
 * resolveTimeZone(-33.87, 151.21)            // "Australia/Sydney"
 * resolveTimeZone(30.2, -97.7, 'UTC')        // "America/Chicago" (sentinel ignored)
 * resolveTimeZone(30.2, -97.7, 'America/Chicago') // "America/Chicago" (hint kept)
 */
export function resolveTimeZone(lat: number, lon: number, hint?: string): string {
    if (hint && !NO_TZ_HINTS.has(hint)) return hint;
    try {
        return tzLookup(lat, lon);
    } catch {
        // tz-lookup only throws for invalid lat/lon; fall back gracefully.
        return 'UTC';
    }
}

/**
 * Format an ISO timestamp as HH:MM in the target IANA timezone.
 * Rounds to the nearest minute.
 *
 * @example
 * formatTimeInZone('2026-04-17T11:30:45Z', 'America/Chicago') // "06:31"
 * formatTimeInZone('2026-04-17T11:30:45Z', 'Australia/Sydney') // "21:31"
 */
export function formatTimeInZone(iso: string | Date, timeZone: string): string {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    if (isNaN(d.getTime())) return '--:--';
    // Round to nearest minute
    if (d.getSeconds() >= 30) d.setMinutes(d.getMinutes() + 1);
    d.setSeconds(0, 0);
    try {
        return d.toLocaleTimeString('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        // Invalid timezone ID — fall back to device local.
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
}
