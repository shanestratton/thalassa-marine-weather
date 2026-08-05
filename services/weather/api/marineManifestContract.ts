/**
 * Runtime-neutral schema-v2 manifest contract shared by the released clients,
 * the release proxy and the hosted release verifier.
 *
 * Keep this module dependency-free: it is executed in browsers, Vercel's edge
 * runtime and directly by Node during release verification.
 */

export type MarineDatasetKey = 'currents' | 'waves' | 'sst' | 'chl' | 'seaice' | 'mld' | 'mpa';

type MarineDatasetContract = {
    id: string;
    releaseTag: string;
    steps: number;
    cadenceHours: number | null;
    maxAssetBytes: number;
    contentType: 'application/octet-stream' | 'application/geo+json';
    maxSourceAgeHours?: number;
    maxPublishedAgeHours?: number;
};

export const MARINE_DATASET_CONTRACTS = Object.freeze({
    currents: Object.freeze({
        id: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
        releaseTag: 'cmems-currents-latest',
        steps: 13,
        cadenceHours: 1,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/octet-stream',
        maxSourceAgeHours: 12,
    }),
    waves: Object.freeze({
        id: 'cmems_mod_glo_wav_anfc_0.083deg_PT3H-i',
        releaseTag: 'cmems-waves-latest',
        steps: 17,
        cadenceHours: 3,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/octet-stream',
        maxSourceAgeHours: 15,
    }),
    sst: Object.freeze({
        id: 'cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m',
        releaseTag: 'cmems-sst-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/octet-stream',
        maxSourceAgeHours: 48,
    }),
    chl: Object.freeze({
        id: 'cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m',
        releaseTag: 'cmems-chl-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/octet-stream',
        maxSourceAgeHours: 48,
    }),
    seaice: Object.freeze({
        id: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',
        releaseTag: 'cmems-seaice-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/octet-stream',
        maxSourceAgeHours: 48,
    }),
    mld: Object.freeze({
        id: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',
        releaseTag: 'cmems-mld-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/octet-stream',
        maxSourceAgeHours: 48,
    }),
    mpa: Object.freeze({
        id: 'dcceew-capad-mapserver-layer-1',
        releaseTag: 'mpa-aus-latest',
        steps: 1,
        cadenceHours: null,
        maxAssetBytes: 16 * 1024 * 1024,
        contentType: 'application/geo+json',
        maxPublishedAgeHours: 14 * 24,
    }),
}) satisfies Readonly<Record<MarineDatasetKey, Readonly<MarineDatasetContract>>>;

const HOUR_MS = 60 * 60 * 1000;
const THCU_HEADER_BYTES = 30;
const GENERATION_PATTERN = /^g-\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const METADATA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class MarineManifestContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MarineManifestContractError';
    }
}

function requireContract(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MarineManifestContractError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const canonical = [...expected].sort();
    requireContract(
        actual.length === canonical.length && actual.every((key, index) => key === canonical[index]),
        `${label} fields are not exact`,
    );
}

function requireSafeInteger(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
    requireContract(
        Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum,
        `${label} is invalid`,
    );
}

function requireFinite(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
    requireContract(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`);
    requireContract(value >= minimum && value <= maximum, `${label} is outside its allowed range`);
}

function parseCanonicalUtc(value: unknown, label: string): number {
    requireContract(typeof value === 'string' && UTC_PATTERN.test(value), `${label} must be a canonical UTC second`);
    const milliseconds = Date.parse(value);
    requireContract(
        Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value.replace('Z', '.000Z'),
        `${label} is not a real timestamp`,
    );
    return milliseconds;
}

function compactUtc(milliseconds: number): string {
    const date = new Date(milliseconds);
    const two = (value: number): string => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}T${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

function validateMetadata(value: unknown): void {
    requireContract(isRecord(value), 'manifest metadata must be an object');
    const entries = Object.entries(value);
    requireContract(entries.length > 0 && entries.length <= 16, 'manifest metadata field count is invalid');
    for (const [key, entry] of entries) {
        requireContract(METADATA_KEY_PATTERN.test(key), `manifest metadata key ${JSON.stringify(key)} is invalid`);
        requireContract(
            typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 2_048,
            `manifest metadata ${key} must be a bounded nonempty string`,
        );
    }
}

/** Dependency-free SHA-256 for the tiny canonical generation identity input. */
function sha256Hex(input: Uint8Array): string {
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
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    const rotate = (value: number, count: number): number => (value >>> count) | (value << (32 - count));
    for (let block = 0; block < paddedLength; block += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4, false);
        for (let index = 16; index < 64; index += 1) {
            const first = words[index - 15];
            const second = words[index - 2];
            const s0 = rotate(first, 7) ^ rotate(first, 18) ^ (first >>> 3);
            const s1 = rotate(second, 17) ^ rotate(second, 19) ^ (second >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
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

export function canonicalMarineGeneration(
    dataStart: string,
    dataset: MarineDatasetKey,
    hashes: readonly string[],
): string {
    const timestamp = parseCanonicalUtc(dataStart, 'data_start');
    const material = new TextEncoder().encode(JSON.stringify({ data_start: dataStart, dataset, sha256: [...hashes] }));
    return `g-${compactUtc(timestamp)}-${sha256Hex(material).slice(0, 12)}`;
}

export function marineAssetShardTag(dataset: MarineDatasetKey, generation: string): string {
    requireContract(GENERATION_PATTERN.test(generation), 'invalid generation for shard');
    const compact = generation.slice(2, 18);
    const timestamp = Date.parse(
        `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`,
    );
    requireContract(
        Number.isFinite(timestamp) && compactUtc(timestamp) === compact,
        'invalid generation timestamp for shard',
    );
    const date = new Date(timestamp);
    const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const weekday = thursday.getUTCDay() || 7;
    thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
    const isoYear = thursday.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const isoWeek = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${MARINE_DATASET_CONTRACTS[dataset].releaseTag}-assets-${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

export function validateMarineManifest(
    value: unknown,
    expectedDataset: MarineDatasetKey,
    nowMs = Date.now(),
    requireCurrent = true,
): Record<string, unknown> {
    requireContract(isRecord(value), 'manifest root must be an object');
    const rootFields = [
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
    ];
    requireExactKeys(value, Object.hasOwn(value, 'metadata') ? [...rootFields, 'metadata'] : rootFields, 'manifest');
    if (Object.hasOwn(value, 'metadata')) validateMetadata(value.metadata);
    requireContract(value.schema_version === 2, 'manifest schema_version must be exactly 2');

    const spec: Readonly<MarineDatasetContract> = MARINE_DATASET_CONTRACTS[expectedDataset];
    requireContract(isRecord(value.dataset), 'manifest dataset must be an object');
    requireExactKeys(value.dataset, ['key', 'id'], 'manifest dataset');
    requireContract(
        value.dataset.key === expectedDataset && value.dataset.id === spec.id,
        'manifest dataset identity does not match the requested layer',
    );
    requireContract(
        typeof value.generation === 'string' && GENERATION_PATTERN.test(value.generation),
        'invalid generation',
    );

    const generatedAt = parseCanonicalUtc(value.generated_at, 'generated_at');
    const publishedAt = parseCanonicalUtc(value.published_at, 'published_at');
    const dataStart = parseCanonicalUtc(value.data_start, 'data_start');
    const dataEnd = parseCanonicalUtc(value.data_end, 'data_end');
    if (requireCurrent) {
        requireContract(
            dataStart <= nowMs,
            expectedDataset === 'mpa'
                ? 'MPA source timestamp is in the future'
                : 'dataset source time is in the future',
        );
    }
    requireContract(generatedAt >= dataStart, 'generated_at precedes source data');
    requireContract(publishedAt >= generatedAt, 'published_at precedes generated_at');
    requireContract(dataEnd >= dataStart, 'data_end precedes data_start');
    requireContract(
        value.generation.slice(2, 18) === compactUtc(dataStart),
        'generation timestamp does not match data_start',
    );
    if (requireCurrent) {
        requireContract(generatedAt <= nowMs + 15 * 60 * 1000, 'generated_at is implausibly in the future');
        requireContract(publishedAt <= nowMs + 15 * 60 * 1000, 'published_at is implausibly in the future');
    }
    requireContract(value.cadence_hours === spec.cadenceHours, 'manifest cadence does not match the dataset contract');

    requireContract(isRecord(value.producer), 'manifest producer must be an object');
    requireExactKeys(value.producer, ['commit', 'run_id', 'run_attempt'], 'manifest producer');
    requireContract(
        typeof value.producer.commit === 'string' && COMMIT_PATTERN.test(value.producer.commit),
        'invalid producer commit',
    );
    requireSafeInteger(value.producer.run_id, 1, Number.MAX_SAFE_INTEGER, 'producer run_id');
    requireSafeInteger(value.producer.run_attempt, 1, Number.MAX_SAFE_INTEGER, 'producer run_attempt');

    requireContract(isRecord(value.bounds), 'manifest bounds must be an object');
    requireExactKeys(value.bounds, ['north', 'south', 'west', 'east'], 'manifest bounds');
    const { north, south, west, east } = value.bounds;
    requireFinite(north, -90, 90, 'north bound');
    requireFinite(south, -90, 90, 'south bound');
    requireFinite(west, -180, 180, 'west bound');
    requireFinite(east, -180, 180, 'east bound');
    requireContract(north > south && east > west, 'manifest bounds are not oriented');

    requireContract(Array.isArray(value.files) && value.files.length === spec.steps, 'manifest file count is wrong');
    requireContract(isRecord(value.dimensions), 'manifest dimensions must be an object');

    let exactCmemsBytes: number | null = null;
    if (expectedDataset === 'mpa') {
        requireExactKeys(value.dimensions, ['feature_count'], 'MPA dimensions');
        requireSafeInteger(value.dimensions.feature_count, 100, 50_000, 'MPA feature_count');
        requireContract(dataStart === dataEnd, 'MPA source window must identify one source snapshot');
        requireContract(west >= 70 && west <= 80 && east >= 165 && east <= 180, 'MPA longitude coverage is incomplete');
        requireContract(
            south >= -60 && south <= -55 && north >= -10 && north <= 0,
            'MPA latitude coverage is incomplete',
        );
        requireContract(east - west >= 90 && north - south >= 45, 'MPA coverage span is incomplete');
        if (requireCurrent) {
            requireContract(
                nowMs - publishedAt <= (spec.maxPublishedAgeHours as number) * HOUR_MS,
                'MPA weekly publication is stale',
            );
        }
    } else {
        requireExactKeys(value.dimensions, ['width', 'height'], 'grid dimensions');
        requireSafeInteger(value.dimensions.width, 1_300, 1_500, 'manifest width');
        requireSafeInteger(value.dimensions.height, 600, 750, 'manifest height');
        const cellCount = value.dimensions.width * value.dimensions.height;
        requireContract(cellCount <= 1_125_000, 'manifest grid is too large');
        requireContract(
            north >= 89 && south <= -79 && west <= -179 && east >= 179,
            'manifest is not a global marine grid',
        );
        const longitudeStep = (east - west) / (value.dimensions.width - 1);
        const latitudeStep = (north - south) / (value.dimensions.height - 1);
        requireContract(
            longitudeStep >= 0.23 && longitudeStep <= 0.27 && latitudeStep >= 0.23 && latitudeStep <= 0.27,
            'manifest grid resolution is implausible',
        );
        exactCmemsBytes = THCU_HEADER_BYTES + cellCount * 9;
        requireContract(exactCmemsBytes <= spec.maxAssetBytes, 'declared grid exceeds the asset byte ceiling');
        requireContract(
            dataEnd - dataStart === (spec.steps - 1) * (spec.cadenceHours as number) * HOUR_MS,
            'dataset coverage window violates its exact cadence',
        );
        if (requireCurrent) {
            requireContract(dataEnd >= nowMs, 'dataset does not cover the current time');
            requireContract(
                nowMs - dataStart <= (spec.maxSourceAgeHours as number) * HOUR_MS,
                'dataset source time is stale',
            );
        }
    }

    const hashes: string[] = [];
    value.files.forEach((entry, index) => {
        requireContract(isRecord(entry), `files[${index}] must be an object`);
        const fields =
            expectedDataset === 'mpa'
                ? ['step', 'filename', 'bytes', 'sha256', 'content_type']
                : ['step', 'offset_hours', 'data_time', 'filename', 'bytes', 'sha256', 'content_type'];
        requireExactKeys(entry, fields, `files[${index}]`);
        requireContract(entry.step === index, `files[${index}] step is not contiguous`);
        const expectedFilename =
            expectedDataset === 'mpa'
                ? `${value.generation}-mpa.geojson`
                : `${value.generation}-h${String(index).padStart(3, '0')}.bin`;
        requireContract(entry.filename === expectedFilename, `files[${index}] has an unsafe immutable filename`);
        const minimumBytes = expectedDataset === 'mpa' ? 100_000 : (exactCmemsBytes as number);
        const maximumBytes = expectedDataset === 'mpa' ? spec.maxAssetBytes : (exactCmemsBytes as number);
        requireSafeInteger(entry.bytes, minimumBytes, maximumBytes, `files[${index}] byte count`);
        requireContract(
            typeof entry.sha256 === 'string' && SHA256_PATTERN.test(entry.sha256),
            `files[${index}] SHA-256 is invalid`,
        );
        requireContract(entry.content_type === spec.contentType, `files[${index}] content type is invalid`);
        hashes.push(entry.sha256);
        if (expectedDataset !== 'mpa') {
            requireContract(
                entry.offset_hours === index * (spec.cadenceHours as number),
                `files[${index}] offset is invalid`,
            );
            const fileTime = parseCanonicalUtc(entry.data_time, `files[${index}].data_time`);
            requireContract(
                fileTime === dataStart + index * (spec.cadenceHours as number) * HOUR_MS,
                `files[${index}] source time violates cadence`,
            );
        }
    });

    requireContract(
        value.generation === canonicalMarineGeneration(value.data_start as string, expectedDataset, hashes),
        'generation digest does not match source time and ordered asset hashes',
    );
    return value;
}
