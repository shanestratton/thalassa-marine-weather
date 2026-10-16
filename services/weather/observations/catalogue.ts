import { numberIn, safeText, validPosition, type Station } from './model';
import { distanceNm } from './nearby';
import type { ObservationRequest } from './requests';

export const airportCatalogueRequest = (): ObservationRequest => ({
    url: 'https://aviationweather.gov/data/cache/stations.cache.json.gz',
    nativeOnly: true,
    timeoutMs: 15000,
    maxBytes: 512 * 1024,
    redirect: 'error',
    credentials: 'omit',
    ttlMs: 24 * 3600000,
});
/** Official AWC station cache. Only stations explicitly publishing METAR are airport candidates. */
export function parseAirportCatalogue(text: string): Station[] {
    if (new TextEncoder().encode(text).length > 3 * 1024 * 1024) throw new Error('Airport catalogue too large');
    const body: unknown = JSON.parse(text);
    if (!Array.isArray(body) || body.length > 15000) throw new Error('Invalid airport catalogue');
    const seen = new Set<string>();
    const stations: Station[] = [];
    for (const value of body) {
        if (!value || typeof value !== 'object') continue;
        const r = value as Record<string, unknown>;
        const id = typeof r.icaoId === 'string' ? r.icaoId : null,
            lat = numberIn(r.lat, -90, 90),
            lon = numberIn(r.lon, -180, 180);
        if (
            !id ||
            !/^[A-Z0-9]{4}$/.test(id) ||
            seen.has(id) ||
            !Array.isArray(r.siteType) ||
            !r.siteType.includes('METAR') ||
            lat === null ||
            lon === null ||
            !validPosition(lat, lon)
        )
            continue;
        seen.add(id);
        stations.push({ id, name: safeText(r.site) ?? id, lat, lon, exposure: 'metar-station', owner: null });
    }
    if (!stations.length) throw new Error('Airport catalogue empty');
    return stations;
}
export function nearbyAirportIds(
    stations: readonly Station[],
    point: { lat: number; lon: number },
    radiusNm = 50,
): string[] {
    return stations
        .map((station) => ({ station, distance: distanceNm(point, station) }))
        .filter((r) => r.distance <= radiusNm)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8)
        .map((r) => r.station.id);
}
