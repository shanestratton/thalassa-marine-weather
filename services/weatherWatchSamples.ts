import type { WeatherWatchSample } from '../utils/weatherWatch';
/** Only coordinates selected by the owner cross this seam. No route/chart object can be serialized. */
export async function authorizedRouteSamples(
    line: readonly { lat: number; lon: number }[],
    now: number,
): Promise<WeatherWatchSample[]> {
    if (
        line.length < 2 ||
        line.length > 10_000 ||
        !line.every(
            (p) => Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180,
        )
    )
        throw new Error('Invalid route');
    const coordinates = line.map((p) => [p.lat, p.lon]);
    const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(coordinates)))),
    )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
    // Bounded coordinate samples, explicitly NOT continuous route coverage.
    const count = Math.min(8, line.length);
    return Array.from({ length: count }, (_, i) => {
        const point = line[Math.round((i * (line.length - 1)) / (count - 1))];
        return {
            key: `route:${digest}:${i}`,
            kind: 'route',
            label: `Registered route sample ${i + 1}`,
            lat: point.lat,
            lon: point.lon,
            sourceAt: now,
            expiresAt: now + 48 * 3_600_000,
        };
    });
}
export async function currentBoatWeatherSample(now: number): Promise<WeatherWatchSample | null> {
    const { NmeaStore } = await import('./NmeaStore');
    const position = NmeaStore.getState().instrumentEvidence?.position;
    if (
        !position ||
        !Number.isFinite(position.lat) ||
        !Number.isFinite(position.lon) ||
        Math.abs(position.lat) > 90 ||
        Math.abs(position.lon) > 180 ||
        !Number.isSafeInteger(position.at) ||
        position.at > now ||
        now - position.at > 13_000
    )
        return null;
    return {
        key: 'boat:position',
        kind: 'boat',
        label: 'Registered boat position',
        lat: position.lat,
        lon: position.lon,
        sourceAt: position.at,
        expiresAt: position.at + 15 * 60_000,
    };
}
