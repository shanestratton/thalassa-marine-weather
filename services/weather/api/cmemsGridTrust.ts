/**
 * Fail-closed client contract for the immutable CMEMS schema-v2 bundles.
 *
 * Nothing from the release publisher is handed to a WebGL layer until the
 * manifest, every declared byte, every checksum, and every THCU value plane
 * has been validated.  Downloads are streamed through hard limits before a
 * large ArrayBuffer/typed array can be allocated.
 */
import type { WindGrid } from '../windField';
import { API_BASE } from '../../native/apiBase';
import { createLogger } from '../../../utils/createLogger';
import { validateMarineManifest } from './marineManifestContract';

const log = createLogger('cmemsGridTrust');

export const MANIFEST_MAX_BYTES = 256 * 1024;
export const CMEMS_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const THCU_HEADER_BYTES = 30;
export const CMEMS_CACHE_TTL_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 45_000;
const MAGIC = 0x55434854; // ASCII THCU as a little-endian u32.
const GENERATION_RE = /^g-\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

interface DatasetContract {
    id: string;
    steps: number;
    cadenceHours: 1 | 3 | 24;
    maxSourceAgeHours: 12 | 15 | 48;
    kind: 'vector' | 'waves' | 'sst' | 'normalised';
    frameBudgetBytes: number;
}

export const CMEMS_DATASETS = {
    currents: {
        id: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
        steps: 13,
        cadenceHours: 1,
        maxSourceAgeHours: 12,
        kind: 'vector',
        frameBudgetBytes: 12 * 1024 * 1024,
    },
    waves: {
        id: 'cmems_mod_glo_wav_anfc_0.083deg_PT3H-i',
        steps: 17,
        cadenceHours: 3,
        // The publisher runs every 12h; one 3h product-cadence margin avoids
        // a deterministic processing-time gap before the next atomic publish.
        maxSourceAgeHours: 15,
        kind: 'waves',
        frameBudgetBytes: 12 * 1024 * 1024,
    },
    sst: {
        id: 'cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m',
        steps: 6,
        cadenceHours: 24,
        maxSourceAgeHours: 48,
        kind: 'sst',
        frameBudgetBytes: 8 * 1024 * 1024,
    },
    chl: {
        id: 'cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m',
        steps: 6,
        cadenceHours: 24,
        maxSourceAgeHours: 48,
        kind: 'normalised',
        frameBudgetBytes: 8 * 1024 * 1024,
    },
    seaice: {
        id: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',
        steps: 6,
        cadenceHours: 24,
        maxSourceAgeHours: 48,
        kind: 'normalised',
        frameBudgetBytes: 8 * 1024 * 1024,
    },
    mld: {
        id: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',
        steps: 6,
        cadenceHours: 24,
        maxSourceAgeHours: 48,
        kind: 'normalised',
        frameBudgetBytes: 8 * 1024 * 1024,
    },
} as const satisfies Record<string, DatasetContract>;

export type CmemsDatasetKey = keyof typeof CMEMS_DATASETS;

export interface PublisherBounds {
    north: number;
    south: number;
    west: number;
    east: number;
}

export interface CmemsManifestFile {
    step: number;
    offset_hours: number;
    data_time: string;
    filename: string;
    bytes: number;
    sha256: string;
    content_type: 'application/octet-stream';
}

export interface CmemsManifest {
    schema_version: 2;
    dataset: { key: CmemsDatasetKey; id: string };
    generation: string;
    generated_at: string;
    published_at: string;
    data_start: string;
    data_end: string;
    cadence_hours: number;
    dimensions: { width: number; height: number };
    bounds: PublisherBounds;
    producer: { commit: string; run_id: number; run_attempt: number };
    files: CmemsManifestFile[];
    metadata?: Record<string, unknown>;
}

export class MarineDataTrustError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MarineDataTrustError';
    }
}

function requireTrust(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MarineDataTrustError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
    label = 'object',
): void {
    const actual = Object.keys(value).sort();
    const allowed = new Set([...required, ...optional]);
    requireTrust(
        required.every((key) => Object.hasOwn(value, key)),
        `${label} is missing required fields`,
    );
    requireTrust(
        actual.every((key) => allowed.has(key)),
        `${label} contains unexpected fields`,
    );
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
    requireTrust(
        Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum,
        `${label} is invalid`,
    );
}

function requireFinite(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
    requireTrust(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`);
    requireTrust(value >= minimum && value <= maximum, `${label} is outside its allowed range`);
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

function nearlyEqual(a: number, b: number, epsilon = 0.00002): boolean {
    return Math.abs(a - b) <= epsilon;
}

/** Parse and validate an untrusted CMEMS schema-v2 manifest. */
export function validateCmemsManifest(
    value: unknown,
    expectedDataset: CmemsDatasetKey,
    nowMs = Date.now(),
): CmemsManifest {
    try {
        validateMarineManifest(value, expectedDataset, nowMs, true);
    } catch (error) {
        throw new MarineDataTrustError(
            error instanceof Error ? error.message : 'manifest violates the shared contract',
        );
    }
    requireTrust(isRecord(value), 'manifest root must be an object');
    requireExactKeys(
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
        'manifest',
    );
    requireTrust(value.schema_version === 2, 'manifest schema_version must be exactly 2');

    const spec = CMEMS_DATASETS[expectedDataset];
    requireTrust(isRecord(value.dataset), 'manifest dataset must be an object');
    requireExactKeys(value.dataset, ['key', 'id'], [], 'manifest dataset');
    requireTrust(
        value.dataset.key === expectedDataset && value.dataset.id === spec.id,
        'manifest dataset identity does not match the requested layer',
    );

    requireTrust(typeof value.generation === 'string' && GENERATION_RE.test(value.generation), 'invalid generation');
    const generatedAt = parseUtc(value.generated_at, 'generated_at');
    const publishedAt = parseUtc(value.published_at, 'published_at');
    const dataStart = parseUtc(value.data_start, 'data_start');
    const dataEnd = parseUtc(value.data_end, 'data_end');
    requireTrust(
        value.generation.slice(2, 18) === compactUtc(dataStart),
        'generation timestamp does not match data_start',
    );
    requireTrust(generatedAt >= dataStart, 'generated_at precedes source data');
    requireTrust(publishedAt >= generatedAt, 'published_at precedes generated_at');
    requireTrust(generatedAt <= nowMs + 15 * 60 * 1000, 'generated_at is implausibly in the future');
    requireTrust(publishedAt <= nowMs + 15 * 60 * 1000, 'published_at is implausibly in the future');
    requireTrust(dataStart <= nowMs && dataEnd >= nowMs, 'dataset does not cover the current time');
    requireTrust(nowMs - dataStart <= spec.maxSourceAgeHours * HOUR_MS, 'dataset source time is stale');
    requireTrust(
        dataEnd - dataStart === (spec.steps - 1) * spec.cadenceHours * HOUR_MS,
        'dataset coverage window violates its exact cadence',
    );
    requireTrust(value.cadence_hours === spec.cadenceHours, 'manifest cadence does not match the dataset contract');

    requireTrust(isRecord(value.dimensions), 'manifest dimensions must be an object');
    requireExactKeys(value.dimensions, ['width', 'height'], [], 'manifest dimensions');
    requireInteger(value.dimensions.width, 1300, 1500, 'manifest width');
    requireInteger(value.dimensions.height, 600, 750, 'manifest height');
    const cellCount = value.dimensions.width * value.dimensions.height;
    requireTrust(cellCount <= 1_125_000, 'manifest grid is too large');

    requireTrust(isRecord(value.bounds), 'manifest bounds must be an object');
    requireExactKeys(value.bounds, ['north', 'south', 'west', 'east'], [], 'manifest bounds');
    requireFinite(value.bounds.north, -90, 90, 'north bound');
    requireFinite(value.bounds.south, -90, 90, 'south bound');
    requireFinite(value.bounds.west, -180, 180, 'west bound');
    requireFinite(value.bounds.east, -180, 180, 'east bound');
    requireTrust(
        value.bounds.north > value.bounds.south && value.bounds.east > value.bounds.west,
        'bounds are not oriented',
    );
    requireTrust(
        value.bounds.north >= 89 && value.bounds.south <= -79 && value.bounds.west <= -179 && value.bounds.east >= 179,
        'manifest does not describe a global marine grid',
    );
    const lonStep = (value.bounds.east - value.bounds.west) / (value.dimensions.width - 1);
    const latStep = (value.bounds.north - value.bounds.south) / (value.dimensions.height - 1);
    requireTrust(
        lonStep >= 0.23 && lonStep <= 0.27 && latStep >= 0.23 && latStep <= 0.27,
        'grid resolution is implausible',
    );

    requireTrust(isRecord(value.producer), 'manifest producer must be an object');
    requireExactKeys(value.producer, ['commit', 'run_id', 'run_attempt'], [], 'manifest producer');
    requireTrust(
        typeof value.producer.commit === 'string' && COMMIT_RE.test(value.producer.commit),
        'invalid producer commit',
    );
    requireInteger(value.producer.run_id, 1, Number.MAX_SAFE_INTEGER, 'producer run_id');
    requireInteger(value.producer.run_attempt, 1, Number.MAX_SAFE_INTEGER, 'producer run_attempt');
    if (value.metadata !== undefined) requireTrust(isRecord(value.metadata), 'manifest metadata must be an object');

    requireTrust(Array.isArray(value.files) && value.files.length === spec.steps, 'manifest file count is wrong');
    const exactBytes = THCU_HEADER_BYTES + cellCount * 9;
    requireTrust(exactBytes <= CMEMS_ASSET_MAX_BYTES, 'declared grid exceeds the client byte ceiling');
    const seenNames = new Set<string>();
    for (let step = 0; step < value.files.length; step++) {
        const entry = value.files[step];
        requireTrust(isRecord(entry), `files[${step}] must be an object`);
        requireExactKeys(
            entry,
            ['step', 'offset_hours', 'data_time', 'filename', 'bytes', 'sha256', 'content_type'],
            [],
            `files[${step}]`,
        );
        requireTrust(entry.step === step, `files[${step}] is not contiguous`);
        requireTrust(entry.offset_hours === step * spec.cadenceHours, `files[${step}] has the wrong offset`);
        const entryTime = parseUtc(entry.data_time, `files[${step}].data_time`);
        requireTrust(
            entryTime === dataStart + step * spec.cadenceHours * HOUR_MS,
            `files[${step}] has the wrong source time`,
        );
        const expectedName = `${value.generation}-h${String(step).padStart(3, '0')}.bin`;
        requireTrust(
            entry.filename === expectedName && !seenNames.has(expectedName),
            `files[${step}] has an unsafe filename`,
        );
        seenNames.add(expectedName);
        requireTrust(entry.bytes === exactBytes, `files[${step}] byte count disagrees with dimensions`);
        requireTrust(
            typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256),
            `files[${step}] has an invalid SHA-256`,
        );
        requireTrust(entry.content_type === 'application/octet-stream', `files[${step}] has the wrong content type`);
    }

    return value as unknown as CmemsManifest;
}

function responseContentType(response: Response): string {
    return (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
    try {
        await response.body?.cancel(new MarineDataTrustError(reason));
    } catch {
        // A rejection from an upstream stream's cancellation hook must not
        // replace the deterministic trust error that caused the rejection.
    }
}

async function rejectBeforeBodyRead(response: Response, message: string): Promise<never> {
    await cancelResponseBody(response, message);
    throw new MarineDataTrustError(message);
}

/**
 * Read a response body into one bounded allocation.
 *
 * Immutable asset callers pass the manifest's exact byte count as `maxBytes`,
 * so a valid 6–9 MiB frame never needs both a retained chunk list and a second
 * joined copy. Manifest callers reserve only the 256 KiB manifest ceiling.
 */
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        await rejectBeforeBodyRead(response, 'response byte ceiling is invalid');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null) {
        if (!/^\d+$/.test(declared)) {
            await rejectBeforeBodyRead(response, 'response Content-Length is invalid');
        }
        if (Number(declared) > maxBytes) {
            await rejectBeforeBodyRead(response, 'response exceeds its byte ceiling');
        }
    }
    requireTrust(response.body !== null, 'response has no body');
    const reader = response.body.getReader();
    const output = new Uint8Array(maxBytes);
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            requireTrust(total + value.byteLength <= maxBytes, 'response exceeded its byte ceiling while streaming');
            output.set(value, total);
            total += value.byteLength;
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    return total === output.byteLength ? output : output.slice(0, total);
}

export async function fetchBoundedPublisherBytes(
    url: string,
    maxBytes: number,
    expectedContentType: string,
    signal?: AbortSignal,
    cache: RequestCache = 'no-store',
): Promise<Uint8Array> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    const timeout = setTimeout(() => controller.abort(new Error('marine dataset fetch timed out')), FETCH_TIMEOUT_MS);
    try {
        if (controller.signal.aborted) {
            throw controller.signal.reason ?? new MarineDataTrustError('dataset request was aborted before fetch');
        }
        const response = await fetch(url, { cache, signal: controller.signal });
        if (!response.ok) {
            await rejectBeforeBodyRead(response, `dataset request failed with HTTP ${response.status}`);
        }
        if (responseContentType(response) !== expectedContentType) {
            await rejectBeforeBodyRead(response, 'dataset response has the wrong content type');
        }
        return await readBoundedResponse(response, maxBytes);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
    }
}

export function decodeUtf8Json(bytes: Uint8Array): unknown {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new MarineDataTrustError('manifest is not valid UTF-8');
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new MarineDataTrustError('manifest is not valid JSON');
    }
}

/** Browser-native SHA-256 with a deterministic cryptographic fallback for tests/older webviews. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    try {
        const subtle = globalThis.crypto?.subtle;
        if (subtle) {
            // `readBoundedResponse` and TextEncoder both return full
            // ArrayBuffer-backed views in the hot path. Reuse that view so a
            // verified marine frame is not copied in full merely to hash it.
            const input =
                bytes.buffer instanceof ArrayBuffer &&
                bytes.byteOffset === 0 &&
                bytes.byteLength === bytes.buffer.byteLength
                    ? (bytes as Uint8Array<ArrayBuffer>)
                    : bytes.slice();
            const digest = new Uint8Array(await subtle.digest('SHA-256', input));
            return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        }
    } catch {
        // Fall through to the dependency-free implementation below.
    }
    return sha256Fallback(bytes);
}

/** Exact cross-language counterpart of publisher_contract.py `_generation`. */
export async function publisherGenerationSuffix(
    dataStart: string,
    dataset: CmemsDatasetKey | 'mpa',
    hashes: readonly string[],
): Promise<string> {
    const material = new TextEncoder().encode(JSON.stringify({ data_start: dataStart, dataset, sha256: [...hashes] }));
    return (await sha256Hex(material)).slice(0, 12);
}

export async function verifyPublisherAsset(
    bytes: Uint8Array,
    expectedBytes: number,
    expectedSha256: string,
    label: string,
): Promise<void> {
    requireTrust(bytes.byteLength === expectedBytes, `${label} response length does not match its declaration`);
    requireTrust((await sha256Hex(bytes)) === expectedSha256, `${label} SHA-256 mismatch`);
}

function sha256Fallback(input: Uint8Array): string {
    const constants = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ]);
    const bitLength = input.byteLength * 8;
    const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(input);
    padded[input.byteLength] = 0x80;
    const paddedView = new DataView(padded.buffer);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    paddedView.setUint32(paddedLength - 8, high, false);
    paddedView.setUint32(paddedLength - 4, low, false);

    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));
    for (let block = 0; block < paddedLength; block += 64) {
        for (let index = 0; index < 16; index++) words[index] = paddedView.getUint32(block + index * 4, false);
        for (let index = 16; index < 64; index++) {
            const a = words[index - 15];
            const b = words[index - 2];
            const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
            const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index++) {
            const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
            const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }
    return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

export interface DecodedThcuStep {
    u: Float32Array;
    /** Present only for vector products. Scalar products validate but do not retain their all-zero v plane. */
    v?: Float32Array;
    landMask: Uint8Array;
}

/** Validate and decode one exact THCU v2 file without trusting header sizes. */
export function decodeThcuV2(bytes: Uint8Array, manifest: CmemsManifest, file: CmemsManifestFile): DecodedThcuStep {
    requireTrust(bytes.byteLength === file.bytes, `step ${file.step} response length does not match the manifest`);
    requireTrust(bytes.byteLength >= THCU_HEADER_BYTES, `step ${file.step} has a truncated THCU header`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    requireTrust(view.getUint32(0, true) === MAGIC, `step ${file.step} has bad THCU magic`);
    requireTrust(view.getUint8(4) === 2, `step ${file.step} is not THCU v2`);
    requireTrust(view.getUint8(5) === 0, `step ${file.step} has a non-zero reserved header byte`);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    requireTrust(
        width === manifest.dimensions.width && height === manifest.dimensions.height,
        `step ${file.step} dimensions disagree with the manifest`,
    );
    const cells = width * height;
    requireTrust(cells > 0 && cells <= 1_125_000, `step ${file.step} cell count is unsafe`);
    requireTrust(
        bytes.byteLength === THCU_HEADER_BYTES + cells * 9,
        `step ${file.step} has an invalid exact byte length`,
    );
    const headerBounds: PublisherBounds = {
        north: view.getFloat32(10, true),
        south: view.getFloat32(14, true),
        west: view.getFloat32(18, true),
        east: view.getFloat32(22, true),
    };
    for (const key of ['north', 'south', 'west', 'east'] as const) {
        requireTrust(Number.isFinite(headerBounds[key]), `step ${file.step} has non-finite bounds`);
        requireTrust(
            nearlyEqual(headerBounds[key], manifest.bounds[key]),
            `step ${file.step} bounds disagree with the manifest`,
        );
    }
    requireTrust(
        headerBounds.north > headerBounds.south && headerBounds.east > headerBounds.west,
        `step ${file.step} bounds are not oriented`,
    );
    requireTrust(view.getUint16(26, true) === 1, `step ${file.step} must contain exactly one layer`);
    requireTrust(view.getUint16(28, true) === 0, `step ${file.step} has a non-zero reserved header field`);

    const kind = CMEMS_DATASETS[manifest.dataset.key].kind;
    const retainV = kind === 'vector' || kind === 'waves';
    const u = new Float32Array(cells);
    const v = retainV ? new Float32Array(cells) : undefined;
    const uOffset = THCU_HEADER_BYTES;
    const vOffset = uOffset + cells * 4;
    const maskOffset = vOffset + cells * 4;
    const landMask = bytes.slice(maskOffset, maskOffset + cells);
    let oceanCells = 0;
    let oceanMin = Number.POSITIVE_INFINITY;
    let oceanMax = Number.NEGATIVE_INFINITY;
    let maxMagnitude = 0;
    for (let index = 0; index < cells; index++) {
        const mask = landMask[index];
        requireTrust(mask === 0 || mask === 1, `step ${file.step} land mask is not binary`);
        const uValue = view.getFloat32(uOffset + index * 4, true);
        const vValue = view.getFloat32(vOffset + index * 4, true);
        requireTrust(
            Number.isFinite(uValue) && Number.isFinite(vValue),
            `step ${file.step} contains a non-finite value`,
        );
        if (kind === 'vector') {
            requireTrust(
                uValue >= -8 && uValue <= 8 && vValue >= -8 && vValue <= 8,
                `step ${file.step} contains an implausible current`,
            );
        } else if (kind === 'waves') {
            const magnitude = Math.hypot(uValue, vValue);
            requireTrust(magnitude >= 0 && magnitude <= 40.01, `step ${file.step} contains an implausible wave height`);
        } else if (kind === 'sst') {
            requireTrust(
                uValue >= -3 && uValue <= 45 && Math.abs(vValue) <= 1e-7,
                `step ${file.step} contains an implausible SST value`,
            );
        } else {
            requireTrust(
                uValue >= 0 && uValue <= 1 && Math.abs(vValue) <= 1e-7,
                `step ${file.step} contains an implausible normalised value`,
            );
        }
        u[index] = uValue;
        if (v) v[index] = vValue;
        const magnitude = kind === 'vector' || kind === 'waves' ? Math.hypot(uValue, vValue) : 0;
        if (mask === 0) {
            oceanCells += 1;
            oceanMin = Math.min(oceanMin, uValue);
            oceanMax = Math.max(oceanMax, uValue);
            maxMagnitude = Math.max(maxMagnitude, kind === 'vector' || kind === 'waves' ? magnitude : Math.abs(uValue));
        }
    }
    const oceanFraction = oceanCells / cells;
    requireTrust(oceanFraction >= 0.4 && oceanFraction <= 0.98, `step ${file.step} has an implausible ocean mask`);
    requireTrust(oceanMax - oceanMin > 1e-7 || maxMagnitude > 1e-7, `step ${file.step} has no meaningful ocean values`);
    return { u, ...(v ? { v } : {}), landMask };
}

async function fetchVerifiedManifest(
    dataset: CmemsDatasetKey,
    nowMs: number,
    signal?: AbortSignal,
): Promise<CmemsManifest> {
    const bytes = await fetchBoundedPublisherBytes(
        `${API_BASE}/${dataset}/manifest-v2.json`,
        MANIFEST_MAX_BYTES,
        'application/json',
        signal,
    );
    return validateCmemsManifest(decodeUtf8Json(bytes), dataset, nowMs);
}

interface ManifestCacheEntry {
    manifest: CmemsManifest;
    generation: string;
    manifestIdentity: string;
    checkedAt: number;
    dataEnd: number;
}

interface FrameCacheEntry {
    dataset: CmemsDatasetKey;
    generation: string;
    step: number;
    grid: WindGrid;
    decodedBytes: number;
}

interface MaskCacheEntry {
    generation: string;
    mask: Uint8Array;
}

interface InflightFrameEntry {
    epoch: number;
    promise: Promise<WindGrid | null>;
}

export const CMEMS_FRAME_CACHE_LIMIT = 2;
export const CMEMS_FRAME_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const manifestCache = new Map<CmemsDatasetKey, ManifestCacheEntry>();
const manifestInflight = new Map<CmemsDatasetKey, Promise<CmemsManifest>>();
const frameCache = new Map<string, FrameCacheEntry>();
const maskCache = new Map<CmemsDatasetKey, MaskCacheEntry>();
const inflightFrames = new Map<string, InflightFrameEntry>();
const releaseEpochs = new Map<CmemsDatasetKey, number>();
const activeAssetControllers = new Map<CmemsDatasetKey, Set<AbortController>>();
let loadQueue: Promise<void> = Promise.resolve();

function frameCacheKey(dataset: CmemsDatasetKey, generation: string, step: number): string {
    return `${dataset}:${generation}:${step}`;
}

function releaseEpoch(dataset: CmemsDatasetKey): number {
    return releaseEpochs.get(dataset) ?? 0;
}

function evictDecodedFrames(dataset: CmemsDatasetKey, bumpEpoch: boolean): void {
    if (bumpEpoch) releaseEpochs.set(dataset, releaseEpoch(dataset) + 1);
    for (const [key, entry] of frameCache) {
        if (entry.dataset === dataset) frameCache.delete(key);
    }
    maskCache.delete(dataset);
    const controllers = activeAssetControllers.get(dataset);
    if (controllers) {
        for (const controller of controllers) controller.abort(new Error(`${dataset} frame was released`));
        activeAssetControllers.delete(dataset);
    }
}

/** Release all decoded map-frame ownership for one product. Safe to call repeatedly. */
export function releaseCmemsGrid(dataset: CmemsDatasetKey): void {
    evictDecodedFrames(dataset, true);
}

/** Test helper; production callers release individual products as layers hide. */
export function clearCmemsGridCache(): void {
    for (const dataset of Object.keys(CMEMS_DATASETS) as CmemsDatasetKey[]) releaseCmemsGrid(dataset);
    manifestCache.clear();
    manifestInflight.clear();
    inflightFrames.clear();
}

async function verifiedManifest(dataset: CmemsDatasetKey, nowMs: number): Promise<CmemsManifest> {
    const cached = manifestCache.get(dataset);
    if (cached && nowMs - cached.checkedAt < CMEMS_CACHE_TTL_MS && nowMs <= cached.dataEnd) {
        return cached.manifest;
    }
    const pending = manifestInflight.get(dataset);
    if (pending) return pending;

    const operation = (async () => {
        const manifest = await fetchVerifiedManifest(dataset, nowMs);
        const suffix = await publisherGenerationSuffix(
            manifest.data_start,
            dataset,
            manifest.files.map((file) => file.sha256),
        );
        requireTrust(manifest.generation.endsWith(`-${suffix}`), 'generation does not bind the declared asset hashes');
        const identity = immutableCmemsManifestIdentity(manifest);
        const previous = manifestCache.get(dataset);
        if (previous?.generation === manifest.generation) {
            requireTrust(previous.manifestIdentity === identity, 'a supposedly immutable generation manifest changed');
        } else if (previous) {
            // A generation switch invalidates only decoded frames. The old
            // manifest is tiny and is replaced below without retaining a
            // reference to any large typed arrays.
            evictDecodedFrames(dataset, false);
        }
        manifestCache.set(dataset, {
            manifest,
            generation: manifest.generation,
            manifestIdentity: identity,
            checkedAt: nowMs,
            dataEnd: Date.parse(manifest.data_end),
        });
        return manifest;
    })();
    manifestInflight.set(dataset, operation);
    try {
        return await operation;
    } finally {
        if (manifestInflight.get(dataset) === operation) manifestInflight.delete(dataset);
    }
}

/** Manifest-only metadata path for scrubber timing; never downloads a THCU asset. */
export async function fetchCmemsManifest(dataset: CmemsDatasetKey): Promise<CmemsManifest | null> {
    try {
        return await verifiedManifest(dataset, Date.now());
    } catch (error) {
        log.warn(`${dataset} manifest rejected`, error);
        return null;
    }
}

function registerAssetController(dataset: CmemsDatasetKey): AbortController {
    const controller = new AbortController();
    const controllers = activeAssetControllers.get(dataset) ?? new Set<AbortController>();
    controllers.add(controller);
    activeAssetControllers.set(dataset, controllers);
    return controller;
}

function unregisterAssetController(dataset: CmemsDatasetKey, controller: AbortController): void {
    const controllers = activeAssetControllers.get(dataset);
    controllers?.delete(controller);
    if (controllers?.size === 0) activeAssetControllers.delete(dataset);
}

function trustedMaskForFrame(
    dataset: CmemsDatasetKey,
    generation: string,
    candidate: Uint8Array,
    step: number,
): Uint8Array {
    const cached = maskCache.get(dataset);
    if (!cached || cached.generation !== generation) {
        maskCache.set(dataset, { generation, mask: candidate });
        return candidate;
    }
    requireTrust(cached.mask.length === candidate.length, `step ${step} mask dimensions changed`);
    for (let index = 0; index < cached.mask.length; index++) {
        requireTrust(cached.mask[index] === candidate[index], `step ${step} land mask changed`);
    }
    return cached.mask;
}

function buildSparseGrid(
    manifest: CmemsManifest,
    steps: ReadonlyMap<number, Pick<DecodedThcuStep, 'u' | 'v'>>,
    landMask: Uint8Array,
    nowMs: number,
    sourceStep?: number,
): WindGrid {
    const totalSteps = manifest.files.length;
    const us = new Array<Float32Array>(totalSteps);
    const vs = new Array<Float32Array>(totalSteps);
    for (const [step, decoded] of steps) {
        us[step] = decoded.u;
        if (decoded.v) vs[step] = decoded.v;
    }
    const { width, height } = manifest.dimensions;
    const { north, south, west, east } = manifest.bounds;
    const offsets = manifest.files.map((file) => file.offset_hours);
    return {
        u: us,
        v: vs,
        // CMEMS renderers derive magnitude only for the selected frame. Do
        // not retain a third full Float32 plane for every product/step.
        speed: new Array<Float32Array>(totalSteps),
        width,
        height,
        lats: Array.from({ length: height }, (_, row) => north + (row * (south - north)) / (height - 1)),
        lons: Array.from({ length: width }, (_, column) => west + (column * (east - west)) / (width - 1)),
        north,
        south,
        west,
        east,
        totalHours: totalSteps,
        landMask,
        hourOffsets: offsets,
        stepHours: offsets,
        refTime: manifest.data_start,
        sourceGeneration: manifest.generation,
        sourceStep,
        validUntil: manifest.data_end,
        verifiedAt: new Date(nowMs).toISOString(),
    };
}

function touchFrame(key: string, entry: FrameCacheEntry): WindGrid {
    frameCache.delete(key);
    frameCache.set(key, entry);
    return entry.grid;
}

function deleteFrameAndOrphanMask(key: string): void {
    const entry = frameCache.get(key);
    if (!entry) return;
    frameCache.delete(key);
    const datasetStillRetained = [...frameCache.values()].some(
        (candidate) => candidate.dataset === entry.dataset && candidate.generation === entry.generation,
    );
    if (!datasetStillRetained && maskCache.get(entry.dataset)?.generation === entry.generation) {
        maskCache.delete(entry.dataset);
    }
}

function enforceFrameCacheBounds(): void {
    const retained = () => getCmemsGridCacheStats().retainedBytes;
    while (frameCache.size > CMEMS_FRAME_CACHE_LIMIT || retained() > CMEMS_FRAME_CACHE_MAX_BYTES) {
        const oldestKey = frameCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        deleteFrameAndOrphanMask(oldestKey);
    }
}

/** Test/diagnostic snapshot; counts only strong references owned by this module. */
export function getCmemsGridCacheStats(): {
    frames: number;
    frameBytes: number;
    maskBytes: number;
    retainedBytes: number;
    keys: string[];
} {
    const frameBytes = [...frameCache.values()].reduce((sum, entry) => sum + entry.decodedBytes, 0);
    const maskBytes = [...maskCache.values()].reduce((sum, entry) => sum + entry.mask.byteLength, 0);
    return {
        frames: frameCache.size,
        frameBytes,
        maskBytes,
        retainedBytes: frameBytes + maskBytes,
        keys: [...frameCache.keys()],
    };
}

/**
 * Load one verified frame for map display. The returned WindGrid is sparse:
 * metadata covers the whole time axis, but only `sourceStep` owns u/v planes.
 */
export async function fetchCmemsGrid(dataset: CmemsDatasetKey, requestedStep = 0): Promise<WindGrid | null> {
    if (!Number.isInteger(requestedStep) || requestedStep < 0 || requestedStep >= CMEMS_DATASETS[dataset].steps) {
        log.warn(`${dataset} frame request rejected: invalid step ${requestedStep}`);
        releaseCmemsGrid(dataset);
        return null;
    }
    const epoch = releaseEpoch(dataset);
    const requestKey = `${dataset}:${requestedStep}:e${epoch}`;
    const pending = inflightFrames.get(requestKey);
    if (pending?.epoch === epoch) return pending.promise;

    const nowMs = Date.now();
    const operation = loadQueue
        .catch(() => undefined)
        .then(() => fetchAndValidateFrame(dataset, requestedStep, nowMs, epoch))
        .catch((error) => {
            // Do not let an already-aborted old request invalidate a newer
            // request started after releaseCmemsGrid().
            if (releaseEpoch(dataset) === epoch) releaseCmemsGrid(dataset);
            log.warn(`${dataset} frame ${requestedStep} rejected`, error);
            return null;
        });
    inflightFrames.set(requestKey, { epoch, promise: operation });
    loadQueue = operation.then(() => undefined);
    try {
        return await operation;
    } finally {
        if (inflightFrames.get(requestKey)?.promise === operation) inflightFrames.delete(requestKey);
    }
}

async function fetchAndValidateFrame(
    dataset: CmemsDatasetKey,
    requestedStep: number,
    nowMs: number,
    epoch: number,
): Promise<WindGrid> {
    requireTrust(releaseEpoch(dataset) === epoch, `${dataset} frame request was released`);
    const manifest = await verifiedManifest(dataset, nowMs);
    requireTrust(releaseEpoch(dataset) === epoch, `${dataset} frame request was released`);
    requireInteger(requestedStep, 0, manifest.files.length - 1, 'requested CMEMS step');
    assertCmemsFrameMemoryBudget(manifest);

    const key = frameCacheKey(dataset, manifest.generation, requestedStep);
    const cached = frameCache.get(key);
    if (cached) {
        cached.grid.verifiedAt = new Date(nowMs).toISOString();
        cached.grid.validUntil = manifest.data_end;
        return touchFrame(key, cached);
    }

    const file = manifest.files[requestedStep];
    const controller = registerAssetController(dataset);
    try {
        const bytes = await fetchBoundedPublisherBytes(
            `${API_BASE}/${dataset}/${file.filename}`,
            Math.min(file.bytes, CMEMS_ASSET_MAX_BYTES),
            file.content_type,
            controller.signal,
            'force-cache',
        );
        await verifyPublisherAsset(bytes, file.bytes, file.sha256, `step ${file.step}`);
        const decoded = decodeThcuV2(bytes, manifest, file);
        if (CMEMS_DATASETS[dataset].kind === 'vector' || CMEMS_DATASETS[dataset].kind === 'waves') {
            requireTrust(decoded.v !== undefined, `step ${file.step} is missing its vector v plane`);
        }
        requireTrust(releaseEpoch(dataset) === epoch, `${dataset} frame request was released`);
        const trustedMask = trustedMaskForFrame(dataset, manifest.generation, decoded.landMask, file.step);
        const grid = buildSparseGrid(manifest, new Map([[requestedStep, decoded]]), trustedMask, nowMs, requestedStep);
        const entry: FrameCacheEntry = {
            dataset,
            generation: manifest.generation,
            step: requestedStep,
            grid,
            decodedBytes: decoded.u.byteLength + (decoded.v?.byteLength ?? 0),
        };
        frameCache.set(key, entry);
        enforceFrameCacheBounds();
        log.info(`Loaded verified ${dataset} generation ${manifest.generation} frame ${requestedStep}`);
        return grid;
    } finally {
        unregisterAssetController(dataset, controller);
    }
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

export function immutableCmemsManifestIdentity(manifest: CmemsManifest): string {
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

export function assertCmemsFrameMemoryBudget(manifest: CmemsManifest): void {
    const cells = manifest.dimensions.width * manifest.dimensions.height;
    const kind = CMEMS_DATASETS[manifest.dataset.key].kind;
    const decodedBytes = cells * (kind === 'vector' || kind === 'waves' ? 9 : 5);
    requireTrust(
        decodedBytes <= CMEMS_DATASETS[manifest.dataset.key].frameBudgetBytes,
        `${manifest.dataset.key} frame decoded-memory budget would be exceeded`,
    );
}
