/**
 * lightSectors — turn a sectored S-57 LIGHTS feature into the arc +
 * limit-line geometry a mariner reads at night: "am I in the white,
 * the red, or the green?"
 *
 * The single biggest fidelity gap vs Navionics/C-MAP for a night
 * approach (2026-07-12 competitive review). A sectored light shows a
 * coloured arc for each visible sector, bounded by two limit bearings.
 * In S-57 each SECTOR is its OWN LIGHTS feature at the same position,
 * carrying SECTR1 (leftmost limit) and SECTR2 (rightmost limit) as TRUE
 * bearings *from seaward* (i.e. as measured from a ship looking at the
 * light), plus its own COLOUR. So one feature → one arc.
 *
 * Depiction (INT1 IP 40.1-41): the lit arc is swept CLOCKWISE from
 * SECTR1 to SECTR2 as seen from the light, drawn at a modest fixed
 * radius so a 20 M light doesn't paint half the screen; the two limit
 * bearings extend as thin dashed legs. Bearings are drawn directly from
 * the light position on the given true bearings — the standard chart
 * convention (the "from seaward" framing is what a helmsman reads off
 * the water; on the chart the same bearing lines radiate from the
 * structure).
 *
 * Pure + unit-tested: no Mapbox, no map. EncHazardService calls
 * buildSectorFeatures at merge time into a LIGHTSEC collection.
 */

import type { Feature, LineString } from 'geojson';

/** Metres → degrees of latitude (WGS-84 mean). */
const M_PER_DEG_LAT = 111_320;

/** Arc radius (the coloured band) and limit-leg length, in metres.
 *  Fixed geographic size: reads at harbour/approach zoom, shrinks to a
 *  dot when zoomed out (natural declutter), and the renderer gates the
 *  layer to z11+ regardless. Legs run past the arc so the wedge reads
 *  as a wedge, S-52 style. */
export const SECTOR_ARC_RADIUS_M = 900;
export const SECTOR_LEG_RADIUS_M = 1300;

/** One arc point every this many degrees of sweep — smooth enough at
 *  the drawn radius, cheap on the merged heap. */
const ARC_STEP_DEG = 3;

export interface SectorInput {
    /** Light position [lon, lat]. */
    position: [number, number];
    /** SECTR1 — leftmost sector limit, true degrees. */
    sectr1: number;
    /** SECTR2 — rightmost sector limit, true degrees. */
    sectr2: number;
    /** Display hex for the sector colour (from lightColourHex). */
    colorHex: string;
    /** Extra properties to copy onto the emitted features (provenance,
     *  _minZoom, OBJNAM, light character…). */
    baseProps?: Record<string, unknown>;
}

/** Forward point from an origin on a true bearing (clockwise from N),
 *  small-distance equirectangular offset — exact enough at <2 km. */
function forward(lon: number, lat: number, bearingDeg: number, distM: number): [number, number] {
    const br = (bearingDeg * Math.PI) / 180;
    const dLat = (distM * Math.cos(br)) / M_PER_DEG_LAT;
    const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
    const dLon = (distM * Math.sin(br)) / (M_PER_DEG_LAT * cosLat);
    return [lon + dLon, lat + dLat];
}

/** Clockwise sweep in degrees from a→b (S-57 sectors run clockwise
 *  SECTR1→SECTR2 as seen from the light). Always in (0, 360]; a light
 *  where SECTR1===SECTR2 is an all-round sector → 360. */
export function clockwiseSweep(a: number, b: number): number {
    const raw = (((b - a) % 360) + 360) % 360;
    return raw === 0 ? 360 : raw;
}

/**
 * Build the display features for one light sector:
 *  - a coloured arc LineString (`_secKind: 'arc'`, `_secColor: hex`),
 *  - two thin limit-leg LineStrings (`_secKind: 'leg'`).
 * Returns [] when the bearings aren't finite numbers.
 */
export function buildSectorFeatures(input: SectorInput): Feature<LineString>[] {
    const { position, sectr1, sectr2, colorHex, baseProps = {} } = input;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(sectr1) || !Number.isFinite(sectr2)) {
        return [];
    }

    const sweep = clockwiseSweep(sectr1, sectr2);
    const steps = Math.max(1, Math.ceil(sweep / ARC_STEP_DEG));
    const arcCoords: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
        const bearing = sectr1 + (sweep * i) / steps;
        arcCoords.push(forward(lon, lat, bearing, SECTOR_ARC_RADIUS_M));
    }

    const mkLeg = (bearing: number): Feature<LineString> => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[lon, lat], forward(lon, lat, bearing, SECTOR_LEG_RADIUS_M)] },
        properties: { ...baseProps, _secKind: 'leg', _secColor: colorHex },
    });

    const features: Feature<LineString>[] = [
        {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: arcCoords },
            properties: { ...baseProps, _secKind: 'arc', _secColor: colorHex },
        },
    ];
    // A near-all-round sector has no meaningful limit legs.
    if (sweep < 359) {
        features.push(mkLeg(sectr1), mkLeg(sectr2));
    }
    return features;
}

/** Read a light feature's sector bearings, defending upper/lower case
 *  and the `_attr136`/`_attr137` fallback (SECTR1/SECTR2 S-57 codes)
 *  for cells whose extractor lacked the attribute catalogue entry. */
export function readSectorBearings(props: Record<string, unknown>): { sectr1: number; sectr2: number } | null {
    const read = (...keys: string[]): number | null => {
        for (const k of keys) {
            const v = props[k];
            if (v == null) continue;
            const n = typeof v === 'number' ? v : Number(v);
            if (Number.isFinite(n)) return n;
        }
        return null;
    };
    const s1 = read('SECTR1', 'sectr1', '_attr136');
    const s2 = read('SECTR2', 'sectr2', '_attr137');
    if (s1 == null || s2 == null) return null;
    return { sectr1: s1, sectr2: s2 };
}
