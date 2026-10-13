/** Verified, bounded CAPAD/MPA schema-v2 loader. */
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { API_BASE } from '../../native/apiBase';
import { createLogger } from '../../../utils/createLogger';
import { validateMarineManifest } from './marineManifestContract';
import {
    decodeUtf8Json,
    fetchBoundedPublisherBytes,
    MANIFEST_MAX_BYTES,
    MarineDataTrustError,
    publisherGenerationSuffix,
    verifyPublisherAsset,
    type PublisherBounds,
} from './cmemsGridTrust';

const log = createLogger('mpaDataset');

export const MPA_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const MPA_CACHE_TTL_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const GENERATION_RE = /^g-\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MPA_DATASET_ID = 'dcceew-capad-mapserver-layer-1';
const ALLOWED_PROTECTION_CLASSES = new Set(['high', 'conditional', 'multiple_use']);
const MPA_PROPERTY_KEYS = [
    'name',
    'type',
    'iucn',
    'zone',
    'authority',
    'state',
    'area_km2',
    'protection_class',
    'classification_source',
] as const;

export interface MpaManifestFile {
    step: 0;
    filename: string;
    bytes: number;
    sha256: string;
    content_type: 'application/geo+json';
}

export interface MpaManifest {
    schema_version: 2;
    dataset: { key: 'mpa'; id: typeof MPA_DATASET_ID };
    generation: string;
    generated_at: string;
    published_at: string;
    data_start: string;
    data_end: string;
    cadence_hours: null;
    dimensions: { feature_count: number };
    bounds: PublisherBounds;
    producer: { commit: string; run_id: number; run_attempt: number };
    files: [MpaManifestFile];
    metadata?: Record<string, unknown>;
}

export interface MpaProperties {
    name: string;
    type: string;
    iucn: string;
    zone: string;
    authority: string;
    state: string;
    area_km2: number;
    protection_class: 'high' | 'conditional' | 'multiple_use';
    classification_source: 'indicative_heuristic';
}

export type VerifiedMpaCollection = FeatureCollection<Polygon | MultiPolygon, MpaProperties>;

function requireTrust(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MarineDataTrustError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): void {
    const allowed = new Set([...required, ...optional]);
    requireTrust(
        required.every((key) => Object.hasOwn(value, key)),
        'MPA object is missing required fields',
    );
    requireTrust(
        Object.keys(value).every((key) => allowed.has(key)),
        'MPA object contains unexpected fields',
    );
}

function parseUtc(value: unknown, label: string): number {
    requireTrust(typeof value === 'string' && UTC_RE.test(value), `${label} must be a UTC Z timestamp`);
    const parsed = Date.parse(value);
    requireTrust(Number.isFinite(parsed), `${label} is not a real timestamp`);
    return parsed;
}

function compactUtc(ms: number): string {
    const date = new Date(ms);
    const two = (value: number) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}T${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
    requireTrust(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`);
    requireTrust(value >= minimum && value <= maximum, `${label} is outside its allowed range`);
}

export function validateMpaManifest(value: unknown, nowMs = Date.now()): MpaManifest {
    try {
        validateMarineManifest(value, 'mpa', nowMs, true);
    } catch (error) {
        throw new MarineDataTrustError(
            error instanceof Error ? error.message : 'MPA manifest violates the shared contract',
        );
    }
    requireTrust(isRecord(value), 'MPA manifest root must be an object');
    exactKeys(
        value,
        [
            'schema_version',
            'dataset',
            'generation',
            'generated_at',
            'published_at',
            'data_start',
            'data_end',
            'cadence_hours',
            'dimensions',
            'bounds',
            'producer',
            'files',
        ],
        ['metadata'],
    );
    requireTrust(value.schema_version === 2, 'MPA manifest schema_version must be exactly 2');
    requireTrust(isRecord(value.dataset), 'MPA dataset identity must be an object');
    exactKeys(value.dataset, ['key', 'id']);
    requireTrust(value.dataset.key === 'mpa' && value.dataset.id === MPA_DATASET_ID, 'MPA dataset identity mismatch');
    requireTrust(
        typeof value.generation === 'string' && GENERATION_RE.test(value.generation),
        'invalid MPA generation',
    );
    const generatedAt = parseUtc(value.generated_at, 'generated_at');
    const publishedAt = parseUtc(value.published_at, 'published_at');
    const dataStart = parseUtc(value.data_start, 'data_start');
    const dataEnd = parseUtc(value.data_end, 'data_end');
    requireTrust(dataStart === dataEnd, 'MPA source window must identify one source snapshot');
    requireTrust(dataStart <= nowMs, 'MPA source timestamp is in the future');
    requireTrust(value.generation.slice(2, 18) === compactUtc(dataStart), 'MPA generation timestamp mismatch');
    requireTrust(generatedAt >= dataStart && publishedAt >= generatedAt, 'MPA publication timestamps are out of order');
    requireTrust(
        generatedAt <= nowMs + 15 * 60 * 1000 && publishedAt <= nowMs + 15 * 60 * 1000,
        'MPA publication is in the future',
    );
    requireTrust(nowMs - publishedAt <= 14 * 24 * HOUR_MS, 'MPA weekly publication is stale');
    requireTrust(value.cadence_hours === null, 'MPA cadence must be null');

    requireTrust(isRecord(value.dimensions), 'MPA dimensions must be an object');
    exactKeys(value.dimensions, ['feature_count']);
    requireTrust(
        Number.isInteger(value.dimensions.feature_count) &&
            Number(value.dimensions.feature_count) >= 100 &&
            Number(value.dimensions.feature_count) <= 50_000,
        'MPA feature_count is outside its safety bounds',
    );
    requireTrust(isRecord(value.bounds), 'MPA bounds must be an object');
    exactKeys(value.bounds, ['north', 'south', 'west', 'east']);
    // Include Cocos (Keeling), Heard/McDonald and other external territories.
    finiteNumber(value.bounds.west, 70, 120, 'MPA west bound');
    finiteNumber(value.bounds.east, 145, 180, 'MPA east bound');
    finiteNumber(value.bounds.south, -60, -35, 'MPA south bound');
    finiteNumber(value.bounds.north, -15, 0, 'MPA north bound');
    requireTrust(
        value.bounds.north > value.bounds.south && value.bounds.east > value.bounds.west,
        'MPA bounds are not oriented',
    );

    requireTrust(isRecord(value.producer), 'MPA producer must be an object');
    exactKeys(value.producer, ['commit', 'run_id', 'run_attempt']);
    requireTrust(
        typeof value.producer.commit === 'string' && COMMIT_RE.test(value.producer.commit),
        'invalid MPA producer commit',
    );
    requireTrust(
        Number.isInteger(value.producer.run_id) && Number(value.producer.run_id) > 0,
        'invalid MPA producer run_id',
    );
    requireTrust(
        Number.isInteger(value.producer.run_attempt) && Number(value.producer.run_attempt) > 0,
        'invalid MPA producer run_attempt',
    );
    if (value.metadata !== undefined) requireTrust(isRecord(value.metadata), 'MPA metadata must be an object');

    requireTrust(
        Array.isArray(value.files) && value.files.length === 1 && isRecord(value.files[0]),
        'MPA manifest must declare one file',
    );
    const file = value.files[0];
    exactKeys(file, ['step', 'filename', 'bytes', 'sha256', 'content_type']);
    requireTrust(file.step === 0, 'MPA file step must be zero');
    requireTrust(file.filename === `${value.generation}-mpa.geojson`, 'MPA immutable filename mismatch');
    requireTrust(
        Number.isInteger(file.bytes) && Number(file.bytes) >= 100_000 && Number(file.bytes) <= MPA_ASSET_MAX_BYTES,
        'MPA file size is unsafe',
    );
    requireTrust(typeof file.sha256 === 'string' && SHA256_RE.test(file.sha256), 'MPA file SHA-256 is invalid');
    requireTrust(file.content_type === 'application/geo+json', 'MPA file content type is invalid');
    return value as unknown as MpaManifest;
}

interface ObservedBounds extends PublisherBounds {
    coordinateCount: number;
}

function validatePosition(
    value: unknown,
    observed: ObservedBounds,
    declared: PublisherBounds,
): asserts value is Position {
    requireTrust(Array.isArray(value) && value.length === 2, 'MPA coordinate must be a two-number position');
    const [lon, lat] = value;
    finiteNumber(lon, 70, 180, 'MPA longitude');
    finiteNumber(lat, -60, 0, 'MPA latitude');
    requireTrust(
        lon >= declared.west - 0.0001 &&
            lon <= declared.east + 0.0001 &&
            lat >= declared.south - 0.0001 &&
            lat <= declared.north + 0.0001,
        'MPA coordinate lies outside declared bounds',
    );
    observed.west = Math.min(observed.west, lon);
    observed.east = Math.max(observed.east, lon);
    observed.south = Math.min(observed.south, lat);
    observed.north = Math.max(observed.north, lat);
    observed.coordinateCount += 1;
    requireTrust(observed.coordinateCount <= 5_000_000, 'MPA coordinate count exceeds the client safety ceiling');
}

function validateRing(value: unknown, observed: ObservedBounds, declared: PublisherBounds): void {
    requireTrust(Array.isArray(value) && value.length >= 4, 'MPA polygon ring is invalid');
    for (const position of value) validatePosition(position, observed, declared);
    const first = value[0] as Position;
    const last = value[value.length - 1] as Position;
    requireTrust(first[0] === last[0] && first[1] === last[1], 'MPA polygon ring is not closed');
}

function validatePolygonCoordinates(value: unknown, observed: ObservedBounds, declared: PublisherBounds): void {
    requireTrust(Array.isArray(value) && value.length > 0, 'MPA polygon has no rings');
    for (const ring of value) validateRing(ring, observed, declared);
}

function validateText(value: unknown, label: string, allowEmpty: boolean): asserts value is string {
    requireTrust(typeof value === 'string' && value.length <= 300, `${label} must be a bounded string`);
    if (!allowEmpty) requireTrust(value.trim().length > 0, `${label} must not be empty`);
}

export function validateMpaGeoJson(value: unknown, manifest: MpaManifest): VerifiedMpaCollection {
    requireTrust(isRecord(value), 'MPA GeoJSON root must be an object');
    exactKeys(value, ['type', 'features']);
    requireTrust(
        value.type === 'FeatureCollection' && Array.isArray(value.features),
        'MPA asset is not a FeatureCollection',
    );
    requireTrust(
        value.features.length === manifest.dimensions.feature_count,
        'MPA feature count disagrees with the manifest',
    );
    const observed: ObservedBounds = {
        north: Number.NEGATIVE_INFINITY,
        south: Number.POSITIVE_INFINITY,
        west: Number.POSITIVE_INFINITY,
        east: Number.NEGATIVE_INFINITY,
        coordinateCount: 0,
    };
    for (let index = 0; index < value.features.length; index++) {
        const feature = value.features[index];
        requireTrust(isRecord(feature), `MPA feature ${index} must be an object`);
        exactKeys(feature, ['type', 'geometry', 'properties']);
        requireTrust(feature.type === 'Feature', `MPA feature ${index} has the wrong type`);
        requireTrust(isRecord(feature.geometry), `MPA feature ${index} has no geometry`);
        exactKeys(feature.geometry, ['type', 'coordinates']);
        if (feature.geometry.type === 'Polygon') {
            validatePolygonCoordinates(feature.geometry.coordinates, observed, manifest.bounds);
        } else if (feature.geometry.type === 'MultiPolygon') {
            requireTrust(
                Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length > 0,
                `MPA feature ${index} has an empty MultiPolygon`,
            );
            for (const polygon of feature.geometry.coordinates)
                validatePolygonCoordinates(polygon, observed, manifest.bounds);
        } else {
            throw new MarineDataTrustError(`MPA feature ${index} has an unsupported geometry type`);
        }
        requireTrust(isRecord(feature.properties), `MPA feature ${index} has no properties`);
        exactKeys(feature.properties, MPA_PROPERTY_KEYS);
        validateText(feature.properties.name, `MPA feature ${index} name`, false);
        for (const key of ['type', 'iucn', 'zone', 'authority', 'state'] as const) {
            validateText(feature.properties[key], `MPA feature ${index} ${key}`, true);
        }
        finiteNumber(feature.properties.area_km2, 0, 20_000_000, `MPA feature ${index} area`);
        requireTrust(feature.properties.area_km2 > 0, `MPA feature ${index} area must be positive`);
        requireTrust(
            typeof feature.properties.protection_class === 'string' &&
                ALLOWED_PROTECTION_CLASSES.has(feature.properties.protection_class),
            `MPA feature ${index} protection class is invalid`,
        );
        requireTrust(
            feature.properties.classification_source === 'indicative_heuristic',
            `MPA feature ${index} classification provenance is invalid`,
        );
    }
    requireTrust(observed.coordinateCount > 0, 'MPA asset contains no coordinates');
    for (const key of ['north', 'south', 'west', 'east'] as const) {
        requireTrust(
            Math.abs(observed[key] - manifest.bounds[key]) <= 0.001,
            `MPA observed ${key} bound disagrees with the manifest`,
        );
    }
    return value as unknown as VerifiedMpaCollection;
}

interface MpaCacheEntry {
    data: VerifiedMpaCollection;
    generation: string;
    manifestIdentity: string;
    checkedAt: number;
    sourceDate: string;
    publishedAt: string;
}

let cache: MpaCacheEntry | null = null;
let pending: { epoch: number; promise: Promise<VerifiedMpaCollection | null> } | null = null;
let ownershipEpoch = 0;
let activeController: AbortController | null = null;

/** Drop parsed GeoJSON ownership and abort any fetch that could repopulate it. */
export function releaseMpaDataset(): void {
    ownershipEpoch += 1;
    cache = null;
    pending = null;
    activeController?.abort(new Error('MPA layer released'));
    activeController = null;
}

export function clearMpaDatasetCache(): void {
    releaseMpaDataset();
}

export function getVerifiedMpaDatasetStatus(): { generation: string; sourceDate: string; publishedAt: string } | null {
    return cache
        ? { generation: cache.generation, sourceDate: cache.sourceDate, publishedAt: cache.publishedAt }
        : null;
}

export type BeforeMpaGenerationAsset = (nextGeneration: string) => void;

export async function fetchVerifiedMpaGeoJson(
    signal?: AbortSignal,
    beforeGenerationAsset?: BeforeMpaGenerationAsset,
): Promise<VerifiedMpaCollection | null> {
    if (signal?.aborted) return null;
    const nowMs = Date.now();
    if (cache && nowMs - cache.checkedAt < MPA_CACHE_TTL_MS) return cache.data;
    if (pending) return pending.promise;
    const epoch = ownershipEpoch;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    activeController = controller;

    const operation = doFetchVerifiedMpa(nowMs, epoch, controller.signal, beforeGenerationAsset).catch((error) => {
        if (ownershipEpoch === epoch) cache = null;
        log.warn('MPA dataset rejected; clearing the overlay until a verified refresh succeeds', error);
        return null;
    });
    pending = { epoch, promise: operation };
    try {
        return await operation;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        if (pending?.promise === operation) pending = null;
        if (activeController === controller) activeController = null;
    }
}

function requireActiveOwnership(epoch: number, signal: AbortSignal): void {
    requireTrust(ownershipEpoch === epoch && !signal.aborted, 'MPA dataset ownership was released');
}

async function doFetchVerifiedMpa(
    nowMs: number,
    epoch: number,
    signal: AbortSignal,
    beforeGenerationAsset?: BeforeMpaGenerationAsset,
): Promise<VerifiedMpaCollection> {
    requireActiveOwnership(epoch, signal);
    const manifestBytes = await fetchBoundedPublisherBytes(
        `${API_BASE}/mpa/manifest-v2.json`,
        MANIFEST_MAX_BYTES,
        'application/json',
        signal,
    );
    requireActiveOwnership(epoch, signal);
    const manifest = validateMpaManifest(decodeUtf8Json(manifestBytes), nowMs);
    const suffix = await publisherGenerationSuffix(manifest.data_start, 'mpa', [manifest.files[0].sha256]);
    requireTrust(manifest.generation.endsWith(`-${suffix}`), 'MPA generation does not bind its asset hash');
    const manifestIdentity = immutableManifestIdentity(manifest);
    if (cache?.generation === manifest.generation) {
        requireTrust(cache.manifestIdentity === manifestIdentity, 'a supposedly immutable MPA manifest changed');
        requireActiveOwnership(epoch, signal);
        cache.checkedAt = nowMs;
        cache.sourceDate = manifest.data_start;
        cache.publishedAt = manifest.published_at;
        return cache.data;
    }

    if (cache) {
        // Do not own two parsed CAPAD generations while a replacement asset
        // is downloaded and decoded. The map lifecycle callback removes its
        // old GeoJSON source synchronously; clearing our cache then lets that
        // generation become collectible during the network wait.
        beforeGenerationAsset?.(manifest.generation);
        cache = null;
        requireActiveOwnership(epoch, signal);
    }
    const file = manifest.files[0];
    const asset = await fetchBoundedPublisherBytes(
        `${API_BASE}/mpa/${file.filename}`,
        Math.min(file.bytes, MPA_ASSET_MAX_BYTES),
        file.content_type,
        signal,
        'force-cache',
    );
    await verifyPublisherAsset(asset, file.bytes, file.sha256, 'MPA asset');
    const data = validateMpaGeoJson(decodeUtf8Json(asset), manifest);
    requireActiveOwnership(epoch, signal);
    cache = {
        data,
        generation: manifest.generation,
        manifestIdentity,
        checkedAt: nowMs,
        sourceDate: manifest.data_start,
        publishedAt: manifest.published_at,
    };
    return data;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function immutableManifestIdentity(manifest: MpaManifest): string {
    return canonicalJson({
        dataset: manifest.dataset,
        generation: manifest.generation,
        data_start: manifest.data_start,
        data_end: manifest.data_end,
        cadence_hours: manifest.cadence_hours,
        dimensions: manifest.dimensions,
        bounds: manifest.bounds,
        files: manifest.files,
        metadata: manifest.metadata ?? null,
    });
}

// Compile-time evidence that the validated collection can be handed to Mapbox
// as an in-memory GeoJSON object without weakening it to `any`.
const _featureShape: Feature<Polygon | MultiPolygon, MpaProperties> | undefined = undefined;
void _featureShape;
