import { HeaderInfo, SencFeature } from './featureParser.js';
import { ROUTING_CLASSES } from './s57Classes.js';

/**
 * Round lat/lon to 6 decimal places (~10 cm precision). 15-digit IEEE-754 output
 * triples GeoJSON size with no positional benefit for marine routing.
 */
const COORD_PRECISION = 1e6;
function round6(v: number): number {
    return Math.round(v * COORD_PRECISION) / COORD_PRECISION;
}
function roundPt(p: [number, number]): [number, number] {
    return [round6(p[0]), round6(p[1])];
}

/** GeoJSON feature shape (kept simple — matches what the inshore router expects via the `geojson` types). */
interface GeoJsonFeature {
    type: 'Feature';
    geometry:
        | { type: 'Point'; coordinates: [number, number] }
        | { type: 'MultiPoint'; coordinates: [number, number][] }
        | { type: 'LineString'; coordinates: [number, number][] }
        | { type: 'Polygon'; coordinates: [number, number][][] }
        | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
        | null;
    properties: Record<string, unknown>;
}

interface FeatureCollection {
    type: 'FeatureCollection';
    features: GeoJsonFeature[];
}

export interface CellOutput {
    cellId: string;
    cellName?: string;
    publishDate?: string;
    cellEdition?: number;
    updateDate?: string;
    nativeScale?: number;
    sencCreateDate?: string;
    extent?: HeaderInfo['cellExtent'];
    layers: Record<string, FeatureCollection>;
    /** Counts before per-class filtering (diagnostic). */
    stats?: { totalFeatures: number; emittedFeatures: number; classes: Record<string, number> };
}

export interface EmitOptions {
    /** S-57 acronyms to include. Default: ROUTING_CLASSES. Pass "all" to include every class found. */
    classes?: Set<string> | 'all';
    /** Filename-derived cell id for the output (e.g. "US5GA22M"). */
    cellId: string;
}

export function emitCell(header: HeaderInfo, features: SencFeature[], opts: EmitOptions): CellOutput {
    const wanted = opts.classes === 'all' ? null : (opts.classes ?? ROUTING_CLASSES);

    const layers: Record<string, FeatureCollection> = {};
    const classCounts: Record<string, number> = {};
    let emittedFeatures = 0;

    for (const f of features) {
        classCounts[f.acronym] = (classCounts[f.acronym] ?? 0) + 1;
        if (wanted && !wanted.has(f.acronym)) continue;

        const gj = featureToGeoJson(f);
        if (!gj) continue;

        if (!layers[f.acronym]) {
            layers[f.acronym] = { type: 'FeatureCollection', features: [] };
        }
        layers[f.acronym].features.push(gj);
        emittedFeatures += 1;
    }

    return {
        cellId: opts.cellId,
        cellName: header.cellName,
        publishDate: header.publishDate,
        cellEdition: header.cellEdition,
        updateDate: header.updateDate,
        nativeScale: header.nativeScale,
        sencCreateDate: header.sencCreateDate,
        extent: header.cellExtent,
        layers,
        stats: {
            totalFeatures: features.length,
            emittedFeatures,
            classes: classCounts,
        },
    };
}

function featureToGeoJson(f: SencFeature): GeoJsonFeature | null {
    const properties: Record<string, unknown> = {
        classCode: f.classCode,
        acronym: f.acronym,
        rcid: f.rcid,
        ...f.attributes,
    };

    if (!f.geometry) return null;

    switch (f.geometry.type) {
        case 'Point':
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: roundPt(f.geometry.coordinates) },
                properties,
            };

        case 'MultiPoint': {
            const coordinates: [number, number][] = f.geometry.coordinates.map((c) => roundPt([c[0], c[1]]));
            const depths = f.geometry.coordinates.map((c) => Math.round(c[2] * 10) / 10);
            return {
                type: 'Feature',
                geometry: { type: 'MultiPoint', coordinates },
                properties: { ...properties, depths },
            };
        }

        case 'Area': {
            const polys: [number, number][][][] = f.geometry.triangles.map((tri) => [
                [roundPt(tri[0]), roundPt(tri[1]), roundPt(tri[2]), roundPt(tri[0])],
            ]);
            if (polys.length === 0) return null;
            return {
                type: 'Feature',
                geometry: { type: 'MultiPolygon', coordinates: polys },
                properties,
            };
        }

        case 'Line': {
            const coords = f.geometry.coordinates.map(roundPt);
            if (coords.length < 2) return null;
            return {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties,
            };
        }

        case 'LineRaw':
            // Should have been resolved during the second pass; if we get here the
            // vector tables were missing or malformed for this chart.
            return null;
    }
}
