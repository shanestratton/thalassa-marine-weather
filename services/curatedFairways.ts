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
    bbox: [153.118, -26.689, 153.146, -26.674],
    // Shane's OWN channel, tapped point-by-point 2026-07-07 (v3): berth → down
    // the river past the moorings → round the bend → through the entrance and
    // the bar REF marks → out to sea. [lon, lat].
    line: [
        [153.12073, -26.68332],
        [153.12017, -26.68401],
        [153.12018, -26.68436],
        [153.12094, -26.68484],
        [153.12193, -26.68497],
        [153.12322, -26.68495],
        [153.12432, -26.68537],
        [153.12598, -26.68596],
        [153.12642, -26.68684],
        [153.12743, -26.68744],
        [153.12885, -26.68734],
        [153.12996, -26.68742],
        [153.13154, -26.68736],
        [153.13268, -26.68679],
        [153.13414, -26.68572],
        [153.13504, -26.68471],
        [153.13534, -26.6836],
        [153.13562, -26.68224],
        [153.13488, -26.68126],
        [153.13342, -26.68032],
        [153.13219, -26.67965],
        [153.13193, -26.68003],
        [153.13025, -26.68087],
        [153.12934, -26.68007],
        [153.12983, -26.67641],
        [153.13345, -26.67593],
        [153.13726, -26.67558],
        [153.14152, -26.6762],
        [153.14412, -26.67832],
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
