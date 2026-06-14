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
    /**
     * Top-level GeoJSON feature id (the SENC rcid) so Mapbox/MapLibre
     * feature-state works without per-source promoteId plumbing. Unique
     * within a cell; cross-cell collisions are possible after merge.
     */
    id?: number;
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
    /** Vertical datum for soundings (SENC header) — required attribution once SOUNDG displays. */
    soundingDatum?: string;
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
        soundingDatum: header.soundingDatum,
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

/**
 * Convert S-57 SCAMIN (smallest display scale at which an object should be
 * shown) into a Mapbox-friendly minimum-zoom threshold.
 *
 * Scale denominator at zoom Z is 559082264 / 2^Z, so the condition
 *   denominator <= SCAMIN
 * solves for
 *   Z >= log2(559082264) - log2(SCAMIN)  ≈ 29.06 - log2(SCAMIN)
 *
 * Examples:
 *   SCAMIN=10000  (1:10k harbour-band)  → minZoom ≈ 15.8
 *   SCAMIN=89999  (1:90k general)       → minZoom ≈ 12.6
 *   SCAMIN=179999 (1:180k coastal)      → minZoom ≈ 11.6
 *   SCAMIN=899999 (1:900k overview)     → minZoom ≈ 9.3
 *
 * Returns 0 when SCAMIN is missing or non-positive — the feature is
 * always-visible. Layers can still apply their own coarser floor via Mapbox
 * `minzoom` on top of this per-feature threshold.
 */
function scaminToMinZoom(scamin: unknown): number {
    const n = typeof scamin === 'number' ? scamin : Number(scamin);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return 29.06 - Math.log2(n);
}

/**
 * S-57 list-typed attributes ship as comma-separated code strings
 * ('1,4', '2,6,2'). We keep the raw value (popups, verification) and ALSO
 * emit a parsed numeric array under `<ATTR>_LIST` so renderers (light
 * colours, COLPAT striping, sector arcs) never split strings inside Mapbox
 * expressions.
 */
const LIST_ATTRIBUTES = ['COLOUR', 'COLPAT', 'NATSUR'] as const;

function parseCodeList(v: unknown): number[] | null {
    if (typeof v === 'number') return Number.isFinite(v) ? [v] : null;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const codes = v.split(',').map((s) => Number(s.trim()));
    if (codes.some((n) => !Number.isFinite(n))) return null;
    return codes;
}

function featureToGeoJson(f: SencFeature): GeoJsonFeature | null {
    const properties: Record<string, unknown> = {
        classCode: f.classCode,
        acronym: f.acronym,
        rcid: f.rcid,
        ...f.attributes,
    };
    // Pre-bake the SCAMIN→minZoom conversion so Mapbox filters don't have to
    // compute log2 per render. Stored in _minZoom (leading underscore =
    // internal, derived from SCAMIN). Renderer falls back to 0 when missing.
    if (f.attributes.SCAMIN !== undefined) {
        properties._minZoom = Number(scaminToMinZoom(f.attributes.SCAMIN).toFixed(2));
    }
    // Normalised list attributes (COLOUR → COLOUR_LIST etc.) — see
    // LIST_ATTRIBUTES above.
    for (const attr of LIST_ATTRIBUTES) {
        const list = parseCodeList(f.attributes[attr]);
        if (list) properties[`${attr}_LIST`] = list;
    }

    if (!f.geometry) return null;

    switch (f.geometry.type) {
        case 'Point':
            return {
                type: 'Feature',
                id: f.rcid,
                geometry: { type: 'Point', coordinates: roundPt(f.geometry.coordinates) },
                properties,
            };

        case 'MultiPoint': {
            const coordinates: [number, number][] = f.geometry.coordinates.map((c) => roundPt([c[0], c[1]]));
            const depths = f.geometry.coordinates.map((c) => Math.round(c[2] * 10) / 10);
            return {
                type: 'Feature',
                id: f.rcid,
                geometry: { type: 'MultiPoint', coordinates },
                properties: { ...properties, depths },
            };
        }

        case 'Area': {
            // Prefer Eulerian-reconstructed polygon rings when present:
            // smaller wire format, clean strokes, fewer rasterizer cells to
            // process. Each feature is emitted as a single Polygon (first ring
            // outer, subsequent rings holes per S-57 convention).
            //
            // Fall back to the triangle safety net per-feature when the rings
            // either weren't assembled or failed the sanity check.
            if (f.geometry.rings && f.geometry.rings.length > 0) {
                const rings = f.geometry.rings.map((ring) => ring.map(roundPt));
                if (rings[0].length >= 4) {
                    return {
                        type: 'Feature',
                        id: f.rcid,
                        geometry: { type: 'Polygon', coordinates: rings },
                        properties,
                    };
                }
            }
            const polys: [number, number][][][] = f.geometry.triangles.map((tri) => [
                [roundPt(tri[0]), roundPt(tri[1]), roundPt(tri[2]), roundPt(tri[0])],
            ]);
            if (polys.length === 0) return null;
            return {
                type: 'Feature',
                id: f.rcid,
                geometry: { type: 'MultiPolygon', coordinates: polys },
                properties,
            };
        }

        case 'Line': {
            const coords = f.geometry.coordinates.map(roundPt);
            if (coords.length < 2) return null;
            return {
                type: 'Feature',
                id: f.rcid,
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
