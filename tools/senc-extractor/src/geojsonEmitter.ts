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

/**
 * Shape consumed by the Thalassa iOS app (services/enc/types.ts:EncConversionResult).
 * Kept here as a structural duplicate so this CLI doesn't pull in the whole app
 * type tree just for the emitter target. If `services/enc/types.ts` evolves,
 * mirror the change here.
 */
export interface CellOutput {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    layers: Record<string, FeatureCollection>;
    /** Extra metadata — not in the canonical EncConversionResult but harmless on the app side. */
    cellName?: string;
    nativeScale?: number;
    sencCreateDate?: string;
    stats?: { totalFeatures: number; emittedFeatures: number; classes: Record<string, number> };
}

export interface EmitOptions {
    /** S-57 acronyms to include. Default: ROUTING_CLASSES. Pass "all" to include every class found. */
    classes?: Set<string> | 'all';
    /** Filename-derived cell id for the output (e.g. "US5GA22M"). */
    cellId: string;
    /** Hydrographic-office code (e.g. "AU", "US"). Default "??" if unknown. */
    sourceHO?: string;
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

    // Canonical fields the iOS app needs.
    const bbox: [number, number, number, number] = header.cellExtent
        ? [header.cellExtent.wLon, header.cellExtent.sLat, header.cellExtent.eLon, header.cellExtent.nLat]
        : [0, 0, 0, 0];
    const issuedIso = isoDateFromCompact(header.publishDate ?? header.updateDate);

    return {
        cellId: opts.cellId,
        sourceHO: opts.sourceHO ?? '??',
        edition: header.cellEdition ?? 0,
        issued: issuedIso,
        bbox,
        layers,
        cellName: header.cellName,
        nativeScale: header.nativeScale,
        sencCreateDate: header.sencCreateDate,
        stats: {
            totalFeatures: features.length,
            emittedFeatures,
            classes: classCounts,
        },
    };
}

/** SENC headers store dates as `YYYYMMDD`; emit ISO `YYYY-MM-DD` for the app. */
function isoDateFromCompact(compact: string | undefined): string {
    if (!compact || compact.length < 8) return '';
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
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
            // S-57 convention: first ring is the outer boundary; subsequent rings
            // are holes. GeoJSON Polygon expects the same.
            const rings = f.geometry.rings.map((ring) => ring.map(roundPt));
            if (rings.length === 0 || rings[0].length < 4) return null;
            return {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: rings },
                properties,
            };
        }

        case 'AreaRaw':
            // Should have been resolved during the second pass; if we get here the
            // vector tables were missing or malformed for this chart.
            return null;

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
