/** Daily mapped altimetry has a separate trust contract from THCU forecasts. */
import { sha256Hex } from './marineManifestContract.ts';

export const SSH_WIDTH = 720;
export const SSH_HEIGHT = 360;
export const SSH_CELLS = SSH_WIDTH * SSH_HEIGHT;
export const SSH_FILE_BYTES = 64 + SSH_CELLS * 17;
export const SSH_DATASET = 'cmems_obs-sl_glo_phy-ssh_nrt_allsat-l4-duacs-0.125deg_P1D';
export const SSH_BOUNDS = Object.freeze({ west: -179.75, south: -89.75, east: 179.75, north: 89.75 });
export const SSH_METADATA = Object.freeze({
    product: 'SEALEVEL_GLO_PHY_L4_NRT_008_046',
    dataset_version: '202506',
    variables: 'adt,sla,ugos,vgos',
    units: 'm,m,m/s,m/s',
    kind: 'mapped-altimetry-observation',
    display_grid: '0.5 degree; 4x4 mean, every contributor finite and ice-free',
    references: 'ADT above geoid; SLA above 1993-2012 mean; geostrophic currents',
    credit: 'Generated using E.U. Copernicus Marine Service Information; DOI 10.48670/moi-00149; copyright Mercator Ocean',
});
const DAY = 86_400_000;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function requireSsh(ok: unknown, reason: string): asserts ok {
    if (!ok) throw new Error(`SSH: ${reason}`);
}
function exact(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
    requireSsh(record(value), label);
    const actual = Object.keys(value).sort(),
        expected = [...keys].sort();
    requireSsh(actual.length === expected.length && actual.every((key, i) => key === expected[i]), `${label} fields`);
}
function utc(value: unknown): number {
    requireSsh(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value), 'canonical UTC time');
    const ms = Date.parse(value);
    requireSsh(Number.isFinite(ms) && new Date(ms).toISOString() === value.replace('Z', '.000Z'), 'real UTC date');
    return ms;
}
export function sshGeneration(dataStart: string, hashes: readonly string[]): string {
    const ms = utc(dataStart);
    requireSsh(hashes.length === 1 && /^[0-9a-f]{64}$/.test(hashes[0]), 'one exact asset digest');
    const material = new TextEncoder().encode(
        JSON.stringify({ data_start: dataStart, dataset: 'ssh', sha256: [...hashes] }),
    );
    return `g-${new Date(ms).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z')}-${sha256Hex(material).slice(0, 12)}`;
}
export interface SshManifest {
    readonly generation: string;
    readonly sourceTimeMs: number;
    readonly publishedAtMs: number;
    readonly validUntilMs: number;
    readonly filename: string;
    readonly sha256: string;
}
export function parseSshManifest(value: unknown, nowMs = Date.now(), requireCurrent = true): SshManifest {
    exact(
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
            'metadata',
        ],
        'manifest',
    );
    requireSsh(value.schema_version === 2 && value.cadence_hours === 24, 'schema/daily cadence');
    exact(value.dataset, ['key', 'id'], 'dataset');
    requireSsh(value.dataset.key === 'ssh' && value.dataset.id === SSH_DATASET, 'non-demo dataset identity');
    exact(value.dimensions, ['width', 'height'], 'dimensions');
    requireSsh(value.dimensions.width === SSH_WIDTH && value.dimensions.height === SSH_HEIGHT, 'exact display grid');
    exact(value.bounds, Object.keys(SSH_BOUNDS), 'bounds');
    for (const [key, expected] of Object.entries(SSH_BOUNDS))
        requireSsh(value.bounds[key] === expected, 'cell-centre bounds');
    exact(value.metadata, Object.keys(SSH_METADATA), 'metadata');
    for (const [key, expected] of Object.entries(SSH_METADATA))
        requireSsh(value.metadata[key] === expected, 'provenance/units/credit');
    const source = utc(value.data_start),
        end = utc(value.data_end),
        generated = utc(value.generated_at),
        published = utc(value.published_at);
    requireSsh(
        source >= Date.UTC(2020, 0, 1) && source <= Date.UTC(2100, 0, 1) && source % DAY === 0 && end === source,
        'original daily observation date',
    );
    requireSsh(
        generated >= source && generated - source <= 4 * DAY && published >= generated,
        'observation chronology',
    );
    if (requireCurrent) {
        requireSsh(
            Number.isFinite(nowMs) && source <= nowMs && nowMs - source <= 4 * DAY,
            'observation is stale or future',
        );
        requireSsh(
            generated <= nowMs + 900_000 && published <= nowMs + 900_000 && nowMs - generated <= 2 * DAY,
            'publication is stale or future',
        );
    }
    exact(value.producer, ['commit', 'run_id', 'run_attempt'], 'producer');
    requireSsh(
        typeof value.producer.commit === 'string' && /^[0-9a-f]{40}$/.test(value.producer.commit),
        'producer commit',
    );
    for (const key of ['run_id', 'run_attempt'])
        requireSsh(Number.isSafeInteger(value.producer[key]) && Number(value.producer[key]) > 0, 'producer run');
    requireSsh(Array.isArray(value.files) && value.files.length === 1, 'one observed frame');
    const file: unknown = value.files[0];
    exact(file, ['step', 'offset_hours', 'data_time', 'filename', 'bytes', 'sha256', 'content_type'], 'file');
    requireSsh(
        file.step === 0 && file.offset_hours === 0 && file.data_time === value.data_start,
        'no forecast or retimed frame',
    );
    requireSsh(
        file.bytes === SSH_FILE_BYTES && file.content_type === 'application/octet-stream',
        'exact immutable binary',
    );
    requireSsh(typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256), 'asset digest');
    const generation = sshGeneration(value.data_start as string, [file.sha256]);
    requireSsh(
        value.generation === generation && file.filename === `${generation}-h000.bin`,
        'generation/content binding',
    );
    return Object.freeze({
        generation,
        sourceTimeMs: source,
        publishedAtMs: published,
        validUntilMs: Math.min(source + 4 * DAY, generated + 2 * DAY),
        filename: file.filename as string,
        sha256: file.sha256,
    });
}
