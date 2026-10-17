/** Negative route constraints only. Compiled chart geometry stays in RAM;
 * no area supplies water, a depth, clearance, permission or a preferred lane. */
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { normalizeOverlay } from '../userOverlays/model';
import { restrnCodes } from '../enc/s57Restrn';
import {
    rasterizePolygonBoundaryCells,
    geometryBbox,
    mPerDegLon,
    rasterizePolygonCells,
    segmentGeometryDistanceM,
} from './geometry';
import type { InshoreLayers, NavGrid } from './types';
import {
    buildTrafficLaneField,
    trafficLaneGridFields,
    auditTrafficLaneRoute,
    type TrafficLaneField,
    type TrafficLaneGuidance,
} from './trafficLanes';

export type ExclusionKind =
    | 'entry-prohibited'
    | 'entry-restricted'
    | 'traffic-separation'
    | 'manual-no-go'
    | 'marine-park'
    | 'traffic-lane';
interface ExclusionArea {
    readonly kind: ExclusionKind;
    readonly geometry: Polygon | MultiPolygon;
    readonly bbox: readonly [number, number, number, number];
    readonly vertices: number;
}
export interface ExclusionField {
    readonly areas: readonly ExclusionArea[];
    readonly trafficLanes?: TrafficLaneField;
}
export interface ExclusionSources {
    RESARE?: FeatureCollection;
    TSEZNE?: FeatureCollection;
    TSSLPT?: FeatureCollection;
    /** Caller supplies explicitly enabled private polygon files only. */
    manual?: FeatureCollection;
    /** Indicative park footprints add caution cost; they do not prohibit transit. */
    marineParks?: FeatureCollection;
}
const MAX_SCAN = 16000,
    MAX_AREAS = 2000,
    MAX_OPERATIONS = 8_000_000;
const polygons = (g: Polygon | MultiPolygon): Position[][][] =>
    g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
const overlaps = (a: readonly number[], b: readonly number[]) =>
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/** Preserve the worker host's existing narrow retry classification. This is
 * only a compute failure; it supplies no route or exclusion admission. */
export const isRouteStackOverflow = (error: unknown): error is RangeError =>
    error instanceof RangeError && /stack/i.test(error.message);

export const exclusionCostFactor = (grid: NavGrid, index: number): number =>
    grid.exclusionCaution?.[index] === 1 ? 1.25 : 1;

/** Apply to a freshly built/cached base grid before any endpoint or component
 * rescue. Every mutable route array and mask is private; the cache is read only. */
export function applyExclusionField(base: NavGrid, field: ExclusionField, check: () => void = () => {}): NavGrid {
    const masks = rasterExclusionField(base, field, check);
    const grid: NavGrid = {
        ...base,
        cells: base.cells.slice(),
        preferred: base.preferred.slice(),
        exclusionBlocked: masks?.blocked,
        exclusionCaution: masks?.caution,
        ...trafficLaneGridFields(base, field.trafficLanes, check),
    };
    if (masks)
        for (let i = 0; i < masks.blocked.length; i++) {
            if ((i & 1023) === 0) check();
            if (masks.blocked[i] === 1) grid.cells[i] = NaN;
        }
    check();
    return grid;
}

export function exclusionRefusal(kind: ExclusionKind): string {
    if (kind === 'traffic-lane')
        return 'The planned route would oppose charted traffic-lane flow or cross obliquely. Review the lane and route before proceeding.';
    if (kind === 'manual-no-go')
        return 'The route would cross one of your no-go polygons. Move the route outside it or edit that polygon.';
    if (kind === 'traffic-separation')
        return 'The route would enter a traffic separation zone. This planner keeps separation zones closed.';
    return kind === 'entry-prohibited'
        ? 'The route would enter an area marked entry prohibited. Move the route outside that area.'
        : 'The route would enter a restricted area. This planner keeps entry-restricted areas closed.';
}

/** Audit the actual emitted line after cloud/shadow/lead/tail splices. No IO,
 * chart permission, positive depth or persistent authority is supplied here. */
export function auditFinishedRouteExclusions(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    check: () => void = () => {},
): { error: string; code: 'route-exclusion' | 'exclusion-unavailable' } | null {
    try {
        check();
        const field = buildExclusionField({
            RESARE: layers.RESARE,
            TSEZNE: layers.TSEZNE,
            TSSLPT: layers.TSSLPT,
            manual: layers.USER_NOGO,
            marineParks: layers.MPA_CAUTION,
        });
        const conflict = routeExclusionConflict(polyline, field, check);
        return conflict ? { error: exclusionRefusal(conflict), code: 'route-exclusion' } : null;
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (isRouteStackOverflow(error)) throw error;
        return {
            error: 'The finished route’s area restrictions could not be fully checked. Review the current chart and route again.',
            code: 'exclusion-unavailable',
        };
    }
}

/** Shared success disclosure after the final source audit, including promoted/reshaped lines. */
export function finishedTrafficLaneGuidance(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    check: () => void = () => {},
): TrafficLaneGuidance | undefined {
    const audit = auditTrafficLaneRoute(polyline, buildTrafficLaneField(layers.TSSLPT), check);
    if (audit.conflict) throw Error(exclusionRefusal('traffic-lane'));
    return audit.guidance;
}

/** Take a bounded independent geometry snapshot before routing. Malformed hard
 * constraints are refused, never silently dropped or reinterpreted as a line. */
export function buildExclusionField(sources: ExclusionSources): ExclusionField {
    const trafficLanes = buildTrafficLaneField(sources.TSSLPT);
    const selected: Feature[] = [],
        kinds: ExclusionKind[] = [];
    let scanned = 0;
    const add = (collection: FeatureCollection | undefined, kind: ExclusionKind | null) => {
        if (!collection) return;
        if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features))
            throw Error('Route exclusion source is malformed.');
        for (const feature of collection.features) {
            if (++scanned > MAX_SCAN) throw Error('Route exclusion source exceeds the object budget.');
            let actual = kind;
            if (actual === null) {
                const codes = restrnCodes(feature?.properties?.RESTRN ?? feature?.properties?.restrn);
                actual = codes.includes('7') ? 'entry-prohibited' : codes.includes('8') ? 'entry-restricted' : null;
            }
            if (actual === null) continue;
            if (!feature?.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
                throw Error('A route exclusion has no complete polygon.');
            if (selected.length >= MAX_AREAS) throw Error('Too many route exclusion polygons.');
            // Original chart labels/identifiers are neither needed nor copied.
            selected.push({ type: 'Feature', properties: {}, geometry: feature.geometry });
            kinds.push(actual);
        }
    };
    add(sources.RESARE, null);
    add(sources.TSEZNE, 'traffic-separation');
    add(sources.manual, 'manual-no-go');
    add(sources.marineParks, 'marine-park');
    if (!selected.length) return { areas: [], ...(trafficLanes ? { trafficLanes } : {}) };
    // Reuse the bounded topology/WGS84 validator; no user-overlay store is read.
    const normalized = normalizeOverlay({ type: 'FeatureCollection', features: selected });
    if (normalized.data.features.length !== kinds.length) throw Error('Route exclusion geometry changed shape.');
    const areas = normalized.data.features.map((feature, i): ExclusionArea => {
        const geometry = feature.geometry as Polygon | MultiPolygon;
        let vertices = 0;
        for (const polygon of polygons(geometry))
            for (const ring of polygon)
                for (let j = 0; j < ring.length; j++) {
                    vertices++;
                    if (j && Math.abs(ring[j][0] - ring[j - 1][0]) > 180)
                        throw Error('Split route exclusions at the dateline before routing.');
                }
        return { kind: kinds[i], geometry, vertices, bbox: geometryBbox(geometry) };
    });
    return { areas, ...(trafficLanes ? { trafficLanes } : {}) };
}

/** Whole-cell interior plus boundary supercover, including tiny islands and
 * corner touches. Builds private masks atomically and never alters a cached grid. */
export function rasterExclusionField(
    grid: NavGrid,
    field: ExclusionField,
    check: () => void = () => {},
): { blocked: Uint8Array; caution: Uint8Array } | null {
    if (!field.areas.length) return null;
    const { width, height, minLon, minLat, dLon, dLat } = grid;
    if (
        ![width, height].every(Number.isSafeInteger) ||
        width <= 0 ||
        height <= 0 ||
        width * height > 2_500_000 ||
        ![minLon, minLat, dLon, dLat].every(Number.isFinite) ||
        dLon <= 0 ||
        dLat <= 0
    )
        throw Error('Route exclusion grid is invalid or oversized.');
    const box = [minLon, minLat, minLon + width * dLon, minLat + height * dLat];
    const blocked = new Uint8Array(width * height),
        caution = new Uint8Array(width * height);
    let operations = 0;
    const spend = (n = 1) => {
        operations += n;
        if (operations > MAX_OPERATIONS) throw Error('Route exclusions exceed the bounded grid review.');
        if ((operations & 1023) === 0) check();
    };
    for (const area of field.areas) {
        check();
        if (!overlaps(box, area.bbox)) continue;
        const mask = area.kind === 'marine-park' ? caution : blocked;
        const rows = Math.max(
            0,
            Math.min(height - 1, Math.ceil((area.bbox[3] - minLat) / dLat)) -
                Math.max(0, Math.floor((area.bbox[1] - minLat) / dLat)) +
                1,
        );
        spend(rows * area.vertices);
        rasterizePolygonCells(grid, area.geometry, (x, y) => {
            spend();
            mask[y * width + x] = 1;
        });
        rasterizePolygonBoundaryCells(
            grid,
            area.geometry,
            (x, y) => {
                mask[y * width + x] = 1;
            },
            spend,
        );
    }
    check();
    return { blocked, caution };
}

/** Audit the final complete line after every lead/tail/smoothing splice. A grid
 * mask alone cannot prove a thin polygon was avoided by the returned geometry. */
export function routeExclusionConflict(
    points: readonly (readonly [number, number])[],
    field: ExclusionField,
    check: () => void = () => {},
): ExclusionKind | null {
    if (!field.areas.length && !field.trafficLanes?.areas.length) return null;
    if (
        points.length < 2 ||
        points.length > 8192 ||
        points.some((p) => p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85)
    )
        throw Error('The complete route exclusion audit is unavailable for this geometry.');
    let operations = 0;
    for (let i = 1; i < points.length; i++) {
        check();
        const a = points[i - 1],
            b = points[i];
        if (Math.abs(a[0] - b[0]) > 180) throw Error('Split the route at the dateline before checking exclusions.');
        const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        for (const area of field.areas) {
            if (area.kind === 'marine-park' || !overlaps(box, area.bbox)) continue;
            operations += area.vertices * 3;
            if (operations > MAX_OPERATIONS) throw Error('The complete route exclusion audit exceeds its budget.');
            if (segmentGeometryDistanceM(a, b, area.geometry, mPerDegLon((a[1] + b[1]) / 2), 111320) <= 1e-6)
                return area.kind;
        }
    }
    check();
    return auditTrafficLaneRoute(points, field.trafficLanes, check).conflict ? 'traffic-lane' : null;
}
