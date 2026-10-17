import { assertNetworkAllowed } from '../../networkPolicy';
import { readBoundedResponse, decodeUtf8Json, sha256Hex } from './cmemsGridTrust';
import {
    decodeOpticalPointer,
    decodeOpticalIndex,
    decodeOpticalTile,
    opticalViewportTiles,
    OPTICAL_LIMITS,
    type OpticalIndex,
    type OpticalFlash,
} from './opticalLightningContract';
const BASE = 'https://tiles.thalassatiles.com/optical-lightning/v1/';
let unfinished = 0;
const retired = () => new DOMException('Satellite optical owner retired', 'AbortError');
function owned<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => reject(retired());
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        pending.then(
            (value) => {
                signal.removeEventListener('abort', cancel);
                if (!signal.aborted) resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', cancel);
                reject(error);
            },
        );
    });
}
export interface OpticalSession {
    readonly index: OpticalIndex;
    readViewport(
        bounds: readonly [number, number, number, number],
    ): Promise<{ rows: OpticalFlash[]; revision: number; truncated: boolean }>;
    isCurrent(): boolean;
    close(): void;
}
/** Explicit foreground owner only. No global data cache, poll, retry or provider request. */
export async function openOpticalSession(signal: AbortSignal, ownerCurrent: () => boolean): Promise<OpticalSession> {
    const controller = new AbortController(),
        opened = Date.now(),
        started = performance.now();
    let index: OpticalIndex | null = null,
        closed = false,
        reserved = 0,
        epoch = 0,
        viewport: AbortController | null = null;
    const current = () => {
        try {
            assertNetworkAllowed('grib', 'Satellite optical lightning');
            const live =
                !closed &&
                !signal.aborted &&
                !controller.signal.aborted &&
                ownerCurrent() &&
                Date.now() >= opened &&
                performance.now() - started < 5 * 60000 &&
                (!index || Date.now() < index.expiresAt);
            if (!live) close();
            return live;
        } catch {
            close();
            return false;
        }
    };
    const close = () => {
        closed = true;
        controller.abort();
        viewport?.abort();
        viewport = null;
        index = null;
        signal.removeEventListener('abort', close);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    const requireCurrent = () => {
        if (!current()) throw retired();
    };
    const read = async (
        path: string,
        cap: number,
        parent: AbortSignal,
        expected?: { bytes: number; sha256: string },
    ) => {
        requireCurrent();
        if (reserved + cap > OPTICAL_LIMITS.session || unfinished >= 2)
            throw Error('Satellite optical capacity unavailable');
        reserved += cap;
        unfinished++;
        const request = new AbortController(),
            cancel = () => request.abort();
        controller.signal.addEventListener('abort', cancel, { once: true });
        parent.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted || parent.aborted) cancel();
        const deadline = setTimeout(cancel, 10000);
        const pending = (async () => {
            const response = await fetch(BASE + path, { signal: request.signal, redirect: 'error', cache: 'no-cache' });
            if (!response.ok) {
                await response.body?.cancel();
                throw Error('Satellite optical unavailable');
            }
            const bytes = await readBoundedResponse(response, cap, request.signal);
            if (expected && (bytes.byteLength !== expected.bytes || (await sha256Hex(bytes)) !== expected.sha256))
                throw Error('Satellite optical checksum mismatch');
            requireCurrent();
            if (request.signal.aborted) throw retired();
            return decodeUtf8Json(bytes);
        })().finally(() => {
            unfinished--;
            clearTimeout(deadline);
            controller.signal.removeEventListener('abort', cancel);
            parent.removeEventListener('abort', cancel);
        });
        return owned(pending, request.signal);
    };
    try {
        const pointer = decodeOpticalPointer(await read('latest.json', 1024, controller.signal), Date.now());
        const generation = pointer.generation;
        index = decodeOpticalIndex(
            await read(`generations/${generation}/index.json`, OPTICAL_LIMITS.index, controller.signal, {
                bytes: pointer.indexBytes,
                sha256: generation,
            }),
            pointer,
            Date.now(),
        );
        requireCurrent();
        return {
            get index() {
                if (!index) throw retired();
                return index;
            },
            isCurrent: current,
            close,
            async readViewport(bounds) {
                requireCurrent();
                viewport?.abort();
                viewport = null;
                const revision = ++epoch,
                    keys = opticalViewportTiles(bounds),
                    selected = index!;
                const request = new AbortController();
                viewport = request;
                const rows: OpticalFlash[] = [];
                let truncated = selected.truncated;
                for (const key of keys) {
                    const entry = selected.tiles[key];
                    if (!entry) continue;
                    const value = await read(
                        `generations/${generation}/tile-${key}.json`,
                        OPTICAL_LIMITS.tile,
                        request.signal,
                        entry,
                    );
                    requireCurrent();
                    if (request.signal.aborted || revision !== epoch) throw retired();
                    rows.push(...decodeOpticalTile(value, key, selected, Date.now()));
                }
                rows.sort((a, b) => b[2] - a[2] || a[4] - b[4] || a[5].localeCompare(b[5]));
                if (rows.length > OPTICAL_LIMITS.points) {
                    rows.length = OPTICAL_LIMITS.points;
                    truncated = true;
                }
                requireCurrent();
                if (request.signal.aborted || revision !== epoch) throw retired();
                return { rows, revision, truncated };
            },
        };
    } catch (error) {
        close();
        throw error;
    }
}
