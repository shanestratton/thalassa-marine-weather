/**
 * encHazardParse — the GeoJSON → EncHazard parse path.
 *
 * This is what the ROUTER trusts to avoid grounding: it turns a
 * converted cell's raw S-57 GeoJSON into the depth/geometry facts the
 * spatial index (and thence the inshore router) reasons over. A silent
 * miss here — a depth read as null, a hazard dropped, a case-sensitive
 * attribute lookup on a lowercased cell — is a grounding-risk defect, so
 * every reader is case-defensive and unit-tested (unlike the display
 * math, this path fans out into safety decisions, not just pixels).
 *
 * Extracted from EncHazardService (2026-07-15) precisely so it can be
 * tested in isolation — the mission-grade audit flagged the whole path
 * as having ZERO coverage while the display math had 91 tests.
 *
 * Pure: no cache, no I/O, no map. Depths keep the S-57 convention
 * (positive = metres below datum); callers convert at the comparison.
 */

import type { Feature, FeatureCollection } from 'geojson';

import { type EncCatzocZone, type EncCoastline } from './EncSpatialIndex';
import type { EncCatzoc, EncConversionResult, EncHazard, EncLayer } from './types';

/**
 * Read a numeric attribute from a GeoJSON feature's properties.
 * S-57 → GeoJSON conversion via ogr2ogr typically lowercases attribute
 * names and may quote numeric values as strings; handle both. Every
 * passed name is also tried lowercased, so callers can pass just the
 * canonical uppercase S-57 code.
 */
export function readNumber(feat: Feature, ...names: string[]): number | null {
    const props = feat.properties ?? {};
    for (const name of names) {
        const v = (props as Record<string, unknown>)[name] ?? (props as Record<string, unknown>)[name.toLowerCase()];
        if (v == null) continue;
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Read a non-empty string attribute case-defensively — the text-attr
 * sibling of readNumber (ogr2ogr lowercases names, so OBJNAM may arrive
 * as `objnam`). Returns undefined for missing/blank/non-string values.
 */
export function readString(feat: Feature, ...names: string[]): string | undefined {
    const props = (feat.properties ?? {}) as Record<string, unknown>;
    for (const name of names) {
        const v = props[name] ?? props[name.toLowerCase()];
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
}

/**
 * Convert a parsed FeatureCollection into our internal EncHazard shape.
 * Per-layer attribute extraction:
 *  - DEPARE/DRGARE: minDepth from DRVAL1 (dredged areas ARE depth areas —
 *    S-57 Group 1, they carry DRVAL1 and REPLACE the DEPARE there)
 *  - OBSTRN/WRECKS: minDepth from VALSOU (positive = depth below datum)
 *  - LNDARE/UWTROC: depth N/A (always hazard)
 */
export function featuresToHazards(layer: EncLayer, fc: FeatureCollection): EncHazard[] {
    const out: EncHazard[] = [];
    for (const feat of fc.features ?? []) {
        if (!feat || !feat.geometry) continue;
        let minDepthM: number | null = null;
        if (layer === 'DEPARE' || layer === 'DRGARE') {
            minDepthM = readNumber(feat, 'DRVAL1');
        } else if (layer === 'OBSTRN' || layer === 'WRECKS') {
            minDepthM = readNumber(feat, 'VALSOU');
        }
        // Case-defensive (was OBJNAM-uppercase-only): an ogr2ogr lowercased
        // cell silently dropped the descriptor otherwise.
        const description = readString(feat, 'OBJNAM');
        const g = feat.geometry;
        if (g.type === 'MultiPoint') {
            // EXPLODE into per-point hazards. queryPoint matches a point
            // hazard by EXACT coordinate (a degenerate bbox); a MultiPoint
            // left whole has a bbox spanning the WATER BETWEEN its points, so
            // it would never be detected — a missed rock/wreck cluster
            // (mission-audit hardening). Each point becomes its own hazard.
            for (const c of g.coordinates) {
                out.push({ layer, geometry: { type: 'Point', coordinates: c }, minDepthM, description });
            }
        } else {
            out.push({ layer, geometry: g, minDepthM, description });
        }
    }
    return out;
}

/**
 * Build the EncHazard list for a converted cell across every layer of
 * interest.
 */
export function buildHazardsForCell(blob: EncConversionResult): EncHazard[] {
    const all: EncHazard[] = [];
    const layerPairs: [EncLayer, FeatureCollection | undefined][] = [
        ['DEPARE', blob.layers.DEPARE],
        // DRGARE (dredged areas) carry DRVAL1 and, per S-57 Group 1, REPLACE
        // the depth area there — dropping them let a shallow dredged basin
        // read as unmodelled clear water (mission audit, fail-dangerous).
        ['DRGARE', blob.layers.DRGARE],
        ['LNDARE', blob.layers.LNDARE],
        ['OBSTRN', blob.layers.OBSTRN],
        ['WRECKS', blob.layers.WRECKS],
        ['UWTROC', blob.layers.UWTROC],
    ];
    for (const [layer, fc] of layerPairs) {
        if (!fc) continue;
        all.push(...featuresToHazards(layer, fc));
    }
    return all;
}

/**
 * Pull the COALNE LineStrings out of a converted cell. Filters down the
 * Polygon/Point-shaped junk that GDAL sometimes emits.
 */
export function buildCoastlines(blob: EncConversionResult): EncCoastline[] {
    const fc = blob.layers.COALNE;
    if (!fc || !Array.isArray(fc.features)) return [];
    const out: EncCoastline[] = [];
    for (const feat of fc.features) {
        if (!feat || !feat.geometry) continue;
        if (feat.geometry.type !== 'LineString' && feat.geometry.type !== 'MultiLineString') continue;
        out.push({ geometry: feat.geometry });
    }
    return out;
}

/**
 * Build the CATZOC zone list from a cell's M_QUAL FeatureCollection.
 * Skips features without a usable CATZOC attribute (1..6).
 */
/**
 * Explode a cell's SOUNDG MultiPoint clouds into individual labelled
 * point features — the minimal `{_d, _minZoom?}` bag the merged heap
 * needs (deliberately NO provenance: a harbour cell carries thousands of
 * soundings). Depth comes from the SENC `depths` array, the 2.5D Z, or
 * VALSOU/DEPTH — whichever the extraction path supplied. Non-finite
 * coords/depths are skipped, never a bogus 0 m point.
 *
 * Pure + testable; lifted verbatim out of the merge monolith (#2b) — the
 * caller pushes the result into merged.SOUNDG one feature at a time.
 */
export function explodeSoundings(fc: FeatureCollection | undefined): Feature[] {
    const out: Feature[] = [];
    for (const feat of fc?.features ?? []) {
        const g = feat?.geometry;
        if (!g) continue;
        const featProps = (feat.properties ?? {}) as Record<string, unknown>;
        const minZoom = typeof featProps._minZoom === 'number' ? featProps._minZoom : undefined;
        const depthsArr = Array.isArray(featProps.depths) ? (featProps.depths as unknown[]) : null;
        const coords: number[][] =
            g.type === 'MultiPoint'
                ? (g.coordinates as number[][])
                : g.type === 'Point'
                  ? [g.coordinates as number[]]
                  : [];
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i];
            if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
            const raw = depthsArr?.[i] ?? c[2] ?? featProps.VALSOU ?? featProps.DEPTH;
            const d = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(d)) continue;
            const props: Record<string, unknown> = { _d: Math.round(d * 10) / 10 };
            if (minZoom !== undefined) props._minZoom = minZoom;
            out.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [c[0], c[1]] },
                properties: props,
            });
        }
    }
    return out;
}

export function buildCatzocZones(blob: EncConversionResult): EncCatzocZone[] {
    const fc = blob.layers.M_QUAL;
    if (!fc || !Array.isArray(fc.features)) return [];
    const zones: EncCatzocZone[] = [];
    for (const feat of fc.features) {
        if (!feat || !feat.geometry) continue;
        if (feat.geometry.type !== 'Polygon' && feat.geometry.type !== 'MultiPolygon') continue;
        const raw = readNumber(feat, 'CATZOC');
        if (raw == null) continue;
        const rounded = Math.round(raw);
        if (rounded < 1 || rounded > 6) continue;
        zones.push({ geometry: feat.geometry, catzoc: rounded as EncCatzoc });
    }
    return zones;
}
