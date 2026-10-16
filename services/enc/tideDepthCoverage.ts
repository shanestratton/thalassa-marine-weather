/** Exact bounded original-area union. No hull, buffering, sampled coverage or
 * fallback geometry can fill a chart gap. Main-thread RAM only. */
import { union, diff } from 'martinez-polygon-clipping';
import type { Geometry as ClipGeometry } from 'martinez-polygon-clipping';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { holdingGeometryRelation, type HoldingBounds } from './holdingFootprint';
import { martinezAdmissionWork, GLAZE_MARTINEZ_WORK_CAP } from './clipDepareOverlap';
import { bboxBuckets, geometryBbox } from '../engine/geometry';

export interface TideDepthCoverage {
    geometry: Polygon | MultiPolygon;
    minimumPositiveM: number;
    minimumAt: (bounds: HoldingBounds) => number | null;
}
const coordinates = (g: Polygon | MultiPolygon): ClipGeometry => structuredClone(g.coordinates) as ClipGeometry;
const count = (g: Polygon | MultiPolygon) =>
    (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).reduce(
        (n, p) => n + p.reduce((m, ring) => m + ring.length, 0),
        0,
    );
function normalize(out: ClipGeometry | null): Polygon | MultiPolygon | null {
    if (!out?.length) return null;
    return typeof out[0]?.[0]?.[0] === 'number'
        ? { type: 'Polygon', coordinates: out as Polygon['coordinates'] }
        : { type: 'MultiPolygon', coordinates: out as MultiPolygon['coordinates'] };
}
export function buildTideDepthCoverage(
    features: readonly Feature[],
    bounds: HoldingBounds,
    check: () => void,
): TideDepthCoverage | null {
    const areas: Array<{ geometry: Polygon | MultiPolygon; depth: number; bbox: HoldingBounds }> = [];
    let inputVertices = 0,
        work = 0,
        comparisons = 0;
    const compare = () => {
        if (++comparisons > 500000) throw Error('Original tide depth topology exceeds its comparison bound.');
    };
    for (const f of features) {
        check();
        if (!f?.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type))
            throw Error('An original depth area is incomplete.');
        const geometry = f.geometry as Polygon | MultiPolygon;
        const relation = holdingGeometryRelation(
            geometry,
            bounds,
            () => {
                if (++inputVertices > 65536) throw Error('Original tide depth geometry exceeds its vertex bound.');
            },
            compare,
        );
        if (!relation.intersects) continue;
        const depth = f.properties?.DRVAL1 ?? f.properties?.drval1;
        if (typeof depth !== 'number' || !Number.isFinite(depth)) throw Error('An original depth minimum is unknown.');
        if (areas.length >= 32) throw Error('Exact tide depth coverage exceeds 32 original polygons.');
        areas.push({ geometry, depth, bbox: geometryBbox(geometry) });
    }
    let geometry: Polygon | MultiPolygon | null = null;
    const operate = (a: Polygon | MultiPolygon, b: Polygon | MultiPolygon, subtract: boolean) => {
        const vertices = count(a) + count(b),
            cost = martinezAdmissionWork(vertices);
        // Reuse the existing pre-allocation work ceiling. Measuring an output
        // after a boolean operation cannot protect against an earlier OOM.
        if (vertices > 512 || cost > GLAZE_MARTINEZ_WORK_CAP || work + cost > GLAZE_MARTINEZ_WORK_CAP)
            throw Error('Exact tide depth coverage exceeds the existing clipping work bound.');
        work += cost;
        check();
        const result = normalize((subtract ? diff : union)(coordinates(a), coordinates(b)));
        check();
        if (result && count(result) > 512) throw Error('Exact tide depth coverage exceeds 512 output vertices.');
        if (result) holdingGeometryRelation(result, bounds, () => {}, compare);
        return result;
    };
    const positive = areas.filter((a) => a.depth > 0);
    if (!positive.length) return null;
    for (const area of positive) {
        if (count(area.geometry) > 512) throw Error('Exact tide depth coverage exceeds 512 original vertices.');
        geometry = geometry ? operate(geometry, area.geometry, false) : structuredClone(area.geometry);
    }
    for (const area of areas.filter((a) => a.depth <= 0)) {
        if (!geometry) return null;
        geometry = operate(geometry, area.geometry, true);
    }
    if (!geometry) return null;
    const query = bboxBuckets(areas, (a) => a.bbox);
    let queryVertices = 0,
        queryChecks = 0;
    return {
        geometry,
        minimumPositiveM: Math.min(...positive.map((a) => a.depth)),
        minimumAt: (box) => {
            let minimum = Infinity;
            const tick = () => {
                if (++queryChecks > 500000) throw Error('Original cell-depth proof exceeds its comparison bound.');
            };
            for (const area of query(box)) {
                check();
                if (
                    holdingGeometryRelation(
                        area.geometry,
                        box,
                        () => {
                            if (++queryVertices > 262144)
                                throw Error('Original cell-depth proof exceeds its vertex bound.');
                        },
                        tick,
                    ).intersects
                )
                    minimum = Math.min(minimum, area.depth);
            }
            return Number.isFinite(minimum) ? minimum : null;
        },
    };
}
