/**
 * Final-route safety audits that operate on the source vector geometry.
 *
 * The navigation grid deliberately has a handful of tightly scoped rescue
 * mechanisms for chart-alignment errors around marina entrances. Those
 * mechanisms must never turn a sustained run across charted land into a
 * route. Sampling the emitted polyline against the original vectors gives us
 * an independent engine-boundary veto after every grid carve and splice.
 */
import type { FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';
import type { InshoreLayers } from './types';
import { geometryBbox, haversineM, pointInGeometry } from './geometry';

type AreaGeometry = Polygon | MultiPolygon;

interface IndexedArea {
    geometry: AreaGeometry;
    bbox: [number, number, number, number];
}

interface IndexedLine {
    coordinates: Position[];
    bbox: [number, number, number, number];
}

export interface HardLandAudit {
    maxRunM: number;
    totalM: number;
    sampledIntervals: number;
    maxRunStart?: [number, number];
    maxRunEnd?: [number, number];
}

/** A longer exact-LNDARE run is not a marina-mouth alignment error. */
export const MAX_UNVOUCHED_HARD_LAND_RUN_M = 500;

function indexAreas(collections: Array<FeatureCollection | undefined>): IndexedArea[] {
    const indexed: IndexedArea[] = [];
    for (const collection of collections) {
        for (const feature of collection?.features ?? []) {
            const geometry = feature.geometry;
            if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
            indexed.push({ geometry, bbox: geometryBbox(geometry) });
        }
    }
    return indexed;
}

function pointInIndexedAreas(lon: number, lat: number, areas: readonly IndexedArea[]): boolean {
    for (const area of areas) {
        const [minLon, minLat, maxLon, maxLat] = area.bbox;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        if (pointInGeometry(lon, lat, area.geometry)) return true;
    }
    return false;
}

function indexLines(collections: Array<FeatureCollection | undefined>): IndexedLine[] {
    const indexed: IndexedLine[] = [];
    for (const collection of collections) {
        for (const feature of collection?.features ?? []) {
            const geometry = feature.geometry;
            if (!geometry || (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString')) continue;
            const lines =
                geometry.type === 'LineString'
                    ? [(geometry as LineString).coordinates]
                    : (geometry as MultiLineString).coordinates;
            for (const coordinates of lines) {
                if (coordinates.length < 2) continue;
                let minLon = Infinity;
                let minLat = Infinity;
                let maxLon = -Infinity;
                let maxLat = -Infinity;
                for (const [lon, lat] of coordinates) {
                    minLon = Math.min(minLon, lon);
                    minLat = Math.min(minLat, lat);
                    maxLon = Math.max(maxLon, lon);
                    maxLat = Math.max(maxLat, lat);
                }
                indexed.push({ coordinates, bbox: [minLon, minLat, maxLon, maxLat] });
            }
        }
    }
    return indexed;
}

function pointToSegmentM(lon: number, lat: number, a: Position, b: Position): number {
    const refLat = ((lat + a[1] + b[1]) / 3) * (Math.PI / 180);
    const mx = 111_320 * Math.cos(refLat);
    const my = 111_320;
    const px = lon * mx;
    const py = lat * my;
    const ax = a[0] * mx;
    const ay = a[1] * my;
    const bx = b[0] * mx;
    const by = b[1] * my;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointNearVouchedLine(lon: number, lat: number, lines: readonly IndexedLine[], corridorM = 125): boolean {
    const dLat = corridorM / 111_320;
    const dLon = corridorM / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    for (const line of lines) {
        const [minLon, minLat, maxLon, maxLat] = line.bbox;
        if (lon < minLon - dLon || lon > maxLon + dLon || lat < minLat - dLat || lat > maxLat + dLat) continue;
        for (let i = 1; i < line.coordinates.length; i++) {
            if (pointToSegmentM(lon, lat, line.coordinates[i - 1], line.coordinates[i]) <= corridorM) return true;
        }
    }
    return false;
}

/**
 * Measure continuous emitted-route runs that sit inside charted LNDARE without
 * any overlapping polygonal water evidence. DEPARE/DRGARE/FAIRWY overlap means
 * the source layers disagree, so the point is caution-worthy but not
 * unambiguously land. Everything else is an exact hard-land hit.
 */
export function auditUnvouchedHardLand(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    sampleStepM = 25,
): HardLandAudit {
    const land = indexAreas([layers.LNDARE]);
    if (land.length === 0 || polyline.length < 2) {
        return { maxRunM: 0, totalM: 0, sampledIntervals: 0 };
    }
    const wet = indexAreas([layers.DEPARE, layers.DRGARE, layers.FAIRWY]);
    // These line layers are explicit navigation evidence. The grid carves or
    // prefers a narrow corridor around them, so the independent vector audit
    // must honour the same physical-water claim without treating all relaxed
    // land nearby as water.
    const wetLines = indexLines([layers.CANAL, layers.NAVLINE, layers.RECTRC, layers.NTMBAR]);
    const stepM = Math.max(5, sampleStepM);
    let runM = 0;
    let maxRunM = 0;
    let totalM = 0;
    let sampledIntervals = 0;
    let runStart: [number, number] | undefined;
    let maxRunStart: [number, number] | undefined;
    let maxRunEnd: [number, number] | undefined;

    for (let i = 1; i < polyline.length; i++) {
        const [lonA, latA] = polyline[i - 1];
        const [lonB, latB] = polyline[i];
        const segmentM = haversineM(latA, lonA, latB, lonB);
        const intervals = Math.max(1, Math.ceil(segmentM / stepM));
        const intervalM = segmentM / intervals;
        for (let s = 0; s < intervals; s++) {
            // Midpoint sampling measures each complete interval and avoids
            // double-counting shared vertices across adjacent segments.
            const t = (s + 0.5) / intervals;
            const lon = lonA + (lonB - lonA) * t;
            const lat = latA + (latB - latA) * t;
            const hardLand =
                pointInIndexedAreas(lon, lat, land) &&
                !pointInIndexedAreas(lon, lat, wet) &&
                !pointNearVouchedLine(lon, lat, wetLines);
            sampledIntervals++;
            if (hardLand) {
                runStart ??= [lon, lat];
                runM += intervalM;
                totalM += intervalM;
                if (runM > maxRunM) {
                    maxRunM = runM;
                    maxRunStart = runStart;
                    maxRunEnd = [lon, lat];
                }
            } else {
                runM = 0;
                runStart = undefined;
            }
        }
    }

    return { maxRunM, totalM, sampledIntervals, maxRunStart, maxRunEnd };
}
