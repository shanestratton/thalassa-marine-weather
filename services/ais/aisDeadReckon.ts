/** AIS display projection. The shared rule owns the math so the Pi and popup cannot disagree. */
import { deadReckonAis } from '../../utils/collisionRule';

export { deadReckonAis };

export function aisVectorMinutes(value: unknown): 6 | 12 | 30 {
    return value === 6 || value === 30 ? value : 12;
}

export function aisReportAgeSec(properties: Record<string, unknown>, now = Date.now()): number | null {
    const stamp = properties.updatedAt ?? properties.lastUpdated;
    const time = typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    if (Number.isFinite(time) && time > 0) return Math.max(0, (now - time) / 1000);
    const minutes = properties.staleMinutes;
    return typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 ? minutes * 60 : null;
}

/** Rings and links unwrap at the report so a dateline crossing never draws around the world. */
export function nearLongitude(lon: number, reference: number): number {
    return reference + ((lon - reference + 540) % 360) - 180;
}

export function uncertaintyRing(lat: number, lon: number, radiusNm: number): number[][] {
    // Rendering may use an unwrapped world copy. The spherical projection
    // accepts a geographic longitude; unwrap its vertices only afterwards.
    const centreLon = ((((lon + 180) % 360) + 360) % 360) - 180;
    return Array.from({ length: 49 }, (_, i) => {
        const p = deadReckonAis(lat, centreLon, radiusNm * 6, ((i * 360) / 48) % 360, 600);
        return p ? [nearLongitude(p.lon, lon), p.lat] : [lon, lat];
    });
}

/** Presentation only: real report geometry is never moved or published as a new sensor fix. */
export function buildAisDrFeatures(features: GeoJSON.Feature[], now = Date.now()): GeoJSON.FeatureCollection {
    const estimates: GeoJSON.Feature[] = [];
    for (const f of features) {
        const p = f.properties;
        if (!p || f.geometry?.type !== 'Point') continue;
        const [lon, lat] = f.geometry.coordinates;
        const age = aisReportAgeSec(p, now);
        if (age === null || age <= 60 || typeof p.sog !== 'number' || p.sog < 0.5) continue;
        const dr = deadReckonAis(lat, lon, p.sog, p.cog, age);
        if (!dr) continue;
        const point = [nearLongitude(dr.lon, lon), dr.lat];
        const props = { mmsi: p.mmsi, typeColor: p.typeColor, uncertaintyNm: dr.uncertaintyNm };
        estimates.push(
            {
                type: 'Feature',
                properties: { ...props, kind: 'ghost' },
                geometry: { type: 'Point', coordinates: point },
            },
            {
                type: 'Feature',
                properties: { ...props, kind: 'link' },
                geometry: { type: 'LineString', coordinates: [[lon, lat], point] },
            },
            {
                type: 'Feature',
                properties: { ...props, kind: 'ring' },
                geometry: { type: 'Polygon', coordinates: [uncertaintyRing(dr.lat, point[0], dr.uncertaintyNm)] },
            },
        );
    }
    return { type: 'FeatureCollection', features: estimates };
}
