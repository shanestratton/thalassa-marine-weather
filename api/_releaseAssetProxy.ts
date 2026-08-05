import {
    canonicalMarineGeneration,
    marineAssetShardTag,
    validateMarineManifest,
} from '../services/weather/api/marineManifestContract';

type DatasetKey = 'currents' | 'waves' | 'sst' | 'chl' | 'seaice' | 'mld' | 'mpa';

type DatasetProxySpec = {
    id: string;
    releaseTag: string;
    steps: number;
    cadenceHours: number | null;
    maxAssetBytes: number;
};

const OWNER_REPO = 'shanestratton/thalassa-marine-weather';
const MANIFEST_MAX_BYTES = 256 * 1024;
const LEGACY_MANIFEST_NAME = 'manifest.json';
const V2_MANIFEST_NAME = 'manifest-v2.json';
const V2_MANIFEST_SLOTS = ['manifest-v2-a.json', 'manifest-v2-b.json'] as const;
const MANIFEST_SLOT_TIMEOUT_MS = 8_000;
const CMEMS_V1_BRIDGE_SUNSET_MS = Date.parse('2026-08-20T00:00:00Z');
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_REDIRECTS = 2;
const RESPONSE_STREAM_CHUNK_BYTES = 64 * 1024;
const TRUSTED_UPSTREAM_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com']);
const GENERATION_PATTERN = /^g-(\d{8}T\d{6}Z)-([0-9a-f]{12})$/;
const CMEMS_ASSET_PATTERN = /^(g-\d{8}T\d{6}Z-[0-9a-f]{12})-h(\d{3})\.bin$/;
const MPA_ASSET_PATTERN = /^(g-\d{8}T\d{6}Z-[0-9a-f]{12})-mpa\.geojson$/;
const LEGACY_CMEMS_ASSET_PATTERN = /^h(\d{2})\.bin$/;
const SHARD_TAG_PATTERN = /^[a-z0-9-]+-assets-\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const DATASET_PROXY_SPECS: Record<DatasetKey, DatasetProxySpec> = {
    currents: {
        id: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
        releaseTag: 'cmems-currents-latest',
        steps: 13,
        cadenceHours: 1,
        maxAssetBytes: 16 * 1024 * 1024,
    },
    waves: {
        id: 'cmems_mod_glo_wav_anfc_0.083deg_PT3H-i',
        releaseTag: 'cmems-waves-latest',
        steps: 17,
        cadenceHours: 3,
        maxAssetBytes: 16 * 1024 * 1024,
    },
    sst: {
        id: 'cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m',
        releaseTag: 'cmems-sst-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
    },
    chl: {
        id: 'cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m',
        releaseTag: 'cmems-chl-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
    },
    seaice: {
        id: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',
        releaseTag: 'cmems-seaice-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
    },
    mld: {
        id: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',
        releaseTag: 'cmems-mld-latest',
        steps: 6,
        cadenceHours: 24,
        maxAssetBytes: 16 * 1024 * 1024,
    },
    mpa: {
        id: 'dcceew-capad-mapserver-layer-1',
        releaseTag: 'mpa-aus-latest',
        steps: 1,
        cadenceHours: null,
        maxAssetBytes: 16 * 1024 * 1024,
    },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isUtcIso = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value.replace('Z', '.000Z');
};

function isLegacyAssetName(dataset: DatasetKey, filename: string): boolean {
    if (dataset === 'mpa') return filename === 'mpa.geojson';
    const match = filename.match(LEGACY_CMEMS_ASSET_PATTERN);
    return match !== null && Number(match[1]) < DATASET_PROXY_SPECS[dataset].steps;
}

function legacyCmemsBridgeEnabled(): boolean {
    return process.env.THALASSA_CMEMS_V1_BRIDGE_ENABLED === 'true' && Date.now() < CMEMS_V1_BRIDGE_SUNSET_MS;
}

function generationForAsset(dataset: DatasetKey, filename: string): string | null {
    if (dataset === 'mpa') {
        return filename.match(MPA_ASSET_PATTERN)?.[1] ?? null;
    }
    const match = filename.match(CMEMS_ASSET_PATTERN);
    if (!match) return null;
    const step = Number(match[2]);
    return Number.isSafeInteger(step) && step < DATASET_PROXY_SPECS[dataset].steps ? match[1] : null;
}

export function assetShardTag(dataset: DatasetKey, generation: string): string {
    const tag = marineAssetShardTag(dataset, generation);
    if (!SHARD_TAG_PATTERN.test(tag)) throw new Error('derived shard tag invalid');
    return tag;
}

async function assertManifest(value: unknown, dataset: DatasetKey): Promise<Record<string, unknown>> {
    // The same executable contract runs in the public clients and hosted gate.
    // Currentness is evaluated after both slots have completed independently.
    validateMarineManifest(value, dataset, Date.now(), false);
    if (!isRecord(value)) throw new Error('manifest root');
    const rootKeys = [
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
    const keys = Object.keys(value);
    const expectedKeys = keys.includes('metadata') ? [...rootKeys, 'metadata'] : rootKeys;
    if (!hasExactKeys(value, expectedKeys)) throw new Error('manifest fields');
    const spec = DATASET_PROXY_SPECS[dataset];
    if (value.schema_version !== 2) throw new Error('schema version');
    if (
        !isRecord(value.dataset) ||
        !hasExactKeys(value.dataset, ['key', 'id']) ||
        value.dataset.key !== dataset ||
        value.dataset.id !== spec.id
    )
        throw new Error('dataset identity');
    if (typeof value.generation !== 'string' || !GENERATION_PATTERN.test(value.generation))
        throw new Error('generation');
    if (![value.generated_at, value.published_at, value.data_start, value.data_end].every(isUtcIso))
        throw new Error('timestamps');
    if (Date.parse(value.published_at as string) < Date.parse(value.generated_at as string))
        throw new Error('publication chronology');
    if (Date.parse(value.generated_at as string) < Date.parse(value.data_start as string))
        throw new Error('generation chronology');
    if (Date.parse(value.data_end as string) < Date.parse(value.data_start as string))
        throw new Error('data chronology');
    if (value.cadence_hours !== spec.cadenceHours) throw new Error('cadence');
    if (!isRecord(value.bounds) || !hasExactKeys(value.bounds, ['north', 'south', 'west', 'east']))
        throw new Error('bounds');
    const { north, south, west, east } = value.bounds;
    if (
        ![north, south, west, east].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    )
        throw new Error('bounds values');
    if (!((north as number) > (south as number) && (east as number) > (west as number)))
        throw new Error('bounds orientation');
    if (!isRecord(value.producer) || !hasExactKeys(value.producer, ['commit', 'run_id', 'run_attempt']))
        throw new Error('producer');
    if (typeof value.producer.commit !== 'string' || !COMMIT_PATTERN.test(value.producer.commit))
        throw new Error('producer commit');
    if (
        ![value.producer.run_id, value.producer.run_attempt].every(
            (part) => Number.isSafeInteger(part) && (part as number) > 0,
        )
    )
        throw new Error('producer run');
    if (!Array.isArray(value.files) || value.files.length !== spec.steps) throw new Error('files count');

    value.files.forEach((entry, index) => {
        if (!isRecord(entry)) throw new Error('file entry');
        const entryKeys =
            dataset === 'mpa'
                ? ['step', 'filename', 'bytes', 'sha256', 'content_type']
                : ['step', 'offset_hours', 'data_time', 'filename', 'bytes', 'sha256', 'content_type'];
        if (!hasExactKeys(entry, entryKeys) || entry.step !== index) throw new Error('file fields');
        const expectedFilename =
            dataset === 'mpa'
                ? `${value.generation}-mpa.geojson`
                : `${value.generation}-h${String(index).padStart(3, '0')}.bin`;
        if (entry.filename !== expectedFilename || generationForAsset(dataset, expectedFilename) !== value.generation)
            throw new Error('file name');
        if (
            !Number.isSafeInteger(entry.bytes) ||
            (entry.bytes as number) <= 0 ||
            (entry.bytes as number) > spec.maxAssetBytes
        )
            throw new Error('file bytes');
        if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) throw new Error('file digest');
        const expectedType = dataset === 'mpa' ? 'application/geo+json' : 'application/octet-stream';
        if (entry.content_type !== expectedType) throw new Error('file content type');
        if (dataset !== 'mpa') {
            if (entry.offset_hours !== index * (spec.cadenceHours as number) || !isUtcIso(entry.data_time))
                throw new Error('file time');
            if (
                Date.parse(entry.data_time) - Date.parse(value.data_start as string) !==
                index * (spec.cadenceHours as number) * 3_600_000
            )
                throw new Error('file cadence');
        }
    });

    const expectedGeneration = await computeGeneration(
        value.data_start as string,
        dataset,
        value.files.map((entry) => (entry as Record<string, unknown>).sha256 as string),
    );
    if (value.generation !== expectedGeneration) throw new Error('generation digest');

    if (!isRecord(value.dimensions)) throw new Error('dimensions');
    if (dataset === 'mpa') {
        if (
            !hasExactKeys(value.dimensions, ['feature_count']) ||
            !Number.isSafeInteger(value.dimensions.feature_count) ||
            (value.dimensions.feature_count as number) < 100 ||
            (value.dimensions.feature_count as number) > 50_000
        )
            throw new Error('MPA dimensions');
        if (value.data_end !== value.data_start) throw new Error('MPA source time');
        if (!((west as number) >= 70 && (west as number) <= 80 && (east as number) >= 165 && (east as number) <= 180))
            throw new Error('MPA longitude coverage');
        if (
            !(
                (south as number) >= -60 &&
                (south as number) <= -55 &&
                (north as number) >= -10 &&
                (north as number) <= 0
            )
        )
            throw new Error('MPA latitude coverage');
        if ((east as number) - (west as number) < 90 || (north as number) - (south as number) < 45)
            throw new Error('MPA coverage span');
    } else {
        if (!hasExactKeys(value.dimensions, ['width', 'height'])) throw new Error('grid dimensions');
        if (
            !Number.isSafeInteger(value.dimensions.width) ||
            !Number.isSafeInteger(value.dimensions.height) ||
            (value.dimensions.width as number) < 1300 ||
            (value.dimensions.width as number) > 1500 ||
            (value.dimensions.height as number) < 600 ||
            (value.dimensions.height as number) > 750
        )
            throw new Error('grid dimensions');
        if (
            !(
                (north as number) >= 89 &&
                (south as number) <= -79 &&
                (west as number) <= -179 &&
                (east as number) >= 179
            )
        )
            throw new Error('global grid coverage');
        if (
            Date.parse(value.data_end as string) - Date.parse(value.data_start as string) !==
            (spec.steps - 1) * (spec.cadenceHours as number) * 3_600_000
        )
            throw new Error('data window');
    }
    return value;
}

async function readWithSignal(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) {
        cancelReaderWithoutWaiting(reader, 'upstream request aborted');
        throw new Error('upstream request aborted');
    }
    return new Promise((resolve, reject) => {
        const abort = () => {
            cancelReaderWithoutWaiting(reader, 'upstream request aborted');
            reject(new Error('upstream request aborted'));
        };
        signal.addEventListener('abort', abort, { once: true });
        reader.read().then(
            (result) => {
                signal.removeEventListener('abort', abort);
                resolve(result);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            },
        );
    });
}

/** Abort promptly while still observing an upstream cancellation rejection. */
function cancelReaderWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
    try {
        void reader.cancel(reason).catch(() => undefined);
    } catch {
        // A concurrently failed stream may throw before returning its promise.
    }
}

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
    if (!response.body) return;
    try {
        await response.body.cancel(reason);
    } catch {
        // A concurrently aborted or already errored body may reject cancel().
        // Awaiting it is still required so rejected upstream connections are
        // never left unobserved merely because cleanup itself failed.
    }
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
        await cancelResponseBody(response, 'upstream content length rejected');
        throw new Error('upstream size');
    }
    if (!response.body) throw new Error('upstream body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await readWithSignal(reader, signal);
        if (done) break;
        total += value.byteLength;
        if (total > maximum) {
            await reader.cancel('response exceeded limit');
            throw new Error('upstream size');
        }
        chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function fetchTrustedUpstream(url: string, signal: AbortSignal, cache?: RequestCache): Promise<Response> {
    let current = new URL(url);
    for (let redirectCount = 0; redirectCount <= MAX_UPSTREAM_REDIRECTS; redirectCount += 1) {
        if (current.protocol !== 'https:' || !TRUSTED_UPSTREAM_HOSTS.has(current.hostname)) {
            throw new Error('untrusted release redirect');
        }
        const response = await fetch(current.toString(), { redirect: 'manual', signal, ...(cache ? { cache } : {}) });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        await cancelResponseBody(response, 'following trusted release redirect');
        if (!location || redirectCount === MAX_UPSTREAM_REDIRECTS) throw new Error('invalid release redirect');
        current = new URL(location, current);
    }
    throw new Error('too many release redirects');
}

export type ManifestSlotCandidate = {
    slot: (typeof V2_MANIFEST_SLOTS)[number];
    body: Uint8Array<ArrayBuffer>;
    manifest: Record<string, unknown>;
    upstreamEtag: string | null;
};

export function selectNewestManifestSlot(candidates: ManifestSlotCandidate[]): ManifestSlotCandidate | null {
    if (candidates.length === 0) return null;
    return (
        [...candidates].sort((left, right) => {
            const leftStart = Date.parse(left.manifest.data_start as string);
            const rightStart = Date.parse(right.manifest.data_start as string);
            if (leftStart !== rightStart) return rightStart - leftStart;
            const leftPublished = Date.parse(left.manifest.published_at as string);
            const rightPublished = Date.parse(right.manifest.published_at as string);
            if (leftPublished !== rightPublished) return rightPublished - leftPublished;
            const generationOrder = (right.manifest.generation as string).localeCompare(
                left.manifest.generation as string,
            );
            if (generationOrder !== 0) return generationOrder;
            return right.slot.localeCompare(left.slot);
        })[0] ?? null
    );
}

async function fetchManifestSlot(
    dataset: DatasetKey,
    releaseTag: string,
    slot: (typeof V2_MANIFEST_SLOTS)[number],
    signal: AbortSignal,
): Promise<ManifestSlotCandidate | null> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal.reason);
    if (signal.aborted) abortFromParent();
    else signal.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('manifest slot timed out')), MANIFEST_SLOT_TIMEOUT_MS);
    try {
        const upstream = await fetchTrustedUpstream(
            `https://github.com/${OWNER_REPO}/releases/download/${releaseTag}/${slot}`,
            controller.signal,
            'no-store',
        );
        if (upstream.status !== 200) {
            await cancelResponseBody(upstream, 'manifest slot status rejected');
            return null;
        }
        const upstreamType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!new Set(['application/json', 'application/octet-stream', 'text/plain']).has(upstreamType)) {
            await cancelResponseBody(upstream, 'manifest slot content type rejected');
            return null;
        }
        const body = await readBounded(upstream, MANIFEST_MAX_BYTES, controller.signal);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        const manifest = await assertManifest(JSON.parse(text), dataset);
        return { slot, body, manifest, upstreamEtag: upstream.headers.get('etag') };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortFromParent);
    }
}

async function fetchSelectedManifest(
    dataset: DatasetKey,
    releaseTag: string,
    signal: AbortSignal,
): Promise<(ManifestSlotCandidate & { validSlotCount: number }) | null> {
    const now = Date.now();
    const candidates = (
        await Promise.all(V2_MANIFEST_SLOTS.map((slot) => fetchManifestSlot(dataset, releaseTag, slot, signal)))
    ).filter((candidate): candidate is ManifestSlotCandidate => {
        if (candidate === null) return false;
        try {
            validateMarineManifest(candidate.manifest, dataset, now, true);
            return true;
        } catch {
            return false;
        }
    });
    const selected = selectNewestManifestSlot(candidates);
    return selected === null ? null : { ...selected, validSlotCount: candidates.length };
}

function synthesizeLegacyManifest(selected: ManifestSlotCandidate, dataset: DatasetKey): Uint8Array<ArrayBuffer> {
    if (dataset === 'mpa') throw new Error('MPA has no safe legacy bridge');
    const manifest = selected.manifest;
    const legacy = {
        version: 1,
        generated_at: manifest.data_start,
        hours: (manifest.files as Array<Record<string, unknown>>).map((file) => ({
            hour: file.offset_hours,
            // The generation-qualified name is the coherence token: a
            // later slot flip cannot redirect this v1 manifest to a
            // different binary generation.
            file: file.filename,
            bytes: file.bytes,
        })),
    };
    return new TextEncoder().encode(`${JSON.stringify(legacy)}\n`);
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<{ hex: string; base64: string }> {
    const value = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const base64 = btoa(String.fromCharCode(...value));
    return { hex, base64 };
}

export async function computeGeneration(dataStart: string, dataset: DatasetKey, hashes: string[]): Promise<string> {
    return canonicalMarineGeneration(dataStart, dataset, hashes);
}

function errorResponse(status: number, message: string): Response {
    return new Response(message, {
        status,
        headers: {
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'accept-ranges': 'none',
            'content-type': 'text/plain; charset=utf-8',
            'x-content-type-options': 'nosniff',
        },
    });
}

/**
 * Vercel applies its non-streaming response payload limit before a buffered
 * Function response reaches the client. The proxy authenticates the complete
 * object first, then streams those verified bytes so valid CMEMS/MPA assets
 * above the platform's buffered-response limit can still be delivered.
 */
function streamVerifiedBody(body: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            if (offset >= body.byteLength) {
                controller.close();
                return;
            }
            const end = Math.min(offset + RESPONSE_STREAM_CHUNK_BYTES, body.byteLength);
            controller.enqueue(body.slice(offset, end));
            offset = end;
        },
    });
}

export async function proxyReleaseAsset(request: Request, dataset: DatasetKey): Promise<Response> {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-headers': 'If-None-Match',
                'access-control-allow-methods': 'GET, OPTIONS',
                'access-control-allow-origin': '*',
                'access-control-max-age': '86400',
                'cache-control': 'public, max-age=86400',
            },
        });
    }
    if (request.method !== 'GET') {
        return new Response('Method not allowed', {
            status: 405,
            headers: { allow: 'GET, OPTIONS', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
        });
    }
    // Integrity headers cover the complete immutable object. Partial bodies
    // cannot be independently authenticated against the release manifest.
    if (request.headers.has('range')) return errorResponse(400, 'Range requests are not supported');
    const rawSegment = new URL(request.url).pathname.split('/').pop() ?? '';
    let filename: string;
    try {
        filename = decodeURIComponent(rawSegment);
    } catch {
        return errorResponse(400, 'Invalid asset name');
    }
    const spec = DATASET_PROXY_SPECS[dataset];
    const isLegacyManifest = filename === LEGACY_MANIFEST_NAME;
    const isV2Manifest = filename === V2_MANIFEST_NAME;
    const isManifest = isLegacyManifest || isV2Manifest;
    const isLegacyAsset = isLegacyAssetName(dataset, filename);
    const assetGeneration = isManifest || isLegacyAsset ? null : generationForAsset(dataset, filename);
    if (!isManifest && !isLegacyAsset && assetGeneration === null) return errorResponse(400, 'Invalid asset name');
    if (isLegacyAsset || (isLegacyManifest && (dataset === 'mpa' || !legacyCmemsBridgeEnabled()))) {
        return errorResponse(410, 'Legacy marine publication path is retired');
    }

    let releaseTag: string;
    try {
        releaseTag = isManifest || isLegacyAsset ? spec.releaseTag : assetShardTag(dataset, assetGeneration as string);
    } catch {
        return errorResponse(400, 'Invalid asset generation');
    }
    const controller = new AbortController();
    const abortFromClient = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortFromClient();
    else request.signal.addEventListener('abort', abortFromClient, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('release upstream timed out')), UPSTREAM_TIMEOUT_MS);
    try {
        try {
            let body: Uint8Array<ArrayBuffer>;
            let generation = assetGeneration;
            let upstreamEtag: string | null = null;
            let selectedSlot: string | null = null;
            let validSlotCount: number | null = null;
            if (isV2Manifest || isLegacyManifest) {
                const selected = await fetchSelectedManifest(dataset, releaseTag, controller.signal);
                if (selected === null) return errorResponse(502, 'No valid dataset manifest slot');
                body = isLegacyManifest ? synthesizeLegacyManifest(selected, dataset) : selected.body;
                generation = selected.manifest.generation as string;
                upstreamEtag = isLegacyManifest ? null : selected.upstreamEtag;
                selectedSlot = selected.slot;
                validSlotCount = selected.validSlotCount;
            } else {
                const upstream = await fetchTrustedUpstream(
                    `https://github.com/${OWNER_REPO}/releases/download/${releaseTag}/${encodeURIComponent(filename)}`,
                    controller.signal,
                );
                if (upstream.status !== 200) {
                    await cancelResponseBody(upstream, 'upstream status rejected');
                    return errorResponse(upstream.status === 404 ? 404 : 502, 'Dataset upstream rejected response');
                }
                const upstreamType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
                const allowedTypes =
                    dataset === 'mpa'
                        ? new Set(['application/geo+json', 'application/json', 'application/octet-stream'])
                        : new Set(['application/octet-stream']);
                if (!allowedTypes.has(upstreamType)) {
                    await cancelResponseBody(upstream, 'upstream content type rejected');
                    return errorResponse(502, 'Dataset upstream content type rejected');
                }
                try {
                    body = await readBounded(upstream, spec.maxAssetBytes, controller.signal);
                } catch {
                    return errorResponse(502, 'Dataset upstream body rejected');
                }
                upstreamEtag = upstream.headers.get('etag');
            }
            const integrity = await digest(body);
            if (controller.signal.aborted) return errorResponse(502, 'Dataset upstream body rejected');
            const etag = `"${integrity.hex}"`;
            const headers = new Headers({
                'access-control-allow-origin': '*',
                'access-control-expose-headers':
                    'Content-Digest, ETag, X-Content-SHA256, X-Thalassa-Generation, X-Thalassa-Selected-Manifest-Slot, X-Thalassa-Valid-Manifest-Slots',
                'accept-ranges': 'none',
                'cache-control': isManifest ? 'no-store' : 'public, max-age=31536000, s-maxage=31536000, immutable',
                'content-digest': `sha-256=:${integrity.base64}:`,
                'content-type': isManifest
                    ? 'application/json; charset=utf-8'
                    : dataset === 'mpa'
                      ? 'application/geo+json; charset=utf-8'
                      : 'application/octet-stream',
                etag,
                'x-content-sha256': integrity.hex,
                'x-content-type-options': 'nosniff',
            });
            if (generation !== null) headers.set('x-thalassa-generation', generation);
            if (selectedSlot !== null) headers.set('x-thalassa-selected-manifest-slot', selectedSlot);
            if (validSlotCount !== null) headers.set('x-thalassa-valid-manifest-slots', String(validSlotCount));
            if (upstreamEtag && upstreamEtag.length <= 200 && !/[\r\n]/.test(upstreamEtag))
                headers.set('x-upstream-etag', upstreamEtag);
            if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
            return new Response(streamVerifiedBody(body), { status: 200, headers });
        } catch {
            return errorResponse(502, 'Dataset upstream unavailable');
        }
    } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', abortFromClient);
    }
}

export type { DatasetKey };
export { assertManifest };
