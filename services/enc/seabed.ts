import type { Feature, Geometry, Position } from 'geojson';
import { haversineM, pointInGeometry } from '../engine/geometry';

/** IHO S-57 NATSUR / S-52 seabed abbreviations. In particular 11 is lava,
 * 14 coral, 17 shells, 18 boulders. WEDKLP is a separate object class.
 * https://legacy.iho.int/mtg_docs/com_wg/TSMAD/TSMAD26/TSMAD26_DIPWG5-8.1C_S-52_PresLib_v3.4_to_v4.0_Redlines.pdf */
const NATURE: Record<number, readonly [string, string, string]> = {
    1: ['Mud', 'M', '#82907e'],
    2: ['Clay', 'Cy', '#a08e7f'],
    3: ['Silt', 'Si', '#9a9b80'],
    4: ['Sand', 'S', '#c7b682'],
    5: ['Stone', 'St', '#a59a8b'],
    6: ['Gravel', 'G', '#a59a8b'],
    7: ['Pebbles', 'P', '#a59a8b'],
    8: ['Cobbles', 'Cb', '#a59a8b'],
    9: ['Rock', 'R', '#9c8b8b'],
    11: ['Lava', 'R', '#9c8b8b'],
    14: ['Coral', 'Co', '#ba8a91'],
    17: ['Shells', 'Sh', '#b6ad99'],
    18: ['Boulders', 'R', '#9c8b8b'],
};
const VEGETATION: typeof NATURE = {
    1: ['Kelp', 'Kelp', '#80966b'],
    2: ['Sea weed', 'Weed', '#80966b'],
    3: ['Sea grass', 'Grass', '#80966b'],
    4: ['Sargassum', 'Sargassum', '#80966b'],
};
function decodeNature(value: unknown, dictionary: typeof NATURE, vegetation = false) {
    const truncated = (Array.isArray(value) && value.length > 16) || (typeof value === 'string' && value.length > 128);
    const raw = Array.isArray(value)
        ? value
              .slice(0, 16)
              .map((v) => (typeof v === 'number' || typeof v === 'string' ? String(v).slice(0, 8) : '?'))
              .join(',')
        : typeof value === 'number' || typeof value === 'string'
          ? String(value)
          : '';
    const tokens = raw
        .slice(0, 128)
        .split(/([,/])/)
        .slice(0, 31);
    const codes: number[] = [];
    let label = '',
        abbreviation = '',
        unknown = truncated,
        separator = '';
    for (const token of tokens) {
        if (token === ',' || token === '/') {
            separator = token;
            continue;
        }
        if (!token.trim()) continue;
        const code = /^\d{1,3}$/.test(token.trim()) ? Number(token) : NaN;
        const material = dictionary[code];
        unknown ||= !material;
        if (Number.isInteger(code)) codes.push(code);
        if (label) {
            label += separator === '/' ? ' over ' : ' / ';
            abbreviation += separator === '/' ? '/' : ' ';
        }
        label += material?.[0] ?? 'Unknown';
        abbreviation += material?.[1] ?? '?';
    }
    return {
        codes,
        label,
        abbreviation,
        unknown: unknown || !label,
        tint: dictionary[codes[0]]?.[2] ?? '#8a8a5a',
        poor: vegetation || codes.some((code) => [5, 8, 9, 11, 14, 18].includes(code)),
    };
}
export function seabedNature(value: unknown) {
    return decodeNature(value, NATURE);
}
/** CATWED belongs to WEDKLP, never to the NATSUR code list. These are
 * plain-language vegetation labels, separate from S-52 bottom abbreviations. */
export function chartBottomNature(properties: Record<string, unknown>) {
    return properties._caution === 'WEDKLP' || properties.acronym === 'WEDKLP'
        ? decodeNature(properties.CATWED ?? properties.catwed, VEGETATION, true)
        : seabedNature(properties.NATSUR ?? properties.natsur);
}

/** Bounded, in-memory advisory only. Never fetches, stores, logs, grades or
 * excludes an anchorage. Point samples apply within 25 m and say so explicitly;
 * they do not become a polygon or an inferred seabed survey. */
export function holdingGroundAt(lat: number, lon: number, features: readonly Feature<Geometry>[]) {
    const none = { kind: 'unknown' as const, text: 'Holding ground unknown here.', pointSample: false };
    if (![lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || features.length > 8192)
        return none;
    const matches: ReturnType<typeof seabedNature>[] = [];
    let pointSample = false,
        vertices = 0,
        rings = 0;
    for (const feature of features) {
        const p = feature?.properties;
        if (!p || p._reference || !['SBDARE', 'WEDKLP'].includes(String(p._caution ?? p.acronym))) continue;
        const g = feature.geometry;
        if (!g) continue;
        let contains = false;
        if (g.type === 'Point' && g.coordinates.length >= 2) {
            contains = haversineM(lat, lon, g.coordinates[1], g.coordinates[0]) <= 25;
            if (contains) pointSample = true;
        } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
            // Unwrap around the query, refusing ambiguous >180° rings rather
            // than assigning a dateline polygon to the rest of the world.
            const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
            for (const poly of polygons) {
                if (++rings > 8192) return none;
                for (const r of poly) {
                    if (++rings > 8192 || (vertices += r.length) > 32768) return none;
                }
            }
            let ambiguous = false;
            const ring = (r: Position[]) => {
                const out = r.map((c) => [lon + ((c[0] - lon + 540) % 360) - 180, c[1]]);
                if (out.length && Math.max(...out.map((c) => c[0])) - Math.min(...out.map((c) => c[0])) > 180)
                    ambiguous = true;
                if (out.some((c) => !c.every(Number.isFinite))) ambiguous = true;
                return out;
            };
            const shifted =
                g.type === 'Polygon'
                    ? { ...g, coordinates: g.coordinates.map(ring) }
                    : { ...g, coordinates: g.coordinates.map((poly) => poly.map(ring)) };
            if (!ambiguous) contains = pointInGeometry(lon, lat, shifted);
        }
        if (contains) matches.push(chartBottomNature(p));
    }
    if (!matches.length) return none;
    const labels = [...new Set(matches.map((m) => m.label || 'Unknown'))];
    const label = labels.length > 3 ? 'mixed bottom types' : labels.join(' / ');
    const poor = matches.some((m) => m.poor);
    const uncertain = matches.some((m) => m.unknown) || matches.length > 1;
    return {
        kind: poor ? ('poor' as const) : ('charted' as const),
        pointSample,
        text: `${pointSample ? 'Nearby chart sample' : 'Bottom charted'} as ${label.toLowerCase()}: ${poor ? 'holding may be poor; check' : 'check the actual holding'}${uncertain ? ' (mixed or incomplete chart information)' : ''}.`,
    };
}
