/** Derive site-specific coastline fetch, not a nearby bay's shelter table.
 * Uses the existing QLD coastline source cache; missing/partial tiles stay unknown.
 * No network, scheduler, invented depths or tide-dependent reef protection. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const directory = new URL('../../public/anchorages/moorings/', import.meta.url);
const snapshot = JSON.parse(readFileSync(new URL('qpws.json', directory), 'utf8'));
const tiles = new Map();
const points = {};
for (const feature of snapshot.data.features) {
    const [lon, lat] = feature.geometry.coordinates;
    const key = `t${Math.floor(lat / 2) * 2}e${Math.floor(lon / 2) * 2}`;
    if (!tiles.has(key)) {
        const file = new URL(`.cache/coast-${key}.json`, import.meta.url);
        const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
        const segments = [];
        let valid = raw && !raw.remark && Array.isArray(raw.elements) && !!raw.osm3s?.timestamp_osm_base;
        for (const e of raw?.elements ?? []) {
            if (e.type !== 'way' || !Array.isArray(e.geometry) || e.geometry.length < 2) {
                valid = false;
                continue;
            }
            for (let i = 1; i < e.geometry.length; i++) {
                const a = e.geometry[i - 1],
                    b = e.geometry[i];
                if (![a.lon, a.lat, b.lon, b.lat].every(Number.isFinite)) {
                    valid = false;
                    continue;
                }
                segments.push([a.lon, a.lat, b.lon, b.lat]);
            }
        }
        tiles.set(key, valid ? { segments, sourceAt: raw.osm3s.timestamp_osm_base } : null);
    }
    const tile = tiles.get(key);
    if (!tile) continue;
    const cos = Math.cos((lat * Math.PI) / 180);
    const segments = tile.segments.map(([ax, ay, bx, by]) => [
        (ax - lon) * 60 * cos,
        (ay - lat) * 60,
        (bx - lon) * 60 * cos,
        (by - lat) * 60,
    ]);
    const fetchLandNM = Array.from({ length: 36 }, (_, s) => {
        const dx = Math.sin((s * Math.PI) / 18),
            dy = Math.cos((s * Math.PI) / 18);
        let nearest = 15;
        for (const [ax, ay, bx, by] of segments) {
            const ex = bx - ax,
                ey = by - ay,
                denom = dx * ey - dy * ex;
            if (Math.abs(denom) < 1e-12) continue;
            const t = (ax * ey - ay * ex) / denom;
            const u = (ax * dy - ay * dx) / denom;
            if (t > 0 && t < nearest && u >= 0 && u <= 1) nearest = t;
        }
        return +nearest.toFixed(2);
    });
    points[`qpws-${feature.properties.objectid}`] = { lat, lon, fetchLandNM, sourceAt: tile.sourceAt };
}
const output = {
    builtAt: new Date().toISOString(),
    mooringSnapshotAt: snapshot.retrievedAt,
    source: '© OpenStreetMap contributors (ODbL); coastline geometry, not verified shelter',
    points,
};
writeFileSync(new URL('shelter.json', directory), JSON.stringify(output));
console.log(
    `Coastline shelter tables: ${Object.keys(points).length}/${snapshot.data.features.length} mooring positions; missing tiles remain unassessed.`,
);
