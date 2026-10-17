import { assertNetworkAllowed } from '../networkPolicy';
import { decodeUtf8Json, readBoundedResponse, sha256Hex } from '../weather/api/cmemsGridTrust';
import { CLIMATE_LIMITS, climateTileKey, parseClimateCell, type ClimateCell } from './era5Climate';

const BASE = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/weather/climate/era5-v1/';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const byteSize = (v: unknown, cap: number): v is number =>
    Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= cap;
let activeReads = 0;
function current(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Climate request retired', 'AbortError');
}
async function owned<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(new DOMException('Climate request retired', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
    });
    if (signal.aborted) cancel();
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}
export async function readEra5Climate(
    weights: ReadonlyMap<string, number>,
    signal: AbortSignal,
): Promise<{ cells: Map<string, ClimateCell>; generatedAt: string; generation: string }> {
    if (!weights.size || weights.size > CLIMATE_LIMITS.cells) throw new Error('Climate route limit');
    const tileKeys = [...new Set([...weights.keys()].map(climateTileKey))];
    if (tileKeys.length > CLIMATE_LIMITS.tiles) throw new Error('Climate tile limit');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const deadline = setTimeout(cancel, 45000);
    let total = 0;
    const read = async (path: string, cap: number, expected?: { bytes: number; sha256: string }) => {
        current(controller.signal);
        assertNetworkAllowed('offline-download', 'Climate distributions');
        if (activeReads >= 2) throw new Error('Climate read capacity unavailable');
        activeReads++;
        // Keep the slot charged until the actual native task settles, even if cancellation wins.
        const pending = (async () => {
            const response = await fetch(BASE + path, {
                signal: controller.signal,
                redirect: 'error',
                cache: 'no-cache',
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Climate data unavailable');
            }
            const bytes = await readBoundedResponse(response, cap, controller.signal);
            total += bytes.byteLength;
            if (total > CLIMATE_LIMITS.totalBytes) throw new Error('Climate aggregate byte limit');
            if (expected && (bytes.byteLength !== expected.bytes || (await sha256Hex(bytes)) !== expected.sha256))
                throw new Error('Climate checksum mismatch');
            current(controller.signal);
            assertNetworkAllowed('offline-download', 'Climate distributions');
            return decodeUtf8Json(bytes);
        })().finally(() => {
            activeReads--;
        });
        return owned(pending, controller.signal);
    };
    try {
        const pointer = await read('latest.json', 2048);
        if (
            !object(pointer) ||
            pointer.schema !== 1 ||
            !hash(pointer.generation) ||
            !object(pointer.manifest) ||
            !byteSize(pointer.manifest.bytes, 524288) ||
            !hash(pointer.manifest.sha256)
        )
            throw new Error('Climate pointer unavailable');
        const generation = pointer.generation;
        const manifest = await read(`${generation}/manifest.json`, 524288, {
            bytes: pointer.manifest.bytes,
            sha256: pointer.manifest.sha256,
        });
        if (
            !object(manifest) ||
            manifest.schema !== 1 ||
            manifest.kind !== 'era5-climate' ||
            manifest.generation !== generation ||
            manifest.firstYear !== 1991 ||
            manifest.lastYear !== 2020 ||
            manifest.gridDegrees !== 1 ||
            manifest.originals !== 720 ||
            manifest.dataset !== 'reanalysis-era5-complete' ||
            manifest.licence !== 'CC-BY-4.0' ||
            manifest.method !== 'hourly-uv-swh-mwd-v1' ||
            !hash(manifest.originalCohortSha256) ||
            typeof manifest.generatedAt !== 'string' ||
            !Number.isFinite(Date.parse(manifest.generatedAt)) ||
            Date.parse(manifest.generatedAt) < Date.UTC(2021, 0, 1) ||
            Date.parse(manifest.generatedAt) > Date.now() + 60000 ||
            !object(manifest.tiles) ||
            Object.keys(manifest.tiles).length > 2664
        )
            throw new Error('Climate manifest unavailable');
        const cells = new Map<string, ClimateCell>();
        for (const key of tileKeys) {
            const entry = manifest.tiles[key];
            if (entry === undefined) continue; // A missing tile is missing coverage, not a zero climate.
            if (!object(entry) || !byteSize(entry.bytes, CLIMATE_LIMITS.tileBytes) || !hash(entry.sha256))
                throw new Error('Climate tile descriptor unavailable');
            const tile = await read(`${generation}/tile-${key}.json`, CLIMATE_LIMITS.tileBytes, {
                bytes: entry.bytes,
                sha256: entry.sha256,
            });
            if (
                !object(tile) ||
                tile.schema !== 1 ||
                tile.generation !== generation ||
                tile.key !== key ||
                !Array.isArray(tile.cells) ||
                tile.cells.length > 25
            )
                throw new Error('Climate tile unavailable');
            const seen = new Set<string>();
            for (const raw of tile.cells) {
                const cell = parseClimateCell(raw);
                if (!cell || climateTileKey(cell.key) !== key || seen.has(cell.key))
                    throw new Error('Climate cell unavailable');
                seen.add(cell.key);
                if (weights.has(cell.key)) cells.set(cell.key, cell);
            }
        }
        current(controller.signal);
        return { cells, generatedAt: manifest.generatedAt, generation };
    } finally {
        clearTimeout(deadline);
        signal.removeEventListener('abort', cancel);
        controller.abort();
    }
}
