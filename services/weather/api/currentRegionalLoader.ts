import { API_BASE } from '../../native/apiBase';
import {
    CURRENT_SERIES_MAX_BYTES,
    CURRENT_SERIES_MAX_TILES,
    splitCurrentBounds,
    validateCurrentSeries,
    type CurrentBounds,
    type CurrentComponents,
    type CurrentModel,
    type CurrentSeries,
} from '../currentSeries';
import {
    CURRENT_REGIONAL_ASSET_BYTES,
    CURRENT_REGIONAL_MANIFEST_BYTES,
    currentAssetSha256,
    currentRegionBounds,
    decodeCurrentRegionalAsset,
    parseCurrentRegionalManifest,
    verifyCurrentRegionalEnvelope,
} from './currentRegionalContract';

export const CURRENT_REGIONAL_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const CURRENT_REGIONAL_DEADLINE_MS = 8000;
export interface CurrentRegionalRequest {
    bounds: CurrentBounds;
    startMs: number;
    endMs: number;
    model?: CurrentModel;
    components?: CurrentComponents;
    satelliteMode?: boolean;
    signal?: AbortSignal;
}

export function currentBoundsForPassage(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
): CurrentBounds | null {
    if (
        ![origin.lat, origin.lon, destination.lat, destination.lon].every(Number.isFinite) ||
        Math.abs(origin.lat) > 90 ||
        Math.abs(destination.lat) > 90 ||
        Math.abs(origin.lon) > 180 ||
        Math.abs(destination.lon) > 180
    )
        return null;
    const end = origin.lon + ((destination.lon - origin.lon + 540) % 360) - 180;
    const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
    return {
        north: Math.min(90, Math.max(origin.lat, destination.lat) + 1),
        south: Math.max(-90, Math.min(origin.lat, destination.lat) - 1),
        west: wrap(Math.min(origin.lon, end) - 1),
        east: wrap(Math.max(origin.lon, end) + 1),
    };
}

/** Fixed policy, not a preference or a claim that a new data product is deployed. */
export const CURRENT_REGIONAL_POLICY = Object.freeze({ cmemsOcean: false, cmemsTide: false, rtofsOcean: false });
const TRUSTED_KEYS: ReadonlyMap<string, Uint8Array> = new Map();

/** Pure finite request inventory; even an accidental worldwide bbox stops before any fetch. */
export function currentRegionsForBounds(bounds: CurrentBounds): string[] | null {
    const halves = splitCurrentBounds(bounds);
    if (!halves) return null;
    const ids = new Set<string>();
    for (const half of halves) {
        const minY = Math.max(0, Math.floor((half.south + 90) / 2));
        const maxY = Math.min(89, Math.ceil((half.north + 90) / 2) - 1);
        const minX = Math.max(0, Math.floor((half.west + 180) / 2));
        const maxX = Math.min(179, Math.ceil((half.east + 180) / 2) - 1);
        if ((maxY - minY + 1) * (maxX - minX + 1) > CURRENT_SERIES_MAX_TILES) return null;
        for (let y = minY; y <= maxY; y++)
            for (let x = minX; x <= maxX; x++) {
                ids.add(`t-${y}-${x}`);
                if (ids.size > CURRENT_SERIES_MAX_TILES) return null;
            }
    }
    return ids.size ? [...ids].sort() : null;
}

export interface CurrentRegionalSource {
    keys: ReadonlyMap<string, Uint8Array>;
    /** All bytes, including signed metadata, count against one request-wide cap. */
    read(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}

/** One serial cohort at a time, no persistent decoded cache, no partial field publication. */
export function createCurrentRegionalLoader(source: CurrentRegionalSource) {
    let active = false;
    return async (request: CurrentRegionalRequest): Promise<CurrentSeries | null> => {
        const model = request.model ?? 'CMEMS',
            components = request.components ?? 'ocean';
        const ids = currentRegionsForBounds(request.bounds);
        if (
            active ||
            request.satelliteMode ||
            request.signal?.aborted ||
            !ids ||
            !source.keys.size ||
            !['CMEMS', 'RTOFS'].includes(model) ||
            !['ocean', 'ocean+tide'].includes(components) ||
            !Number.isSafeInteger(request.startMs) ||
            !Number.isSafeInteger(request.endMs) ||
            request.startMs > request.endMs ||
            request.endMs - request.startMs > 120 * 3_600_000
        )
            return null;
        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, CURRENT_REGIONAL_DEADLINE_MS);
        let cancelRace: (() => void) | undefined;
        const stopped = new Promise<null>((resolve) => {
            cancelRace = () => resolve(null);
            controller.signal.addEventListener('abort', cancelRace, { once: true });
        });
        active = true;
        const work = (async () => {
            let downloaded = 0,
                decoded = 0;
            const read = async (path: string, maxBytes: number) => {
                if (controller.signal.aborted) throw new Error('cancelled');
                const limit = Math.min(maxBytes, CURRENT_REGIONAL_DOWNLOAD_BYTES - downloaded);
                if (limit <= 0) throw new Error('download cap');
                const bytes = await source.read(path, limit, controller.signal);
                if (controller.signal.aborted || !(bytes instanceof Uint8Array) || bytes.byteLength > limit)
                    throw new Error('read bounds/cancel');
                downloaded += bytes.byteLength;
                return bytes;
            };
            let combined: CurrentSeries | null = null;
            for (const id of ids) {
                const manifestBytes = await read(`${id}.json`, CURRENT_REGIONAL_MANIFEST_BYTES);
                const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
                const payload = await verifyCurrentRegionalEnvelope(envelope, source.keys);
                if (controller.signal.aborted || !payload) return null;
                const manifest = parseCurrentRegionalManifest(payload, id, Date.now());
                const asset = manifest.models[model];
                if (!asset) return null;
                const bytes = await read(asset.filename, Math.min(asset.bytes, CURRENT_REGIONAL_ASSET_BYTES));
                if ((await currentAssetSha256(bytes)) !== asset.sha256 || controller.signal.aborted) return null;
                const part = decodeCurrentRegionalAsset(bytes, manifest, model);
                decoded += validateCurrentSeries(part);
                if (decoded > CURRENT_SERIES_MAX_BYTES) return null;
                const tile = part.tiles[0];
                const planes = components === 'ocean+tide' ? [tile.ocean, tile.tide] : [tile.ocean];
                if (
                    planes.some(
                        (plane) => !plane || request.startMs < plane.times[0] || request.endMs > plane.times.at(-1)!,
                    )
                )
                    return null;
                if (!combined) combined = part;
                else {
                    if (
                        ['model', 'dataset', 'generation', 'runMs', 'units', 'vectorBasis', 'depthM'].some(
                            (key) => combined![key as keyof CurrentSeries] !== part[key as keyof CurrentSeries],
                        )
                    )
                        return null;
                    combined.tiles.push(tile);
                    combined.expiresMs = Math.min(combined.expiresMs, part.expiresMs);
                }
            }
            if (!combined || controller.signal.aborted) return null;
            combined.sourceSha256 = await currentAssetSha256(
                new TextEncoder().encode(JSON.stringify(combined.tiles.map((tile) => [tile.id, tile.sourceSha256]))),
            );
            validateCurrentSeries(combined);
            return controller.signal.aborted ? null : combined;
        })()
            .catch(() => null)
            .finally(() => {
                active = false;
            });
        try {
            return await Promise.race([work, stopped]);
        } finally {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', cancel);
            if (cancelRace) controller.signal.removeEventListener('abort', cancelRace);
        }
    };
}

/** Streaming, no credentials/redirects, no automatic provider fallback. */
async function readRegionalBytes(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!/^(?:t-\d{1,2}-\d{1,3}\.json|g-[a-f0-9]{24}-(?:cmems|rtofs)-t-\d{1,2}-\d{1,3}\.thcs)$/.test(path))
        throw new Error('asset path');
    const response = await fetch(`${API_BASE}/regional-currents/${path}`, {
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
    });
    const length = response.headers.get('content-length');
    if (!response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
        await response.body?.cancel();
        throw new Error('asset unavailable/size');
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (signal.aborted || bytes > maxBytes) throw new Error('asset stream cap');
            chunks.push(next.value);
        }
    } finally {
        await reader.cancel();
    }
    if (length !== null && bytes !== Number(length)) throw new Error('asset truncated');
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

const loadVerified = createCurrentRegionalLoader({ keys: TRUSTED_KEYS, read: readRegionalBytes });
/** Wired production seam remains unavailable until exact provider/terms/key/publication review. */
export async function loadRegionalCurrentSeries(request: CurrentRegionalRequest): Promise<CurrentSeries | null> {
    const allowed = request.model === 'RTOFS' ? CURRENT_REGIONAL_POLICY.rtofsOcean : CURRENT_REGIONAL_POLICY.cmemsOcean;
    if (!allowed || ((request.components ?? 'ocean') === 'ocean+tide' && !CURRENT_REGIONAL_POLICY.cmemsTide))
        return null;
    return loadVerified(request);
}

/** A manifest asset maps to its fixed10-degree release partition; never one global asset list. */
export function currentRegionPartition(id: string): string | null {
    if (!currentRegionBounds(id)) return null;
    const [, y, x] = id.split('-').map(Number);
    return `routing-currents-v1-${Math.floor(y / 5)}-${Math.floor(x / 5)}`;
}
