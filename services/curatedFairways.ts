/**
 * Curated marina fairways — hand-drawn navigable lanes from a berth cluster out
 * to the nearest channel, for marinas whose internal fairway isn't charted
 * anywhere (the ENC and OSM give only a whole-basin outline plus the pontoons).
 * Without the lane the coarse router runs the geometric centre of the basin,
 * straight over the pens (Shane 2026-07-07, Mooloolaba homecoming).
 *
 * Injected as waterway=fairway CANAL LineStrings: the engine carves them to a
 * navigable corridor (navGrid Pass 1b) and keeps that corridor clear of the
 * berth carve (Pass 2c), and the tier routing follows it — so a wharf start
 * rides the fairway between the rows instead of over them. Curated per marina;
 * each is validated ≥ ~50 m clear of every OSM pontoon before shipping.
 */
import type { Feature } from 'geojson';

interface CuratedFairway {
    id: string;
    /** [minLon, minLat, maxLon, maxLat] — inject only when the route bbox overlaps. */
    bbox: [number, number, number, number];
    /** Ordered navigable lane, [lon, lat], berth-cluster end first. */
    line: [number, number][];
}

// Mooloolaba Wharf Marina (Shane's home berth ≈ 153.1203,-26.6839). OSM has 122
// finger pontoons but no exit fairway and no leisure=marina polygon. This lane
// runs from the western berths NORTH into the river channel (clear of the
// pontoon ends) then EAST to the entrance, joining the Mooloolah bar approach.
const MOOLOOLABA: CuratedFairway = {
    id: 'mooloolaba-marina',
    bbox: [153.116, -26.686, 153.135, -26.679],
    line: [
        [153.1203, -26.6839],
        [153.1206, -26.6827],
        [153.1235, -26.6819],
        [153.127, -26.6812],
        [153.13, -26.6804],
        [153.1322, -26.6798],
    ],
};

const CURATED_FAIRWAYS: readonly CuratedFairway[] = [MOOLOOLABA];

/**
 * CANAL-layer features (waterway=fairway) for every curated fairway whose bbox
 * overlaps the route bbox. Empty when none apply — a no-op everywhere else.
 */
export function curatedFairwayCanalFeatures(routeBbox: [number, number, number, number]): Feature[] {
    const [w, s, e, n] = routeBbox;
    const out: Feature[] = [];
    for (const f of CURATED_FAIRWAYS) {
        const [fw, fs, fe, fn] = f.bbox;
        if (fw > e || fe < w || fs > n || fn < s) continue; // no bbox overlap
        out.push({
            type: 'Feature',
            properties: { waterway: 'fairway', _source: 'curated-fairway', _id: f.id },
            geometry: { type: 'LineString', coordinates: f.line.map((p) => [p[0], p[1]]) },
        });
    }
    return out;
}
