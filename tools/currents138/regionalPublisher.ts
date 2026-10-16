import { createHash, sign, type KeyObject } from 'node:crypto';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
    validateCurrentSeries,
    CURRENT_SERIES_MAX_BYTES,
    type CurrentSeries,
    type CurrentSeriesTile,
} from '../../services/weather/currentSeries';
import {
    CURRENT_REGIONAL_ASSET_BYTES,
    CURRENT_REGIONAL_MANIFEST_BYTES,
    currentRegionBounds,
    parseCurrentRegionalManifest,
} from '../../services/weather/api/currentRegionalContract';

export const REGIONAL_JOB_BYTES = 8 * 1024 * 1024;
export const REGIONAL_JOB_SECONDS = 60;
const HEADER_BYTES = 32 * 1024;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error('Regional publisher: ' + message);
};
export interface RegionalGeneration {
    generation: string;
    files: Map<string, Uint8Array>;
    receipt: {
        schema: 1;
        generation: string;
        issuedMs: number;
        bytes: number;
        sources: unknown[];
        files: { name: string; bytes: number; sha256: string; kind: 'asset' | 'manifest' }[];
    };
}

/** Offline only: inputs must already have verified provider coordinates, units and masks. */
function encode(series: CurrentSeries, tile: CurrentSeriesTile): Uint8Array {
    const region = currentRegionBounds(tile.id);
    assert(
        region &&
            tile.north >= region.north &&
            tile.south <= region.south &&
            tile.west <= region.west &&
            tile.east >= region.east,
        'incomplete fixed region',
    );
    assert(tile.width <= 64 && tile.height <= 64, 'wire dimensions');
    const metadata = {
        schema: 1,
        model: series.model,
        dataset: series.dataset,
        generation: series.generation,
        sourceSha256: tile.sourceSha256,
        runMs: series.runMs,
        expiresMs: series.expiresMs,
        units: series.units,
        vectorBasis: series.vectorBasis,
        depthM: series.depthM,
        crs: 'EPSG:4326',
        layout: 'north-south-west-east',
        tile: {
            id: tile.id,
            north: tile.north,
            south: tile.south,
            west: tile.west,
            east: tile.east,
            width: tile.width,
            height: tile.height,
            ocean: { times: tile.ocean.times, cadenceHours: tile.ocean.cadenceHours },
            ...(tile.tide ? { tide: { times: tile.tide.times, cadenceHours: tile.tide.cadenceHours } } : {}),
        },
    };
    const header = Buffer.from(JSON.stringify(metadata));
    assert(header.byteLength > 0 && header.byteLength <= HEADER_BYTES, 'metadata cap');
    const components = [tile.ocean, ...(tile.tide ? [tile.tide] : [])];
    const bytes =
        12 +
        header.byteLength +
        components.reduce((total, planes) => total + planes.times.length * tile.width * tile.height * 9, 0);
    assert(bytes <= CURRENT_REGIONAL_ASSET_BYTES, 'asset cap');
    const output = new Uint8Array(bytes),
        view = new DataView(output.buffer);
    view.setUint32(0, 0x53434854, true);
    view.setUint16(4, 1, true);
    view.setUint32(8, header.byteLength, true);
    output.set(header, 12);
    let offset = 12 + header.byteLength;
    for (const planes of components)
        for (let step = 0; step < planes.times.length; step++) {
            for (const values of [planes.u[step], planes.v[step]]) {
                for (const value of values) {
                    view.setFloat32(offset, value, true);
                    offset += 4;
                }
            }
            output.set(planes.known[step], offset);
            offset += planes.known[step].byteLength;
        }
    assert(offset === bytes, 'plane inventory');
    return output;
}

/** No fetch, provider inference, resampling, mask filling or publication occurs here. */
export function buildRegionalGeneration(
    input: readonly CurrentSeries[],
    issuedMs: number,
    keyId: string,
    privateKey: KeyObject,
): RegionalGeneration {
    assert(input.length > 0 && input.length <= 2, 'model count');
    assert(Number.isSafeInteger(issuedMs) && issuedMs >= 946684800000, 'issuance timestamp required');
    assert(
        /^[a-z][a-z0-9-]{0,63}$/.test(keyId) &&
            privateKey.type === 'private' &&
            privateKey.asymmetricKeyType === 'ed25519',
        'signing identity',
    );
    const sources = [...input].sort((a, b) => a.model.localeCompare(b.model));
    assert(new Set(sources.map((source) => source.model)).size === sources.length, 'duplicate model');
    let decoded = 0;
    for (const source of sources) {
        decoded += validateCurrentSeries(source);
        assert(decoded <= CURRENT_SERIES_MAX_BYTES, 'whole-job decoded cap');
        assert(
            source.runMs <= issuedMs && issuedMs - source.runMs <= 36 * 3600000 && source.expiresMs > issuedMs,
            'source clock is stale or incomplete',
        );
    }
    const regions = [...new Set(sources.flatMap((source) => source.tiles.map((tile) => tile.id)))].sort();
    assert(regions.length > 0 && regions.length <= 8, 'finite region inventory');
    const sourceReceipt = sources.map((source) => ({
        model: source.model,
        dataset: source.dataset,
        sourceSha256: source.sourceSha256,
        runMs: source.runMs,
        expiresMs: source.expiresMs,
        tiles: [...source.tiles]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((tile) => ({ id: tile.id, sourceSha256: tile.sourceSha256 })),
    }));
    const lineage = createHash('sha256').update(JSON.stringify(sourceReceipt));
    for (const source of sources)
        for (const tile of [...source.tiles].sort((a, b) => a.id.localeCompare(b.id))) {
            lineage.update(encode({ ...source, generation: 'g-' + '0'.repeat(24) }, tile));
        }
    const generation = 'g-' + lineage.digest('hex').slice(0, 24),
        files = new Map<string, Uint8Array>();
    const inventory: RegionalGeneration['receipt']['files'] = [];
    let totalBytes = 0;
    const add = (name: string, bytes: Uint8Array, kind: 'asset' | 'manifest') => {
        assert(!files.has(name), 'duplicate output');
        totalBytes += bytes.byteLength;
        assert(totalBytes <= REGIONAL_JOB_BYTES, 'whole-job output cap');
        files.set(name, bytes);
        inventory.push({ name, bytes: bytes.byteLength, sha256: digest(bytes), kind });
    };
    for (const id of regions) {
        const models: Record<string, { filename: string; bytes: number; sha256: string }> = {};
        let expiresMs = Number.POSITIVE_INFINITY;
        for (const source of sources) {
            const tile = source.tiles.find((candidate) => candidate.id === id);
            if (!tile) continue;
            const bytes = encode({ ...source, generation }, tile),
                filename = generation + '-' + source.model.toLowerCase() + '-' + id + '.thcs';
            models[source.model] = { filename, bytes: bytes.byteLength, sha256: digest(bytes) };
            expiresMs = Math.min(expiresMs, source.expiresMs);
            add(filename, bytes, 'asset');
        }
        const manifest = { schema: 1, regionId: id, generation, issuedMs, expiresMs, models };
        parseCurrentRegionalManifest(manifest, id, issuedMs);
        const payload = Buffer.from(JSON.stringify(manifest));
        const envelope = Buffer.from(
            JSON.stringify({
                algorithm: 'Ed25519',
                keyId,
                payload: payload.toString('base64url'),
                signature: sign(null, payload, privateKey).toString('base64url'),
            }),
        );
        assert(envelope.byteLength <= CURRENT_REGIONAL_MANIFEST_BYTES, 'signed manifest cap');
        add(id + '.json', Uint8Array.from(envelope), 'manifest');
    }
    return {
        generation,
        files,
        receipt: { schema: 1, generation, issuedMs, bytes: totalBytes, sources: sourceReceipt, files: inventory },
    };
}

/** A fresh private staging directory only; read back all assets before any manifest. */
export async function stageRegionalGeneration(
    build: RegionalGeneration,
    output: string,
    signal?: AbortSignal,
): Promise<void> {
    const deadline = Date.now() + REGIONAL_JOB_SECONDS * 1000;
    const check = () => {
        assert(!signal?.aborted && Date.now() < deadline, 'cancelled/deadline');
    };
    check();
    assert(
        path.isAbsolute(output) &&
            build.files.size > 0 &&
            build.files.size <= 24 &&
            build.receipt.files.length === build.files.size,
        'staging inventory',
    );
    assert(
        /^g-[a-f0-9]{24}$/.test(build.generation) &&
            build.receipt.schema === 1 &&
            build.receipt.generation === build.generation,
        'staging generation',
    );
    assert(
        Number.isSafeInteger(build.receipt.bytes) &&
            build.receipt.bytes > 0 &&
            build.receipt.bytes <= REGIONAL_JOB_BYTES,
        'staging cap',
    );
    const rows = [...build.receipt.files].sort((a, b) => (a.kind === 'asset' ? 0 : 1) - (b.kind === 'asset' ? 0 : 1));
    assert(
        rows.some((row) => row.kind === 'asset') && rows.some((row) => row.kind === 'manifest'),
        'staging completeness',
    );
    assert(new Set(rows.map((row) => row.name)).size === rows.length, 'duplicate staging path');
    let actualBytes = 0;
    for (const row of rows) {
        assert(row.kind === 'asset' || row.kind === 'manifest', 'staging kind');
        assert(row.kind !== 'asset' || row.name.startsWith(build.generation + '-'), 'staging generation path');
        assert(
            /^(?:g-[a-f0-9]{24}-(?:cmems|rtofs)-t-\d{1,2}-\d{1,3}\.thcs|t-\d{1,2}-\d{1,3}\.json)$/.test(row.name),
            'staging path',
        );
        const bytes = build.files.get(row.name);
        assert(
            bytes instanceof Uint8Array &&
                bytes.byteOffset === 0 &&
                bytes.buffer.byteLength === bytes.byteLength &&
                bytes.byteLength === row.bytes &&
                digest(bytes) === row.sha256,
            'staging bytes changed',
        );
        assert(
            row.bytes <= (row.kind === 'asset' ? CURRENT_REGIONAL_ASSET_BYTES : CURRENT_REGIONAL_MANIFEST_BYTES),
            'staging object cap',
        );
        actualBytes += row.bytes;
        assert(actualBytes <= REGIONAL_JOB_BYTES, 'staging actual byte cap');
    }
    assert(actualBytes === build.receipt.bytes, 'staging byte accounting');
    fs.mkdirSync(output, { recursive: false });
    for (const row of rows) {
        check();
        const filename = path.join(output, row.name),
            bytes = build.files.get(row.name)!;
        fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
        assert(digest(fs.readFileSync(filename)) === row.sha256, 'readback mismatch');
        await setImmediate();
    }
    check();
    const recorded = {
        schema: 1,
        generation: build.generation,
        issuedMs: build.receipt.issuedMs,
        bytes: actualBytes,
        files: rows.map((row) => ({ name: row.name, bytes: row.bytes, sha256: row.sha256, kind: row.kind })),
        sourceProvenance:
            'Exact model/dataset/run/source hashes remain in the immutable THCS assets fixed by this inventory',
        publication: false,
    };
    fs.writeFileSync(path.join(output, 'STAGED.json'), JSON.stringify(recorded, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
    });
}
