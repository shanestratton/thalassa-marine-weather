import { aromeDomain } from '../../../services/weather/aromeDomains.ts';
import { type AromePointForecast } from '../../../services/weather/aromePointContract.ts';
import {
    AROME_MANIFEST_BYTES,
    AROME_SLOT_BYTES,
    AROME_STATIC_ORIGIN,
    AROME_TILE_BYTES,
    aromePointFromTile,
    aromeSha256,
    aromeTileAt,
    parseAromeManifest,
    parseAromeSlot,
} from '../../../services/weather/aromeStaticContract.ts';

export const AROME_UPSTREAM_MS = 10_000;

async function readLimited(body: ReadableStream<Uint8Array>, max: number, signal: AbortSignal): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            const next = await reader.read();
            if (signal.aborted) throw new Error('Original regional source retired');
            if (next.done) break;
            size += next.value.byteLength;
            if (size > max || chunks.length >= 4096) throw new Error('Original regional byte limit');
            chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    } finally {
        signal.removeEventListener('abort', abort);
        // Do not wait for an uncooperative transport to acknowledge cancellation.
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

/** Maximum four fixed public object reads: two <=4KiB discovery slots, one
 * <=256KiB immutable manifest, one <=3MiB compressed original-grid tile.
 * All reads, hashing and bounded inflation share the original ten-second limit.
 * This does not expose or require an HTTP service into the private wx machine.
 */
export async function fetchAromeFromStatic(
    model: string,
    point: { lat: number; lon: number },
    env: (name: string) => string | undefined,
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
): Promise<AromePointForecast> {
    const domain = aromeDomain(model);
    if (!domain || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        throw new Error('Unreviewed regional request');
    }
    const [south, north, west, east] = domain.region;
    if (point.lat < south || point.lat > north || point.lon < west || point.lon > east) {
        throw new Error('Outside regional domain');
    }
    // Held until native source admission and an independently checked first
    // immutable publication. No origin or bearer override is accepted.
    if (env('THALASSA_AROME_STATIC_ENABLED') !== 'true') throw new Error('Own regional source unavailable');
    const controller = new AbortController();
    const responses = new Set<Response>();
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new Error('Own regional source deadline'));
    }, AROME_UPSTREAM_MS);
    const get = async (suffix: string, limit: number, absent = false): Promise<Uint8Array | null> => {
        if (controller.signal.aborted) throw new Error('Original regional source retired');
        const response = await fetcher(`${AROME_STATIC_ORIGIN}/${model}/${suffix}`, {
            method: 'GET',
            redirect: 'error',
            credentials: 'omit',
            headers: { Accept: 'application/octet-stream' },
            signal: controller.signal,
        });
        responses.add(response);
        if (controller.signal.aborted) throw new Error('Original regional source retired');
        // Public .gz objects carry application/octet-stream without an HTTP
        // Content-Encoding; otherwise automatic HTTP decoding obscures bounds.
        if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
            throw new Error('Original regional encoding refused');
        }
        if (absent && response.status === 404) return null;
        if (!response.ok || !response.body) throw new Error('Own regional source unavailable');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
            throw new Error('Original regional declared byte limit');
        }
        return readLimited(response.body, limit, controller.signal);
    };
    const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    try {
        return await Promise.race([
            (async () => {
                const slotBytes = await Promise.all([
                    get('current-0.json', AROME_SLOT_BYTES, true),
                    get('current-1.json', AROME_SLOT_BYTES, true),
                ]);
                const slots = slotBytes.map((raw) => {
                    if (!raw) return null;
                    try {
                        return parseAromeSlot(json(raw), model, now());
                    } catch {
                        return null;
                    }
                }).filter((slot) => slot !== null).sort((a, b) => Date.parse(b.runUtc) - Date.parse(a.runUtc));
                const slot = slots[0];
                if (
                    !slot || (slots.length === 2 && slots[1].runUtc === slot.runUtc &&
                        slots[1].manifestSha256 !== slot.manifestSha256)
                ) throw new Error('Original regional cohort unavailable');
                const manifestRaw = await get(`cohorts/${slot.manifestSha256}/manifest.json`, AROME_MANIFEST_BYTES);
                if (
                    !manifestRaw || manifestRaw.length !== slot.manifestBytes ||
                    await aromeSha256(manifestRaw) !== slot.manifestSha256
                ) throw new Error('Original regional manifest checksum');
                const manifest = parseAromeManifest(json(manifestRaw), slot, now());
                if (!manifest) throw new Error('Original regional manifest refused');
                const tile = aromeTileAt(manifest, point);
                if (!tile) throw new Error('Outside original regional grid');
                const packed = await get(`tiles/${tile.sha256}.bin.gz`, AROME_TILE_BYTES);
                if (!packed || packed.length !== tile.bytes || await aromeSha256(packed) !== tile.sha256) {
                    throw new Error('Original regional tile checksum');
                }
                const stream = new Blob([Uint8Array.from(packed)]).stream().pipeThrough(
                    new DecompressionStream('gzip'),
                );
                const raw = await readLimited(stream, Math.min(tile.rawBytes, AROME_TILE_BYTES), controller.signal);
                if (raw.length !== tile.rawBytes || await aromeSha256(raw) !== tile.rawSha256) {
                    throw new Error('Original regional native tile checksum');
                }
                if (controller.signal.aborted) throw new Error('Original regional source retired');
                const admitted = aromePointFromTile(raw, manifest, slot, tile, point, now());
                if (!admitted) throw new Error('Original regional sea-cell cohort unqualified');
                return admitted;
            })(),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
        controller.abort();
        for (const response of responses) {
            if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
        }
    }
}
