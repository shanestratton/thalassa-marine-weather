/** Display lookup only. No chart geometry, routing authority, storage or I/O
 * escapes the builder: its result contains bounded names and display points. */
import type { Geometry, Position } from 'geojson';
import { buildLightCharacterLabel, readS57, type EncConversionResult } from './types';

export const CHART_FIND_CELL_OBJECTS = 512;
export const CHART_FIND_CELL_BYTES = 128 * 1024;
export const CHART_FIND_SCAN_FEATURES = 50000;
const VERTICES = 2048;
export type ChartObjectKind = 'light' | 'mark' | 'place';
export interface ChartObject {
    readonly key: string;
    readonly cellId: string;
    readonly name: string;
    readonly kind: ChartObjectKind;
    readonly character: string | null;
    readonly lat: number;
    readonly lon: number;
    readonly search: string;
}
export interface ChartObjectIndex {
    readonly objects: readonly ChartObject[];
    readonly bytes: number;
    readonly limited: boolean;
}

/** Dots/spaces in Fl.G 3s are typography. Decimal zeroes are canonicalised
 * before punctuation is removed, so Fl.G3.0s and Fl G 3 s agree as well. */
export function normaliseChartQuery(value: string): string {
    return value
        .slice(0, 256)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/(\d+)\.0+(?=\D|$)/g, '$1')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

const MARKS: Readonly<Record<string, string>> = {
    BOYLAT: 'Lateral buoy',
    BCNLAT: 'Lateral beacon',
    BOYCAR: 'Cardinal buoy',
    BCNCAR: 'Cardinal beacon',
    BOYSPP: 'Special-purpose buoy',
    BCNSPP: 'Special-purpose beacon',
    BOYSAW: 'Safe-water buoy',
    BCNSAW: 'Safe-water beacon',
    BOYISD: 'Isolated-danger buoy',
    BCNISD: 'Isolated-danger beacon',
    BOYINB: 'Installation buoy',
    DAYMAR: 'Daymark',
};
const LIGHTS = new Set(['LIGHTS', 'LITFLT', 'LITVES']);
function clean(value: unknown): string {
    return typeof value === 'string'
        ? value
              .replace(/[\p{Cc}\p{Cf}]/gu, '')
              .trim()
              .slice(0, 96)
        : '';
}
function valid(point: Position | undefined): point is Position {
    return (
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]) &&
        point[0] >= -180 &&
        point[0] <= 180 &&
        point[1] >= -90 &&
        point[1] <= 90
    );
}
/** A label location, never an inside-water or navigable point claim. The
 * largest bounded outer ring uses an unwrapped vertex mean at the dateline. */
export function chartObjectPoint(geometry: Geometry | null): [number, number] | null {
    if (
        !geometry ||
        typeof geometry !== 'object' ||
        !('coordinates' in geometry) ||
        !Array.isArray(geometry.coordinates)
    )
        return null;
    if (geometry.type === 'Point')
        return valid(geometry.coordinates) ? [geometry.coordinates[0], geometry.coordinates[1]] : null;
    if (geometry.type === 'MultiPoint') {
        for (const point of geometry.coordinates.slice(0, VERTICES)) if (valid(point)) return [point[0], point[1]];
        return null;
    }
    let rings: Position[][];
    if (geometry.type === 'Polygon') rings = geometry.coordinates.slice(0, 1);
    else if (geometry.type === 'MultiPolygon') {
        if (geometry.coordinates.length > VERTICES) return null;
        rings = geometry.coordinates
            .filter(Array.isArray)
            .map((polygon) => polygon[0])
            .filter(Array.isArray);
    } else if (geometry.type === 'LineString') rings = [geometry.coordinates];
    else if (geometry.type === 'MultiLineString') {
        if (geometry.coordinates.length > VERTICES) return null;
        rings = geometry.coordinates;
    } else return null;
    let ring: Position[] | null = null;
    for (const candidate of rings)
        if (Array.isArray(candidate) && (!ring || candidate.length > ring.length)) ring = candidate;
    if (!ring || !ring.length || ring.length > VERTICES) return null;
    const last = ring.at(-1)!;
    if (!valid(ring[0]) || !valid(last)) return null;
    const count = ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1] ? ring.length - 1 : ring.length;
    let x = 0,
        y = 0,
        min = Infinity,
        max = -Infinity;
    for (let i = 0; i < count; i++) {
        const point = ring[i];
        if (!valid(point)) return null;
        const lon = point[0] + 360 * Math.round((ring[0][0] - point[0]) / 360);
        min = Math.min(min, lon);
        max = Math.max(max, lon);
        if (max - min > 180) return null;
        x += lon;
        y += point[1];
    }
    return [((((x / count + 180) % 360) + 360) % 360) - 180, y / count];
}

export function buildChartObjectIndex(blob: EncConversionResult): ChartObjectIndex {
    if (!blob?.layers || typeof blob.layers !== 'object' || Array.isArray(blob.layers))
        return { objects: [], bytes: 0, limited: true };
    const objects: ChartObject[] = [];
    let bytes = 0,
        scanned = 0,
        limited = false;
    let layerCount = 0;
    outer: for (const rawLayer in blob.layers) {
        if (!Object.hasOwn(blob.layers, rawLayer)) continue;
        if (++layerCount > 128) {
            limited = true;
            break;
        }
        if (rawLayer.length > 32) {
            limited = true;
            continue;
        }
        const collection = blob.layers[rawLayer as keyof typeof blob.layers];
        if (!Array.isArray(collection?.features)) {
            limited = true;
            continue;
        }
        const layer = rawLayer.toUpperCase();
        const kind: ChartObjectKind = LIGHTS.has(layer) ? 'light' : MARKS[layer] ? 'mark' : 'place';
        for (let index = 0; index < (collection?.features.length ?? 0); index++) {
            if (++scanned > CHART_FIND_SCAN_FEATURES) {
                limited = true;
                break outer;
            }
            const feature = collection!.features[index];
            if (!feature || typeof feature !== 'object') {
                limited = true;
                continue;
            }
            const properties =
                feature.properties && typeof feature.properties === 'object' && !Array.isArray(feature.properties)
                    ? feature.properties
                    : {};
            const rawName = clean(readS57(properties, 'OBJNAM'));
            if (kind === 'place' && !rawName) continue;
            const point = chartObjectPoint(feature.geometry);
            if (!point) {
                if (rawName || kind !== 'place') limited = true;
                continue;
            }
            let character: string | null = null;
            try {
                if (kind !== 'place') character = buildLightCharacterLabel(properties)?.slice(0, 96) ?? null;
            } catch {
                limited = true;
            }
            const name = rawName || (kind === 'light' ? 'Unnamed light' : MARKS[layer]);
            const key = `${blob.cellId}:${layer}:${index}`;
            const search = normaliseChartQuery(`${name} ${character ?? ''} ${MARKS[layer] ?? kind}`);
            const weight = 128 + 2 * (name.length + key.length + search.length + (character?.length ?? 0));
            if (objects.length >= CHART_FIND_CELL_OBJECTS || bytes + weight > CHART_FIND_CELL_BYTES) {
                limited = true;
                break outer;
            }
            objects.push(
                Object.freeze({
                    key,
                    cellId: blob.cellId,
                    name,
                    kind,
                    character,
                    lon: point[0],
                    lat: point[1],
                    search,
                }),
            );
            bytes += weight;
        }
    }
    return Object.freeze({ objects: Object.freeze(objects), bytes, limited });
}
