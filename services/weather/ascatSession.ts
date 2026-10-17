/** Caller-owned foreground satellite snapshots. No global cache or import I/O. */
import { assertNetworkAllowed } from '../networkPolicy';
import { decodeUtf8Json, readBoundedResponse, sha256Hex } from './api/cmemsGridTrust';
import {
    ASCAT_LIMITS,
    ascatViewportTiles,
    decodeAscatIndex,
    decodeAscatPointer,
    decodeAscatTile,
    type AscatIndex,
    type AscatRow,
} from './ascatContract';

const BASE = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/weather/ascat/v1/';
let nativeReads = 0;
const retired = () => new DOMException('Satellite wind owner retired', 'AbortError');
function owned<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => reject(retired());
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        promise.then(
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
export interface AscatView {
    readonly rows: readonly AscatRow[];
    readonly revision: number;
    readonly generation: string;
}
export interface AscatSession {
    readonly index: AscatIndex;
    readViewport(bounds: readonly [number, number, number, number]): Promise<AscatView>;
    isCurrent(): boolean;
    close(): void;
}
export async function openAscatSession(signal: AbortSignal, ownerCurrent: () => boolean): Promise<AscatSession> {
    const controller = new AbortController(),
        opened = Date.now(),
        monotonic = performance.now();
    let index: AscatIndex | null = null,
        closed = false,
        generation = '',
        epoch = 0,
        reserved = 0;
    let viewport: AbortController | null = null;
    const current = () => {
        try {
            assertNetworkAllowed('grib', 'Satellite wind observations');
            return (
                !closed &&
                !signal.aborted &&
                !controller.signal.aborted &&
                ownerCurrent() &&
                Date.now() >= opened - 1000 &&
                performance.now() - monotonic < 15 * 60000 &&
                (!index || Date.now() < index.expiresAt * 1000)
            );
        } catch {
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
        if (reserved + cap > ASCAT_LIMITS.sessionBytes || nativeReads >= 4)
            throw new Error('Satellite wind read capacity unavailable');
        reserved += cap;
        nativeReads++;
        const request = new AbortController();
        const cancel = () => request.abort();
        controller.signal.addEventListener('abort', cancel, { once: true });
        parent.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted || parent.aborted) cancel();
        const deadline = setTimeout(cancel, 15000);
        const pending = (async () => {
            const response = await fetch(BASE + path, { signal: request.signal, redirect: 'error', cache: 'no-cache' });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Satellite wind unavailable');
            }
            const bytes = await readBoundedResponse(response, cap, request.signal);
            if (expected && (bytes.byteLength !== expected.bytes || (await sha256Hex(bytes)) !== expected.sha256))
                throw new Error('Satellite wind checksum mismatch');
            requireCurrent();
            if (request.signal.aborted) throw retired();
            return decodeUtf8Json(bytes);
        })().finally(() => {
            nativeReads--;
            clearTimeout(deadline);
            controller.signal.removeEventListener('abort', cancel);
            parent.removeEventListener('abort', cancel);
        });
        return owned(pending, request.signal);
    };
    try {
        const pointer = decodeAscatPointer(await read('latest.json', 1024, controller.signal), Date.now() / 1000);
        generation = pointer.generation;
        index = decodeAscatIndex(
            await read(`generations/${generation}/index.json`, ASCAT_LIMITS.index, controller.signal, {
                bytes: pointer.indexBytes,
                sha256: pointer.indexSha256,
            }),
            pointer,
            Date.now() / 1000,
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
                const revision = ++epoch;
                const keys = ascatViewportTiles(bounds);
                viewport = new AbortController();
                const local = viewport,
                    rows: AscatRow[] = [];
                const deadline = setTimeout(() => local.abort(), 35000);
                const before = index!;
                try {
                    for (const key of keys) {
                        const entry = before.tiles[key];
                        if (!entry) continue; // A missing tile is a genuine swath gap.
                        const value = await read(
                            `generations/${generation}/tile-${key}.json`,
                            ASCAT_LIMITS.tile,
                            local.signal,
                            entry,
                        );
                        requireCurrent();
                        if (local.signal.aborted || revision !== epoch || index !== before) throw retired();
                        rows.push(...decodeAscatTile(value, key, before, Date.now() / 1000));
                    }
                    requireCurrent();
                    if (local.signal.aborted || revision !== epoch) throw retired();
                    return { rows, revision, generation };
                } finally {
                    clearTimeout(deadline);
                }
            },
        };
    } catch (error) {
        close();
        throw error;
    }
}
