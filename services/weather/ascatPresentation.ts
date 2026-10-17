import type mapboxgl from 'mapbox-gl';
import { ASCAT_LIMITS, type AscatRow } from './ascatContract';
export const ASCAT_SOURCE = 'ascat-observed141-source';
export const ASCAT_LINES = 'ascat-observed141-arrows';
export const ASCAT_CALM = 'ascat-observed141-calm';
export function ascatAge(at: number, now = Date.now()): string {
    const minutes = Math.max(0, Math.floor((now / 1000 - at) / 60));
    return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}
export const ascatCompass = (bearing: number) =>
    ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
        Math.round(bearing / 22.5) % 16
    ];
/** Screen thinning chooses an actual newest vector, preserving its original UTC/source. */
export function ascatOverlay(
    map: mapboxgl.Map,
    rows: readonly AscatRow[],
    now = Date.now(),
): { data: GeoJSON.FeatureCollection; shown: readonly AscatRow[] } {
    const container = map.getContainer(),
        centre = map.getCenter();
    const width = container.clientWidth,
        height = container.clientHeight;
    if (width < 1 || height < 1 || !Number.isFinite(centre.lng)) throw new Error('Satellite viewport unavailable');
    const occupied = new Set<string>(),
        features: GeoJSON.Feature[] = [],
        shown: AscatRow[] = [];
    for (const row of [...rows].sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1])) {
        if (row[2] <= now / 1000 - 86400 || Math.abs(row[1]) > 85.05112878) continue;
        const point = map.project([row[0] + 360 * Math.round((centre.lng - row[0]) / 360), row[1]]);
        if (
            ![point.x, point.y].every(Number.isFinite) ||
            point.x < 0 ||
            point.y < 0 ||
            point.x > width ||
            point.y > height
        )
            continue;
        const key = `${Math.floor(point.x / 28)},${Math.floor(point.y / 28)}`;
        if (occupied.has(key)) continue;
        let geometry: GeoJSON.Geometry;
        if (row[3] === 0) geometry = { type: 'Point', coordinates: [row[0], row[1]] };
        else {
            // Source values are FROM; arrows point downwind. No data conversion is applied again.
            const angle = ((row[4] + 180) * Math.PI) / 180,
                length = Math.min(28, 10 + row[3] * 0.7);
            const dx = Math.sin(angle) * length,
                dy = -Math.cos(angle) * length;
            const pixels = [
                [point.x - dx / 2, point.y - dy / 2],
                [point.x + dx / 2, point.y + dy / 2],
                [point.x + dx * 0.15 - dy * 0.25, point.y + dy * 0.15 + dx * 0.25],
                [point.x + dx / 2, point.y + dy / 2],
                [point.x + dx * 0.15 + dy * 0.25, point.y + dy * 0.15 - dx * 0.25],
            ];
            const coordinates = pixels.map(([x, y]) => {
                const p = map.unproject([x, y]);
                return [((p.lng + 540) % 360) - 180, p.lat];
            });
            // Never join an arrow across the whole world or beyond Mercator.
            if (
                coordinates.some(
                    ([lon, lat]) =>
                        !Number.isFinite(lon) ||
                        !Number.isFinite(lat) ||
                        Math.abs(lon - row[0]) > 180 ||
                        Math.abs(lat) > 85.05112878,
                )
            )
                continue;
            geometry = { type: 'LineString', coordinates };
        }
        occupied.add(key);
        features.push({ type: 'Feature', geometry, properties: { row: shown.length } });
        shown.push(row);
        if (shown.length === ASCAT_LIMITS.arrows) break;
    }
    return { data: { type: 'FeatureCollection', features }, shown };
}
