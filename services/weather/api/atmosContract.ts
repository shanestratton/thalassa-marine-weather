/** Separate atmospheric scalar contract. Does not admit THCU, paid-model aliases or observations. */
import { sha256Hex } from './marineManifestContract';
import type { ScalarGrid } from '../scalarGridImage';

export type AtmosDataset = 'gfs-atmos' | 'ifs-pressure';
export type AtmosField = 'gust' | 'visibility' | 'pressure' | 'temperature' | 'dewpoint';

export const ATMOS_WIDTH = 360;
export const ATMOS_HEIGHT = 181;
export const ATMOS_CELLS = ATMOS_WIDTH * ATMOS_HEIGHT;
export const ATMOS_HEADER_BYTES = 64;
export const ATMOS_FIELDS = Object.freeze({
    gust: { code: 1, unit: 'm/s', min: 0, max: 150 },
    visibility: { code: 2, unit: 'm', min: 0, max: 300_000 },
    pressure: { code: 3, unit: 'Pa', min: 75_000, max: 115_000 },
    temperature: { code: 4, unit: 'K', min: 150, max: 350 },
    dewpoint: { code: 5, unit: 'K', min: 130, max: 350 },
});

export const ATMOS_DATASETS = Object.freeze({
    'gfs-atmos': {
        code: 1,
        id: 'noaa-gfs-0p25-to-1p00-surface-v1',
        releaseTag: 'gfs-atmos-latest',
        model: 'gfs',
        fields: ['gust', 'visibility', 'pressure', 'temperature', 'dewpoint'] as readonly AtmosField[],
        steps: 29,
        maxAgeHours: 12,
        cycles: [0, 6, 12, 18] as readonly number[],
        attribution: 'NOAA / NCEP GFS · 0.25° sampled to 1°',
        licence: 'NOAA public-domain data; no endorsement',
    },
    'ifs-pressure': {
        code: 2,
        id: 'ecmwf-ifs-oper-0p25-to-1p00-msl-v1',
        releaseTag: 'ifs-pressure-latest',
        model: 'ecmwf',
        fields: ['pressure'] as readonly AtmosField[],
        steps: 41,
        maxAgeHours: 24,
        cycles: [0, 12] as readonly number[],
        attribution: 'Contains modified ECMWF IFS open data · 0.25° sampled to 1°',
        licence: 'CC-BY-4.0; ECMWF Terms of Use',
    },
});

export class AtmosContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AtmosContractError';
    }
}

function requireAtmos(condition: unknown, message: string): asserts condition {
    if (!condition) throw new AtmosContractError(message);
}

const HOUR = 3_600_000;
const BOUNDS = { west: -180, south: -90, east: 179, north: 90 };
const ROOT_FIELDS = [
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
    'metadata',
];
const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
function exact(value: unknown, fields: readonly string[], label: string): asserts value is Record<string, unknown> {
    requireAtmos(
        object(value) &&
            Object.keys(value).length === fields.length &&
            fields.every((key) => Object.hasOwn(value, key)),
        `Invalid ${label} fields`,
    );
}
function utc(value: unknown): number {
    requireAtmos(
        typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value),
        'Invalid atmospheric UTC timestamp',
    );
    const ms = Date.parse(value);
    requireAtmos(
        Number.isFinite(ms) && new Date(ms).toISOString() === value.replace('Z', '.000Z'),
        'Invalid atmospheric UTC date',
    );
    return ms;
}
function validRun(dataset: AtmosDataset, run: number): void {
    const date = new Date(run);
    requireAtmos(
        Number.isSafeInteger(run) &&
            run >= Date.UTC(2020, 0, 1) &&
            ATMOS_DATASETS[dataset].cycles.includes(date.getUTCHours()) &&
            date.getUTCMinutes() === 0 &&
            date.getUTCSeconds() === 0 &&
            date.getUTCMilliseconds() === 0,
        'Invalid atmospheric model cycle',
    );
}

export function atmosFileBytes(dataset: AtmosDataset): number {
    return ATMOS_HEADER_BYTES + ATMOS_CELLS * 5 * ATMOS_DATASETS[dataset].fields.length;
}

export function canonicalAtmosGeneration(dataStart: string, dataset: AtmosDataset, hashes: readonly string[]): string {
    utc(dataStart);
    const compact = dataStart.replace(/[-:]/g, '');
    const material = new TextEncoder().encode(JSON.stringify({ data_start: dataStart, dataset, sha256: [...hashes] }));
    return `g-${compact}-${sha256Hex(material).slice(0, 12)}`;
}

export interface AtmosManifestFile {
    readonly step: number;
    readonly offset_hours: number;
    readonly data_time: string;
    readonly filename: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly content_type: 'application/octet-stream';
}
export interface AtmosManifest {
    readonly dataset: AtmosDataset;
    readonly generation: string;
    readonly runMs: number;
    readonly publishedMs: number;
    readonly files: readonly AtmosManifestFile[];
}

/** Validates a complete sealed cohort and returns an owned immutable snapshot. */
export function validateAtmosManifest(
    value: unknown,
    dataset: AtmosDataset,
    nowMs = Date.now(),
    requireCurrent = true,
): AtmosManifest {
    requireAtmos(Number.isFinite(nowMs), 'Invalid atmospheric clock');
    exact(value, ROOT_FIELDS, 'atmospheric manifest');
    const spec = ATMOS_DATASETS[dataset];
    requireAtmos(Boolean(spec), 'Unknown atmospheric dataset');
    requireAtmos(value.schema_version === 2 && value.cadence_hours === 6, 'Invalid atmospheric schema/cadence');
    exact(value.dataset, ['key', 'id'], 'dataset');
    requireAtmos(value.dataset.key === dataset && value.dataset.id === spec.id, 'Atmospheric source/model mismatch');
    exact(value.dimensions, ['width', 'height'], 'dimensions');
    requireAtmos(
        value.dimensions.width === ATMOS_WIDTH && value.dimensions.height === ATMOS_HEIGHT,
        'Invalid atmospheric dimensions',
    );
    exact(value.bounds, ['west', 'south', 'east', 'north'], 'bounds');
    requireAtmos(
        Object.entries(BOUNDS).every(
            ([key, expected]) => value.bounds && (value.bounds as Record<string, unknown>)[key] === expected,
        ),
        'Invalid atmospheric coverage',
    );
    exact(
        value.metadata,
        ['model', 'source_resolution_degrees', 'display_resolution_degrees', 'fields', 'attribution', 'licence'],
        'metadata',
    );
    requireAtmos(
        value.metadata.model === spec.model &&
            value.metadata.source_resolution_degrees === '0.25' &&
            value.metadata.display_resolution_degrees === '1' &&
            value.metadata.fields === spec.fields.join(',') &&
            value.metadata.attribution === spec.attribution &&
            value.metadata.licence === spec.licence,
        'Invalid atmospheric source attribution/fields',
    );
    const runMs = utc(value.data_start);
    validRun(dataset, runMs);
    const generatedMs = utc(value.generated_at);
    const publishedMs = utc(value.published_at);
    requireAtmos(generatedMs >= runMs && publishedMs >= generatedMs, 'Invalid atmospheric publication ordering');
    requireAtmos(utc(value.data_end) === runMs + (spec.steps - 1) * 6 * HOUR, 'Incomplete atmospheric horizon');
    if (requireCurrent) {
        requireAtmos(
            runMs <= nowMs && nowMs - runMs <= spec.maxAgeHours * HOUR && publishedMs <= nowMs + 15 * 60_000,
            'Atmospheric run stale or future',
        );
    }
    exact(value.producer, ['commit', 'run_id', 'run_attempt'], 'producer');
    requireAtmos(
        typeof value.producer.commit === 'string' &&
            /^[a-f0-9]{40}$/.test(value.producer.commit) &&
            Number.isSafeInteger(value.producer.run_id) &&
            Number(value.producer.run_id) > 0 &&
            Number.isSafeInteger(value.producer.run_attempt) &&
            Number(value.producer.run_attempt) > 0,
        'Invalid atmospheric producer',
    );
    requireAtmos(
        typeof value.generation === 'string' && /^g-\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(value.generation),
        'Invalid atmospheric generation',
    );
    const generation = value.generation;
    requireAtmos(
        Array.isArray(value.files) && value.files.length === spec.steps,
        'Incomplete atmospheric frame cohort',
    );
    const files = value.files.map((file: unknown, index): AtmosManifestFile => {
        exact(file, ['step', 'offset_hours', 'data_time', 'filename', 'bytes', 'sha256', 'content_type'], 'frame');
        const filename = `${generation}-h${String(index).padStart(3, '0')}.bin`;
        requireAtmos(
            file.step === index &&
                file.offset_hours === index * 6 &&
                utc(file.data_time) === runMs + index * 6 * HOUR &&
                file.filename === filename &&
                file.bytes === atmosFileBytes(dataset) &&
                file.content_type === 'application/octet-stream' &&
                typeof file.sha256 === 'string' &&
                /^[a-f0-9]{64}$/.test(file.sha256),
            'Invalid atmospheric frame identity/clock/bytes',
        );
        return Object.freeze({
            step: index,
            offset_hours: index * 6,
            data_time: String(file.data_time),
            filename,
            bytes: Number(file.bytes),
            sha256: String(file.sha256),
            content_type: 'application/octet-stream',
        });
    });
    requireAtmos(
        generation ===
            canonicalAtmosGeneration(
                String(value.data_start),
                dataset,
                files.map((file) => file.sha256),
            ),
        'Atmospheric generation digest mismatch',
    );
    return Object.freeze({ dataset, generation, runMs, publishedMs, files: Object.freeze(files) });
}

export interface AtmosFrame {
    readonly dataset: AtmosDataset;
    readonly runMs: number;
    readonly offsetHours: number;
    readonly fields: Readonly<Partial<Record<AtmosField, ScalarGrid>>>;
}

/** THAS v1, 64-byte LE header followed by one float32 plane + byte mask per fixed field. */
export function decodeAtmosFrame(
    buffer: ArrayBuffer,
    dataset: AtmosDataset,
    runMs: number,
    offsetHours: number,
    check?: () => void,
): AtmosFrame {
    check?.();
    const spec = ATMOS_DATASETS[dataset];
    validRun(dataset, runMs);
    requireAtmos(
        Number.isInteger(offsetHours) &&
            offsetHours >= 0 &&
            offsetHours <= (spec.steps - 1) * 6 &&
            offsetHours % 6 === 0,
        'Invalid atmospheric frame offset',
    );
    requireAtmos(buffer.byteLength === atmosFileBytes(dataset), 'Invalid atmospheric binary size');
    const view = new DataView(buffer);
    requireAtmos(
        view.getUint32(0, true) === 0x53414854 &&
            view.getUint8(4) === 1 &&
            view.getUint8(5) === spec.code &&
            view.getUint8(6) === spec.fields.length &&
            view.getUint8(7) === 0,
        'Invalid THAS type/version/model',
    );
    requireAtmos(
        view.getUint16(8, true) === ATMOS_WIDTH &&
            view.getUint16(10, true) === ATMOS_HEIGHT &&
            view.getFloat64(12, true) === -180 &&
            view.getFloat64(20, true) === -90 &&
            view.getFloat64(28, true) === 1 &&
            view.getFloat64(36, true) === 1 &&
            view.getFloat64(44, true) === runMs &&
            view.getUint16(52, true) === offsetHours &&
            view.getUint16(54, true) === 0,
        'Invalid THAS geometry/clock',
    );
    for (let i = 0; i < 8; i++)
        requireAtmos(
            view.getUint8(56 + i) === (i < spec.fields.length ? ATMOS_FIELDS[spec.fields[i]].code : 0),
            'Invalid THAS field order',
        );
    const fields: Partial<Record<AtmosField, ScalarGrid>> = {};
    for (let channel = 0; channel < spec.fields.length; channel++) {
        check?.();
        const name = spec.fields[channel];
        const limits = ATMOS_FIELDS[name];
        const base = ATMOS_HEADER_BYTES + channel * ATMOS_CELLS * 5;
        const values = new Float32Array(ATMOS_CELLS);
        const validMask = new Uint8Array(ATMOS_CELLS);
        let validCount = 0;
        for (let index = 0; index < ATMOS_CELLS; index++) {
            if (index % 4096 === 0) check?.();
            const value = view.getFloat32(base + index * 4, true);
            const mask = view.getUint8(base + ATMOS_CELLS * 4 + index);
            requireAtmos(
                (mask === 0 && value === 0) ||
                    (mask === 1 && Number.isFinite(value) && value >= limits.min && value <= limits.max),
                `Invalid THAS ${name} values/mask`,
            );
            values[index] = value;
            validMask[index] = mask;
            validCount += mask;
        }
        requireAtmos(validCount >= ATMOS_CELLS * 0.95, `THAS ${name} coverage incomplete`);
        fields[name] = Object.freeze({
            width: ATMOS_WIDTH,
            height: ATMOS_HEIGHT,
            west: -180,
            south: -90,
            dx: 1,
            dy: 1,
            values,
            validMask,
            wrapLongitude: true,
        });
    }
    check?.();
    return Object.freeze({ dataset, runMs, offsetHours, fields: Object.freeze(fields) });
}
