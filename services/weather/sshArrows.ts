import type { SshObservation } from './api/sshObservations';
import { sampleScalarGrid } from './scalarGridImage';

/** At most 96 display arrows. No interpolation across unknown/ice cells or path/routing output. */
export function sshGeostrophicArrows(
    observation: SshObservation,
    bounds: readonly [west: number, south: number, east: number, north: number],
): GeoJSON.FeatureCollection<GeoJSON.MultiLineString> {
    const features: GeoJSON.Feature<GeoJSON.MultiLineString>[] = [];
    const [west, rawSouth, east, rawNorth] = bounds;
    if (!bounds.every(Number.isFinite) || east <= west || east - west > 360 || rawNorth <= rawSouth)
        return { type: 'FeatureCollection', features };
    const south = Math.max(-80, rawSouth),
        north = Math.min(80, rawNorth);
    if (north <= south) return { type: 'FeatureCollection', features };
    const dx = (east - west) / 12,
        dy = (north - south) / 8;
    for (let row = 0; row < 8; row++)
        for (let col = 0; col < 12; col++) {
            const lat = south + (row + 0.5) * dy,
                lon = ((((west + (col + 0.5) * dx + 180) % 360) + 360) % 360) - 180;
            const u = sampleScalarGrid(observation.eastward, lon, lat),
                v = sampleScalarGrid(observation.northward, lon, lat);
            if (u === null || v === null) continue;
            const speed = Math.hypot(u, v);
            if (speed < 0.02) continue;
            const length = Math.min(dx * Math.cos((lat * Math.PI) / 180), dy) * 0.32;
            const ex = u / speed,
                ey = v / speed,
                cos = Math.cos((lat * Math.PI) / 180);
            const point = (x: number, y: number): number[] => [lon + (x * length) / cos, lat + y * length];
            const tail = point(-ex / 2, -ey / 2),
                tip = point(ex / 2, ey / 2);
            const left = point(ex * 0.1 - ey * 0.2, ey * 0.1 + ex * 0.2),
                right = point(ex * 0.1 + ey * 0.2, ey * 0.1 - ex * 0.2);
            if ([tail, tip, left, right].some((p) => p[0] < -180 || p[0] > 180 || p[1] < -85 || p[1] > 85)) continue;
            features.push({
                type: 'Feature',
                properties: {
                    kind: 'geostrophic',
                    eastward: u,
                    northward: v,
                    speedMps: speed,
                    sourceTimeMs: observation.sourceTimeMs,
                },
                geometry: {
                    type: 'MultiLineString',
                    coordinates: [
                        [tail, tip],
                        [left, tip],
                        [right, tip],
                    ],
                },
            });
        }
    return { type: 'FeatureCollection', features };
}
