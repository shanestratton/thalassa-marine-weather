/**
 * Pi-independent ENC pack import for the public beta.
 *
 * The browser/native app cannot decode raw S-57 or encrypted S-63 safely:
 * that requires GDAL or the chart vendor's licensed decryption runtime. This
 * module therefore accepts only Thalassa's already-converted JSON wire shape
 * (`EncConversionResult` or `{ cells: EncConversionResult[] }`). The bytes are
 * fetched/read and persisted on this device; they are never uploaded by this
 * path.
 */

import { createLogger } from '../../utils/createLogger';
import * as EncHazardService from './EncHazardService';
import { parseJsonOffThread } from './EncCellStore';
import {
    CAUTION_AREA_CLASSES,
    canonicalEncCellId,
    ENC_CELL_ID_PATTERN,
    S57_CELL_NAME_PATTERN,
    encCellStorageIdentity,
    S57_POINT_MARK_CLASSES,
    S57_STRUCTURE_CLASSES,
    type EncCell,
    type EncConversionBatch,
    type EncConversionResult,
} from './types';

const log = createLogger('LocalEncPackImport');

/** Bound a single import so a bad URL/file cannot exhaust a mobile WebView. */
export const LOCAL_ENC_PACK_MAX_BYTES = 16 * 1024 * 1024;
export const LOCAL_ENC_PACK_MAX_CELLS = 50;
const LOCAL_ENC_PACK_MAX_FEATURES = 250_000;
const LOCAL_ENC_PACK_MAX_POSITIONS = 750_000;
const LOCAL_ENC_PACK_MAX_GEOMETRY_DEPTH = 32;
const LOCAL_ENC_PACK_MAX_SKIPPED = 1_000;
const URL_TIMEOUT_MS = 45_000;

const DIRECT_PACK_SUFFIX = /\.(?:thalassaenc|json|geojson)$/i;
const RAW_OR_ENCRYPTED_CHART_SUFFIX = /\.(?:00\d|zip|es57|oesenc|oesu|s63)$/i;

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
    ...CAUTION_AREA_CLASSES,
]);

export type LocalEncPackPhase = 'reading' | 'validating' | 'storing' | 'done';

export interface LocalEncPackProgress {
    phase: LocalEncPackPhase;
    progress: number;
    step: string;
    cellCount?: number;
    cellsDone?: number;
}

export interface LocalEncPackImportResult {
    cells: EncCell[];
    skipped: Array<{ filename: string; error: string }>;
}

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

function byteLength(text: string): number {
    if (typeof Blob !== 'undefined') return new Blob([text]).size;
    return new TextEncoder().encode(text).byteLength;
}

function ensureSize(size: number): void {
    if (!Number.isFinite(size) || size < 0) throw new Error('The ENC pack size could not be verified.');
    if (size > LOCAL_ENC_PACK_MAX_BYTES) {
        throw new Error(
            `ENC pack is ${(size / 1_048_576).toFixed(1)} MB; the on-device import limit is ` +
                `${LOCAL_ENC_PACK_MAX_BYTES / 1_048_576} MB. Split the pack into smaller files.`,
        );
    }
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
    const edition = finiteNumber(value.edition, `${cellId}.edition`);
    if (!Number.isInteger(edition) || edition < 0 || edition > 9999) {
        throw new Error(`${cellId}.edition must be an integer from 0 to 9999.`);
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
        throw new Error(`${cellId}: no DEPARE/DRGARE depth-area coverage; the pack cannot verify water depths.`);
    }
    if (bounds.positions === 0) throw new Error(`${cellId}: the pack contains no usable chart geometry.`);
    const epsilon = 1e-6;
    if (
        bounds.minLon < bbox[0] - epsilon ||
        bounds.minLat < bbox[1] - epsilon ||
        bounds.maxLon > bbox[2] + epsilon ||
        bounds.maxLat > bbox[3] + epsilon
    ) {
        throw new Error(`${cellId}: chart geometry lies outside its declared bbox; nothing was imported.`);
    }

    return {
        cellId,
        sourceHO,
        edition,
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

export function isSupportedLocalEncPackFilename(filename: string): boolean {
    return DIRECT_PACK_SUFFIX.test(filename.trim());
}

function unsupportedFilenameMessage(filename: string): string {
    if (RAW_OR_ENCRYPTED_CHART_SUFFIX.test(filename.trim())) {
        return (
            `${filename} is a raw or encrypted chart file. Public-beta devices cannot decode S-57 .000/ZIP, ` +
            'S-63 .es57, or o-charts files. Import an already-converted .thalassaenc/.json pack instead; ' +
            'keep the original chart and its licence in your approved chart system.'
        );
    }
    return `${filename} is not a Thalassa ENC pack. Choose a .thalassaenc, .json or .geojson file.`;
}

/** File picker for converted, Pi-independent packs only. */
export function pickLocalEncPackFile(): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.thalassaenc,.json,.geojson,application/json,application/geo+json';
        input.style.display = 'none';
        document.body.appendChild(input);
        const finish = (file: File | null): void => {
            input.remove();
            resolve(file);
        };
        input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => finish(null), { once: true });
        input.click();
    });
}

function emitProgress(
    callback: ((progress: LocalEncPackProgress) => void) | undefined,
    progress: LocalEncPackProgress,
): void {
    try {
        callback?.(progress);
    } catch (error) {
        log.warn('progress callback threw', error);
    }
}

async function importParsedPack(
    parsed: unknown,
    onProgress?: (progress: LocalEncPackProgress) => void,
): Promise<LocalEncPackImportResult> {
    emitProgress(onProgress, { phase: 'validating', progress: 0.25, step: 'Validating chart metadata and geometry' });
    const pack = validateLocalEncPack(parsed);

    // Prevent an accidental chart rollback before mutating any cell. A same-
    // edition re-import is allowed because extraction/render fixes can change
    // bytes without changing the hydrographic office's edition number.
    const installed = new Map(
        EncHazardService.getDisplayCoverage().map((cell) => [encCellStorageIdentity(cell.id), cell]),
    );
    for (const candidate of pack.cells) {
        const current = installed.get(encCellStorageIdentity(candidate.cellId));
        if (current && current.usage !== 'reference') {
            throw new Error(
                `${candidate.cellId} is already installed as trusted navigation coverage. ` +
                    'An unsigned reference pack cannot replace it; the trusted chart was kept.',
            );
        }
        if (current && current.edition > candidate.edition) {
            throw new Error(
                `${candidate.cellId} edition ${candidate.edition} is older than installed edition ${current.edition}; ` +
                    'the newer chart was kept.',
            );
        }
    }

    const imported: EncCell[] = [];
    for (let index = 0; index < pack.cells.length; index += 1) {
        const candidate = pack.cells[index];
        emitProgress(onProgress, {
            phase: 'storing',
            progress: 0.3 + (index / pack.cells.length) * 0.65,
            step: `Saving ${candidate.cellId} on this device`,
            cellCount: pack.cells.length,
            cellsDone: index,
        });
        // Unsigned file/URL packs are reference overlays only. Their metadata
        // is self-asserted, so they must never become hazard/routing/Cast-Off
        // authority without a future trusted signature/publisher path.
        imported.push(await EncHazardService.importCell(candidate, { usage: 'reference' }));
    }
    emitProgress(onProgress, {
        phase: 'done',
        progress: 1,
        step: `${imported.length} reference ENC cell${imported.length === 1 ? '' : 's'} ready on this device`,
        cellCount: imported.length,
        cellsDone: imported.length,
    });
    return { cells: imported, skipped: pack.skipped ?? [] };
}

export async function importLocalEncPackText(
    text: string,
    onProgress?: (progress: LocalEncPackProgress) => void,
): Promise<LocalEncPackImportResult> {
    ensureSize(byteLength(text));
    let parsed: unknown;
    try {
        parsed = await parseJsonOffThread(text);
    } catch {
        throw new Error('The selected file is not valid JSON; nothing was imported.');
    }
    return importParsedPack(parsed, onProgress);
}

export async function importLocalEncPackFile(
    file: File,
    onProgress?: (progress: LocalEncPackProgress) => void,
): Promise<LocalEncPackImportResult> {
    if (!isSupportedLocalEncPackFilename(file.name)) throw new Error(unsupportedFilenameMessage(file.name));
    ensureSize(file.size);
    emitProgress(onProgress, { phase: 'reading', progress: 0.05, step: `Reading ${file.name} on this device` });
    const text =
        typeof file.text === 'function'
            ? await file.text()
            : await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
                  reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                  reader.readAsText(file);
              });
    return importLocalEncPackText(text, onProgress);
}

/** HTTPS-only: unlike the held Pi flow, this never enables cleartext LAN I/O. */
export function validateLocalEncPackUrl(rawUrl: string): URL {
    let url: URL;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        throw new Error('Enter a valid direct HTTPS URL.');
    }
    if (url.protocol !== 'https:') throw new Error('ENC pack URLs must use HTTPS.');
    if (url.username || url.password) throw new Error('ENC pack URLs must not contain embedded credentials.');
    return url;
}

async function responseTextWithinLimit(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 0) ensureSize(declaredLength);
    if (!response.body?.getReader) {
        const blob = await response.blob();
        ensureSize(blob.size);
        return blob.text();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const pieces: string[] = [];
    let received = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            ensureSize(received);
            pieces.push(decoder.decode(value, { stream: true }));
        }
        pieces.push(decoder.decode());
        return pieces.join('');
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    }
}

export async function importLocalEncPackUrl(
    rawUrl: string,
    onProgress?: (progress: LocalEncPackProgress) => void,
): Promise<LocalEncPackImportResult> {
    const url = validateLocalEncPackUrl(rawUrl);
    emitProgress(onProgress, {
        phase: 'reading',
        progress: 0.05,
        step: 'Downloading ENC pack directly to this device',
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'GET',
            // Fail closed: following even an HTTPS URL through an HTTP hop
            // would contact cleartext before a final-URL check could notice.
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            headers: { Accept: 'application/json, application/geo+json' },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`ENC pack download failed (HTTP ${response.status}).`);
        // Defence in depth for unusual fetch implementations.
        validateLocalEncPackUrl(response.url || url.href);
        return await importLocalEncPackText(await responseTextWithinLimit(response), onProgress);
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error('ENC pack download timed out. Check the connection and try again.');
        }
        if (error instanceof TypeError) {
            throw new Error(
                'ENC pack download failed. Use a direct HTTPS pack URL with cross-origin downloads enabled; redirects are not accepted.',
            );
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
