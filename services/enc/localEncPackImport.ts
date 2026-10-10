/**
 * The strong shape gate for Thalassa's converted chart wire shape
 * (`EncConversionResult` or `{ cells: EncConversionResult[] }`), run on every
 * cell the boat's Pi or the NOAA shelf hands this phone before any of it is
 * held (the Pi sync, the on-demand Pi pull and the NOAA shelf).
 *
 * This module also used to import unsigned "reference" packs from a file or a
 * link (the ENC Library). That half is retired in 127 (127-C-c, Shane's Q1
 * "yes"): a pack's provenance could not be proven, so under the licence rule
 * every one was protected, and open NOAA charts arrive by themselves.
 */

import { ENC_NO_DEPTH_AREAS_CODE } from './piSyncPlan';
import {
    CAUTION_AREA_CLASSES,
    canonicalEncCellId,
    ENC_CELL_ID_PATTERN,
    S57_CELL_NAME_PATTERN,
    S57_CLEARANCE_STRUCTURE_CLASSES,
    S57_POINT_MARK_CLASSES,
    S57_STRUCTURE_CLASSES,
    type EncConversionBatch,
    type EncConversionResult,
} from './types';

/** Bound one batch so a bad payload cannot exhaust a mobile WebView. */
export const LOCAL_ENC_PACK_MAX_CELLS = 50;
const LOCAL_ENC_PACK_MAX_FEATURES = 250_000;
const LOCAL_ENC_PACK_MAX_POSITIONS = 750_000;
const LOCAL_ENC_PACK_MAX_GEOMETRY_DEPTH = 32;
const LOCAL_ENC_PACK_MAX_SKIPPED = 1_000;

/**
 * How far chart geometry may legitimately overhang its declared bbox.
 *
 * ~0.001 deg is about 110 m. Was 1e-6 (roughly 10 cm), which is a
 * floating-point epsilon rather than a hydrographic one — it rejected
 * FR466870 (Noumea) and GB501494 (Port Vila) outright over overhangs of 4 m
 * and 43 m (measured 2026-08-07). Features sitting ON a cell boundary, and
 * coordinate rounding in the source, routinely put a vertex a few metres past
 * the rectangle; that is normal S-57, not corruption.
 *
 * The check still does its real job. It exists to catch a cell whose geometry
 * belongs somewhere else entirely — a mislabelled or tampered pack — and those
 * failures are kilometres or degrees out, thousands of times this tolerance.
 * Deliberately ABSOLUTE rather than a fraction of cell size, so a large cell
 * cannot quietly earn a large allowance.
 *
 * Note this bounds only OVERHANG. A bbox larger than its geometry — the
 * direction that would overstate coverage — is unaffected either way.
 */
const BBOX_EDGE_TOLERANCE_DEG = 0.001;

const BASE_LAYER_NAMES = [
    'DEPARE',
    'DRGARE',
    'LNDARE',
    'COALNE',
    'SOUNDG',
    'DEPCNT',
    'M_QUAL',
    'FAIRWY',
    'RECTRC',
    'NAVLNE',
    'SEAARE',
] as const;

/** Runtime counterpart of `EncConversionResult.layers`. Unknown chart classes
 * fail closed instead of being silently dropped from a reference dataset. */
export const LOCAL_ENC_PACK_LAYER_NAMES = new Set<string>([
    ...BASE_LAYER_NAMES,
    ...S57_POINT_MARK_CLASSES,
    ...S57_STRUCTURE_CLASSES,
    // Converter schema 2 always emits these (empty when none is charted): a
    // phone without them rejects every re-extracted cell, so they must ship
    // to every phone BEFORE the Pi or the extractor moves to schema 2.
    ...S57_CLEARANCE_STRUCTURE_CLASSES,
    ...CAUTION_AREA_CLASSES,
]);

type JsonRecord = Record<string, unknown>;

interface GeometryBounds {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
    positions: number;
    budget: ValidationBudget;
}

interface ValidationBudget {
    features: number;
    positions: number;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
    return value;
}

function position(value: unknown, label: string, bounds: GeometryBounds): void {
    if (!Array.isArray(value) || value.length < 2) throw new Error(`${label} is not a GeoJSON position.`);
    if (value.length > 4) throw new Error(`${label} contains too many coordinate ordinates.`);
    const lon = finiteNumber(value[0], `${label} longitude`);
    const lat = finiteNumber(value[1], `${label} latitude`);
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw new Error(`${label} is outside valid longitude/latitude bounds.`);
    }
    for (let index = 2; index < value.length; index += 1) {
        finiteNumber(value[index], `${label} ordinate ${index + 1}`);
    }
    bounds.minLon = Math.min(bounds.minLon, lon);
    bounds.minLat = Math.min(bounds.minLat, lat);
    bounds.maxLon = Math.max(bounds.maxLon, lon);
    bounds.maxLat = Math.max(bounds.maxLat, lat);
    bounds.positions += 1;
    bounds.budget.positions += 1;
    if (bounds.budget.positions > LOCAL_ENC_PACK_MAX_POSITIONS) {
        throw new Error(`ENC pack contains more than ${LOCAL_ENC_PACK_MAX_POSITIONS.toLocaleString()} positions.`);
    }
}

function positionList(value: unknown, label: string, bounds: GeometryBounds, minimum: number): void {
    if (!Array.isArray(value) || value.length < minimum) {
        throw new Error(`${label} must contain at least ${minimum} positions.`);
    }
    value.forEach((item, index) => position(item, `${label}[${index}]`, bounds));
}

function lineList(value: unknown, label: string, bounds: GeometryBounds, minimum: number): void {
    if (!Array.isArray(value) || value.length < minimum) {
        throw new Error(`${label} must contain at least ${minimum} coordinate arrays.`);
    }
    value.forEach((item, index) => positionList(item, `${label}[${index}]`, bounds, 2));
}

function polygonList(value: unknown, label: string, bounds: GeometryBounds): void {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain a polygon.`);
    value.forEach((polygon, polygonIndex) => {
        if (!Array.isArray(polygon) || polygon.length === 0) {
            throw new Error(`${label}[${polygonIndex}] must contain at least one ring.`);
        }
        polygon.forEach((ring, ringIndex) => {
            const ringLabel = `${label}[${polygonIndex}][${ringIndex}]`;
            positionList(ring, ringLabel, bounds, 4);
            const positions = ring as unknown[];
            const first = positions[0] as unknown[];
            const last = positions[positions.length - 1] as unknown[];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                throw new Error(`${ringLabel} must be a closed GeoJSON ring.`);
            }
        });
    });
}

function validateGeometry(value: unknown, label: string, bounds: GeometryBounds, depth = 0): void {
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error(`${label} is not a GeoJSON geometry.`);
    if (depth > LOCAL_ENC_PACK_MAX_GEOMETRY_DEPTH) {
        throw new Error(`ENC pack geometry nesting exceeds ${LOCAL_ENC_PACK_MAX_GEOMETRY_DEPTH} levels.`);
    }
    switch (value.type) {
        case 'Point':
            position(value.coordinates, `${label}.coordinates`, bounds);
            return;
        case 'MultiPoint':
            positionList(value.coordinates, `${label}.coordinates`, bounds, 1);
            return;
        case 'LineString':
            positionList(value.coordinates, `${label}.coordinates`, bounds, 2);
            return;
        case 'MultiLineString':
            lineList(value.coordinates, `${label}.coordinates`, bounds, 1);
            return;
        case 'Polygon':
            polygonList([value.coordinates], `${label}.coordinates`, bounds);
            return;
        case 'MultiPolygon':
            polygonList(value.coordinates, `${label}.coordinates`, bounds);
            return;
        case 'GeometryCollection': {
            if (!Array.isArray(value.geometries) || value.geometries.length === 0) {
                throw new Error(`${label}.geometries must not be empty.`);
            }
            value.geometries.forEach((geometry, index) =>
                validateGeometry(geometry, `${label}.geometries[${index}]`, bounds, depth + 1),
            );
            return;
        }
        default:
            throw new Error(`${label} uses unsupported geometry type ${JSON.stringify(value.type)}.`);
    }
}

function validateFeatureCollection(
    value: unknown,
    label: string,
    bounds: GeometryBounds,
): asserts value is GeoJSON.FeatureCollection {
    if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
        throw new Error(`${label} must be a GeoJSON FeatureCollection.`);
    }
    bounds.budget.features += value.features.length;
    if (bounds.budget.features > LOCAL_ENC_PACK_MAX_FEATURES) {
        throw new Error(`ENC pack contains more than ${LOCAL_ENC_PACK_MAX_FEATURES.toLocaleString()} features.`);
    }
    value.features.forEach((feature, index) => {
        const featureLabel = `${label}.features[${index}]`;
        if (!isRecord(feature) || feature.type !== 'Feature') throw new Error(`${featureLabel} is not a Feature.`);
        if (feature.properties !== null && feature.properties !== undefined && !isRecord(feature.properties)) {
            throw new Error(`${featureLabel}.properties must be an object or null.`);
        }
        // Null geometry is legal generic GeoJSON, but unsafe in an ENC import:
        // it is a silently missing chart object, not usable navigation data.
        validateGeometry(feature.geometry, `${featureLabel}.geometry`, bounds);
    });
}

/**
 * A chart with no DEPARE/DRGARE depth areas: it cannot verify water depths, so
 * the phone refuses it. Typed (2026-10-01) so the Pi sync can remember the
 * refusal instead of downloading and refusing the same bytes on every sync;
 * the message is unchanged because the ENC sheet classifies on it.
 */
export class EncMissingDepthAreaError extends Error {
    readonly code = ENC_NO_DEPTH_AREAS_CODE;
    constructor(cellId: string) {
        super(`${cellId}: no DEPARE/DRGARE depth-area coverage; the pack cannot verify water depths.`);
        this.name = 'EncMissingDepthAreaError';
    }
}

function validateCell(value: unknown, index: number, budget: ValidationBudget): EncConversionResult {
    const label = `cells[${index}]`;
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);

    const cellId = typeof value.cellId === 'string' ? canonicalEncCellId(value.cellId) : '';
    if (!ENC_CELL_ID_PATTERN.test(cellId)) {
        throw new Error(`${label}.cellId must be 2–64 letters, numbers, hyphens or underscores.`);
    }
    const sourceHO = typeof value.sourceHO === 'string' ? value.sourceHO.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(sourceHO)) {
        throw new Error(`${cellId}: sourceHO must be the issuing hydrographic office's two-letter code.`);
    }
    // Producer-code cross-check, scoped to GENUINE S-57 cell names (2026-08-07).
    //
    // For an S-57 name the first two characters ARE the issuing office —
    // US5GA22M/US, FR466870/FR — so a mismatch is real evidence of tampering
    // or a mislabelled pack, and stays fatal.
    //
    // o-charts issues its own identifiers instead, where the prefix is a SET
    // code carrying no producer meaning: OC-61-051031 is an AUSTRALIAN cell
    // that correctly declares sourceHO "AU". Applying the rule there rejected
    // 344 of Shane's 345 legitimately decrypted charts — the whole Australian
    // library plus Noumea and Port Vila — for a mismatch that is simply how
    // o-charts names things. The two-letter-office check above still applies
    // to every cell.
    if (S57_CELL_NAME_PATTERN.test(cellId) && sourceHO !== cellId.slice(0, 2)) {
        throw new Error(`${cellId}: sourceHO must match the first two characters of an S-57 cell name.`);
    }
    const sourceCellId = value.sourceCellId;
    if (
        sourceCellId !== undefined &&
        (typeof sourceCellId !== 'string' ||
            !S57_CELL_NAME_PATTERN.test(sourceCellId) ||
            sourceCellId.slice(0, 2) !== sourceHO)
    ) {
        throw new Error(`${cellId}: original chart identifier must match the issuing office.`);
    }
    // The compilation scale (DSPM CSCL) the extractor carries: the router's
    // survey fineness (scaleShadow cellFinenessRank). Optional; a malformed one
    // is refused rather than guessed at. Zero or negative is ABSENT — the SENC
    // header's unsigned read gives 0 when the producer left it blank, and
    // refusing threw the whole pack away with its fine cells (Phase 2a
    // round-2 review, 2026-09-30): the cell is kept, its rank unknown.
    const rawNativeScale = value.nativeScale;
    const nativeScale = typeof rawNativeScale === 'number' && rawNativeScale <= 0 ? undefined : rawNativeScale;
    if (
        nativeScale !== undefined &&
        (typeof nativeScale !== 'number' || !Number.isFinite(nativeScale) || nativeScale < 1 || nativeScale > 1e9)
    ) {
        throw new Error(`${cellId}.nativeScale must be a compilation scale denominator from 1 to 1e9.`);
    }
    const edition = finiteNumber(value.edition, `${cellId}.edition`);
    if (!Number.isInteger(edition) || edition < 0 || edition > 9999) {
        throw new Error(`${cellId}.edition must be an integer from 0 to 9999.`);
    }
    const updateNumber = value.updateNumber;
    if (
        updateNumber !== undefined &&
        (typeof updateNumber !== 'number' || !Number.isInteger(updateNumber) || updateNumber < 0 || updateNumber > 9999)
    ) {
        throw new Error(`${cellId}.updateNumber must be an integer from 0 to 9999.`);
    }
    const issued = typeof value.issued === 'string' ? value.issued.trim() : '';
    const issuedDate = new Date(`${issued}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(issued) ||
        Number.isNaN(issuedDate.getTime()) ||
        issuedDate.toISOString().slice(0, 10) !== issued
    ) {
        throw new Error(`${cellId}.issued must be a real date in YYYY-MM-DD form.`);
    }
    if (!Array.isArray(value.bbox) || value.bbox.length !== 4) {
        throw new Error(`${cellId}.bbox must be [west, south, east, north].`);
    }
    const bbox = value.bbox.map((coordinate, bboxIndex) =>
        finiteNumber(coordinate, `${cellId}.bbox[${bboxIndex}]`),
    ) as [number, number, number, number];
    if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
        throw new Error(`${cellId}.bbox is outside the world or has an empty/reversed extent.`);
    }
    if (!isRecord(value.layers)) throw new Error(`${cellId}.layers must be an object.`);

    const bounds: GeometryBounds = {
        minLon: Number.POSITIVE_INFINITY,
        minLat: Number.POSITIVE_INFINITY,
        maxLon: Number.NEGATIVE_INFINITY,
        maxLat: Number.NEGATIVE_INFINITY,
        positions: 0,
        budget,
    };
    for (const [layer, collection] of Object.entries(value.layers)) {
        if (!LOCAL_ENC_PACK_LAYER_NAMES.has(layer)) {
            throw new Error(`${cellId}: unsupported chart layer ${JSON.stringify(layer)}; nothing was imported.`);
        }
        validateFeatureCollection(collection, `${cellId}.layers.${layer}`, bounds);
    }
    const layers = value.layers as EncConversionResult['layers'];
    const depthAreaCount = (layers.DEPARE?.features.length ?? 0) + (layers.DRGARE?.features.length ?? 0);
    if (depthAreaCount === 0) {
        throw new EncMissingDepthAreaError(cellId);
    }
    if (bounds.positions === 0) throw new Error(`${cellId}: the pack contains no usable chart geometry.`);
    if (
        bounds.minLon < bbox[0] - BBOX_EDGE_TOLERANCE_DEG ||
        bounds.minLat < bbox[1] - BBOX_EDGE_TOLERANCE_DEG ||
        bounds.maxLon > bbox[2] + BBOX_EDGE_TOLERANCE_DEG ||
        bounds.maxLat > bbox[3] + BBOX_EDGE_TOLERANCE_DEG
    ) {
        throw new Error(`${cellId}: chart geometry lies outside its declared bbox; nothing was imported.`);
    }

    return {
        cellId,
        sourceHO,
        ...(sourceCellId !== undefined ? { sourceCellId: sourceCellId as string } : {}),
        ...(nativeScale !== undefined ? { nativeScale: nativeScale as number } : {}),
        edition,
        ...(updateNumber !== undefined ? { updateNumber: updateNumber as number } : {}),
        issued,
        bbox,
        layers,
    };
}

/** Strong shape gate used before any cell is written. */
export function validateLocalEncPack(value: unknown): EncConversionBatch {
    const rawCells = isRecord(value) && Array.isArray(value.cells) ? value.cells : [value];
    if (rawCells.length === 0) throw new Error('ENC pack contains no cells.');
    if (rawCells.length > LOCAL_ENC_PACK_MAX_CELLS) {
        throw new Error(
            `ENC pack contains ${rawCells.length} cells; import at most ${LOCAL_ENC_PACK_MAX_CELLS} at once.`,
        );
    }
    const budget: ValidationBudget = { features: 0, positions: 0 };
    const cells = rawCells.map((cell, index) => validateCell(cell, index, budget));
    const ids = new Set<string>();
    for (const cell of cells) {
        if (ids.has(cell.cellId)) throw new Error(`ENC pack contains duplicate cell ${cell.cellId}.`);
        ids.add(cell.cellId);
    }

    const skippedRaw = isRecord(value) && Array.isArray(value.skipped) ? value.skipped : [];
    if (skippedRaw.length > LOCAL_ENC_PACK_MAX_SKIPPED) {
        throw new Error(`ENC pack contains too many skipped-source records (maximum ${LOCAL_ENC_PACK_MAX_SKIPPED}).`);
    }
    const skipped = skippedRaw.map((item, index) => {
        if (!isRecord(item) || typeof item.filename !== 'string' || typeof item.error !== 'string') {
            throw new Error(`skipped[${index}] must contain filename and error strings.`);
        }
        return { filename: item.filename.slice(0, 200), error: item.error.slice(0, 500) };
    });
    return { cells, skipped };
}
