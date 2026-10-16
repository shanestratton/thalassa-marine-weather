import {
    validateCurrentSeries,
    validCurrentBounds,
    type CurrentBounds,
    type CurrentModel,
    type CurrentPlanes,
    type CurrentSeries,
    type CurrentSeriesTile,
} from '../currentSeries';

export const CURRENT_REGIONAL_MANIFEST_BYTES = 256 * 1024;
export const CURRENT_REGIONAL_ASSET_BYTES = 2 * 1024 * 1024;
const HEADER_MAX = 32 * 1024;
const HOUR = 3_600_000;
const name = /^[a-z0-9-]{1,80}\.thcs$/;
const hash = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error(`Regional current: ${message}`);
};
const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export interface CurrentRegionalAsset {
    filename: string;
    bytes: number;
    sha256: string;
}
export interface CurrentRegionalManifest {
    schema: 1;
    regionId: string;
    generation: string;
    issuedMs: number;
    expiresMs: number;
    models: Partial<Record<CurrentModel, CurrentRegionalAsset>>;
}

/** Fixed two-degree public region identifiers: no provider URL or route coordinates in an asset path. */
export function currentRegionBounds(id: string): CurrentBounds | null {
    const match = /^t-(\d{1,2})-(\d{1,3})$/.exec(id);
    if (!match) return null;
    const y = Number(match[1]),
        x = Number(match[2]);
    if (y >= 90 || x >= 180 || id !== `t-${y}-${x}`) return null;
    return { south: y * 2 - 90, north: y * 2 - 88, west: x * 2 - 180, east: x * 2 - 178 };
}

export function parseCurrentRegionalManifest(value: unknown, regionId: string, nowMs: number): CurrentRegionalManifest {
    assert(record(value) && currentRegionBounds(regionId), 'manifest root/region');
    const item = value as Record<string, unknown>;
    assert(item.schema === 1 && item.regionId === regionId, 'manifest identity');
    assert(typeof item.generation === 'string' && /^g-[a-f0-9]{24}$/.test(item.generation), 'generation');
    assert(
        integer(item.issuedMs, 946_684_800_000, nowMs + 5 * 60_000) &&
            nowMs - item.issuedMs <= 36 * HOUR &&
            integer(item.expiresMs, nowMs + 1, item.issuedMs + 6 * 24 * HOUR),
        'manifest freshness',
    );
    assert(
        record(item.models) && Object.keys(item.models).length > 0 && Object.keys(item.models).length <= 2,
        'models',
    );
    const models: CurrentRegionalManifest['models'] = {};
    for (const [model, candidate] of Object.entries(item.models as Record<string, unknown>)) {
        assert(['CMEMS', 'RTOFS'].includes(model) && record(candidate), 'model identity');
        const asset = candidate as Record<string, unknown>;
        assert(
            typeof asset.filename === 'string' &&
                name.test(asset.filename) &&
                asset.filename === `${item.generation}-${model.toLowerCase()}-${regionId}.thcs` &&
                integer(asset.bytes, 16, CURRENT_REGIONAL_ASSET_BYTES) &&
                typeof asset.sha256 === 'string' &&
                hash.test(asset.sha256),
            'asset identity/size/hash',
        );
        models[model as CurrentModel] = {
            filename: asset.filename as string,
            bytes: asset.bytes as number,
            sha256: asset.sha256 as string,
        };
    }
    return {
        schema: 1,
        regionId,
        generation: item.generation as string,
        issuedMs: item.issuedMs as number,
        expiresMs: item.expiresMs as number,
        models,
    };
}

function base64(value: unknown, max: number): Uint8Array {
    assert(
        typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value),
        'base64url',
    );
    const str = value as string;
    const raw = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4));
    return Uint8Array.from(raw, (letter) => letter.charCodeAt(0));
}

/** Signature covers the exact UTF8 payload bytes, not a reserialized JSON object. */
export async function verifyCurrentRegionalEnvelope(
    envelope: unknown,
    trustedKeys: ReadonlyMap<string, Uint8Array>,
): Promise<unknown | null> {
    try {
        if (!record(envelope) || envelope.algorithm !== 'Ed25519' || typeof envelope.keyId !== 'string') return null;
        const rawKey = trustedKeys.get(envelope.keyId);
        if (!rawKey || rawKey.byteLength !== 32 || !globalThis.crypto?.subtle) return null;
        const payload = base64(envelope.payload, CURRENT_REGIONAL_MANIFEST_BYTES - 1024);
        const signature = base64(envelope.signature, 86);
        if (signature.byteLength !== 64) return null;
        const key = await crypto.subtle.importKey('raw', new Uint8Array(rawKey).buffer, { name: 'Ed25519' }, false, [
            'verify',
        ]);
        if (
            !(await crypto.subtle.verify(
                { name: 'Ed25519' },
                key,
                new Uint8Array(signature).buffer,
                new Uint8Array(payload).buffer,
            ))
        )
            return null;
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    } catch {
        return null;
    }
}

export async function currentAssetSha256(bytes: Uint8Array): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('Regional current: WebCrypto unavailable');
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

/** THCS1: 12-byte LE header, bounded UTF8 metadata, then u/v float32 and known-u8 planes. */
export function decodeCurrentRegionalAsset(
    bytes: Uint8Array,
    manifest: CurrentRegionalManifest,
    model: CurrentModel,
): CurrentSeries {
    const descriptor = manifest.models[model];
    assert(
        descriptor && bytes.byteLength === descriptor.bytes && bytes.byteLength <= CURRENT_REGIONAL_ASSET_BYTES,
        'asset length',
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert(
        bytes.byteLength >= 12 &&
            view.getUint32(0, true) === 0x53434854 &&
            view.getUint16(4, true) === 1 &&
            view.getUint16(6, true) === 0,
        'THCS header',
    );
    const headerBytes = view.getUint32(8, true);
    assert(headerBytes > 0 && headerBytes <= HEADER_MAX && headerBytes + 12 < bytes.byteLength, 'THCS metadata size');
    const data: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + headerBytes)),
    );
    assert(record(data) && record(data.tile), 'THCS metadata');
    const h = data as Record<string, unknown>,
        t = h.tile as Record<string, unknown>;
    assert(h.crs === 'EPSG:4326' && h.layout === 'north-south-west-east', 'unverified grid coordinates/layout');
    assert(
        h.schema === 1 && h.model === model && h.generation === manifest.generation && t.id === manifest.regionId,
        'THCS identity',
    );
    const bounds = currentRegionBounds(manifest.regionId)!;
    assert(
        validCurrentBounds(t as unknown as CurrentBounds) &&
            (t.north as number) >= bounds.north &&
            (t.south as number) <= bounds.south &&
            (t.west as number) <= bounds.west &&
            (t.east as number) >= bounds.east,
        'region coverage',
    );
    assert(
        integer(t.width, 2, 64) && integer(t.height, 2, 64) && (t.width as number) * (t.height as number) <= 4096,
        'THCS dimensions',
    );
    const cells = (t.width as number) * (t.height as number);
    let expected = 12 + headerBytes;
    for (const component of [t.ocean, t.tide]) {
        if (component === undefined) continue;
        assert(
            record(component) &&
                Array.isArray(component.times) &&
                component.times.length >= 2 &&
                component.times.length <= 121,
            'THCS time count',
        );
        expected += component.times.length * cells * 9;
    }
    assert(expected === bytes.byteLength && record(t.ocean), 'THCS exact planes');
    let offset = 12 + headerBytes;
    const planes = (raw: Record<string, unknown>): CurrentPlanes => {
        const times = raw.times as number[];
        const u: Float32Array[] = [],
            v: Float32Array[] = [],
            known: Uint8Array[] = [];
        for (let step = 0; step < times.length; step++) {
            const east = new Float32Array(cells),
                north = new Float32Array(cells);
            for (const plane of [east, north]) {
                for (let index = 0; index < cells; index++) plane[index] = view.getFloat32(offset + index * 4, true);
                offset += cells * 4;
            }
            u.push(east);
            v.push(north);
            known.push(bytes.slice(offset, offset + cells));
            offset += cells;
        }
        return { cadenceHours: raw.cadenceHours as 1 | 3, times: [...times], u, v, known };
    };
    const tile: CurrentSeriesTile = {
        id: t.id as string,
        sourceSha256: h.sourceSha256 as string,
        north: t.north as number,
        south: t.south as number,
        west: t.west as number,
        east: t.east as number,
        width: t.width as number,
        height: t.height as number,
        ocean: planes(t.ocean as Record<string, unknown>),
        ...(t.tide ? { tide: planes(t.tide as Record<string, unknown>) } : {}),
    };
    const series: CurrentSeries = {
        schema: 1,
        model,
        dataset: h.dataset as string,
        generation: h.generation as string,
        sourceSha256: h.sourceSha256 as string,
        runMs: h.runMs as number,
        expiresMs: h.expiresMs as number,
        units: h.units as 'm/s',
        vectorBasis: h.vectorBasis as 'true-east-north',
        depthM: h.depthM as number,
        tiles: [tile],
    };
    validateCurrentSeries(series);
    assert(
        series.expiresMs <= manifest.expiresMs &&
            series.runMs <= manifest.issuedMs &&
            manifest.issuedMs - series.runMs <= 36 * HOUR,
        'source freshness',
    );
    return series;
}
