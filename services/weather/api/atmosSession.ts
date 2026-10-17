/** A caller-owned public atmospheric cohort. Two raw frames maximum; no durable/global cache. */
import { API_BASE } from '../../native/apiBase';
import { assertNetworkAllowed } from '../../networkPolicy';
import { sampleScalarGrid, type ScalarGrid } from '../scalarGridImage';
import { decodeUtf8Json, fetchBoundedPublisherBytes, verifyPublisherAsset } from './cmemsGridTrust';
import {
    ATMOS_CELLS,
    ATMOS_DATASETS,
    decodeAtmosFrame,
    validateAtmosManifest,
    type AtmosDataset,
    type AtmosField,
    type AtmosFrame,
    type AtmosManifest,
} from './atmosContract';

const HOUR = 3_600_000;
const SESSION_MS = 30 * 60_000;

export interface AtmosView {
    readonly dataset: AtmosDataset;
    readonly generation: string;
    readonly runMs: number;
    readonly validMs: number;
    readonly fields: Readonly<Partial<Record<AtmosField, ScalarGrid>>>;
    /** Process-local adoption/render proof, not persisted or exported as metadata. */
    isCurrent(): boolean;
}
export interface AtmosSession {
    readonly manifest: AtmosManifest;
    readAt(validMs: number, signal?: AbortSignal): Promise<AtmosView>;
    isCurrent(): boolean;
    close(): void;
}

function blend(first: ScalarGrid, second: ScalarGrid, fraction: number, check: () => void): ScalarGrid {
    const values = new Float32Array(ATMOS_CELLS);
    const validMask = new Uint8Array(ATMOS_CELLS);
    for (let i = 0; i < ATMOS_CELLS; i++) {
        if (i % 4096 === 0) check();
        if (first.validMask[i] !== 1 || second.validMask[i] !== 1) continue;
        const value = first.values[i] + fraction * (second.values[i] - first.values[i]);
        if (!Number.isFinite(value)) continue;
        values[i] = value;
        validMask[i] = 1;
    }
    return Object.freeze({ ...first, values, validMask });
}

/** The scalar source remains explicitly GFS/IFS; unsupported selected models must refuse before opening. */
export async function openAtmosSession(
    dataset: AtmosDataset,
    signal: AbortSignal,
    ownerCurrent: () => boolean = () => true,
): Promise<AtmosSession> {
    if (!Object.hasOwn(ATMOS_DATASETS, dataset)) throw new TypeError('Unsupported atmospheric source');
    const parent = new AbortController();
    const openedAt = Date.now();
    const monotonicStart = performance.now();
    let closed = false;
    let manifest: AtmosManifest | null = null;
    let request = 0;
    let activeRead: AbortController | null = null;
    const cache = new Map<number, AtmosFrame>();
    const current = (): boolean => {
        try {
            const now = Date.now();
            return (
                !closed &&
                !signal.aborted &&
                !parent.signal.aborted &&
                ownerCurrent() &&
                now >= openedAt - 60_000 &&
                now < openedAt + SESSION_MS &&
                performance.now() - monotonicStart < SESSION_MS &&
                (!manifest ||
                    (now >= manifest.runMs && now - manifest.runMs <= ATMOS_DATASETS[dataset].maxAgeHours * HOUR))
            );
        } catch {
            return false;
        }
    };
    const close = () => {
        if (closed) return;
        closed = true;
        cache.clear();
        activeRead?.abort(new DOMException('Atmospheric source closed', 'AbortError'));
        parent.abort(new DOMException('Atmospheric source closed', 'AbortError'));
        signal.removeEventListener('abort', abort);
    };
    const abort = () => close();
    signal.addEventListener('abort', abort, { once: true });
    const check = () => {
        try {
            assertNetworkAllowed('grib', 'Atmospheric display grids');
            if (!current()) throw new DOMException('Atmospheric source retired', 'AbortError');
        } catch (error) {
            close();
            throw error;
        }
    };
    const model = ATMOS_DATASETS[dataset].model;
    const base = `${API_BASE}/atmos`;
    try {
        check();
        const bytes = await fetchBoundedPublisherBytes(
            `${base}/manifest-v2.json?model=${model}`,
            32 * 1024,
            'application/json',
            parent.signal,
        );
        check();
        manifest = validateAtmosManifest(decodeUtf8Json(bytes), dataset);
        check();
    } catch (error) {
        close();
        throw error;
    }
    const cohort = manifest;
    const sourceCurrent = () => {
        try {
            check();
            return true;
        } catch {
            return false;
        }
    };

    return Object.freeze({
        manifest: cohort,
        isCurrent: sourceCurrent,
        close,
        async readAt(validMs: number, callerSignal?: AbortSignal): Promise<AtmosView> {
            check();
            activeRead?.abort(new DOMException('Atmospheric frame superseded', 'AbortError'));
            const read = new AbortController();
            activeRead = read;
            const token = ++request;
            const abortRead = () => read.abort(callerSignal?.reason);
            const abortParent = () => read.abort(parent.signal.reason);
            callerSignal?.addEventListener('abort', abortRead, { once: true });
            parent.signal.addEventListener('abort', abortParent, { once: true });
            const checkRead = () => {
                check();
                if (callerSignal?.aborted) abortRead();
                read.signal.throwIfAborted();
                if (request !== token) throw new DOMException('Atmospheric frame superseded', 'AbortError');
            };
            const position = (validMs - cohort.runMs) / (6 * HOUR);
            const low = Math.floor(position),
                high = Math.ceil(position);
            // Drop every unrelated decoded frame before reserving/fetching a replacement.
            for (const step of cache.keys()) if (step !== low && step !== high) cache.delete(step);
            const load = async (step: number): Promise<AtmosFrame> => {
                checkRead();
                const retained = cache.get(step);
                if (retained) return retained;
                const file = cohort.files[step];
                const bytes = await fetchBoundedPublisherBytes(
                    `${base}/${file.filename}?model=${model}`,
                    file.bytes,
                    'application/octet-stream',
                    read.signal,
                    'force-cache',
                );
                checkRead();
                await verifyPublisherAsset(bytes, file.bytes, file.sha256, 'atmospheric frame');
                checkRead();
                if (
                    !(bytes.buffer instanceof ArrayBuffer) ||
                    bytes.byteOffset !== 0 ||
                    bytes.byteLength !== bytes.buffer.byteLength
                )
                    throw new Error('Atmospheric bytes are not an owned complete buffer');
                const frame = decodeAtmosFrame(bytes.buffer, dataset, cohort.runMs, file.offset_hours, checkRead);
                checkRead();
                cache.set(step, frame);
                return frame;
            };
            let succeeded = false;
            try {
                checkRead();
                const endMs = cohort.runMs + (cohort.files.length - 1) * 6 * HOUR;
                if (!Number.isFinite(validMs) || validMs < cohort.runMs || validMs > endMs)
                    throw new RangeError('Atmospheric time outside actual source coverage');
                const first = await load(low);
                checkRead();
                const second = high === low ? first : await load(high);
                checkRead();
                const fields: Partial<Record<AtmosField, ScalarGrid>> = {};
                for (const field of ATMOS_DATASETS[dataset].fields) {
                    const a = first.fields[field],
                        b = second.fields[field];
                    if (!a || !b) throw new Error('Atmospheric original field absent');
                    fields[field] = low === high ? a : blend(a, b, position - low, checkRead);
                }
                checkRead();
                succeeded = true;
                return Object.freeze({
                    dataset,
                    generation: cohort.generation,
                    runMs: cohort.runMs,
                    validMs,
                    fields: Object.freeze(fields),
                    isCurrent: () => {
                        try {
                            checkRead();
                            return true;
                        } catch {
                            return false;
                        }
                    },
                });
            } finally {
                callerSignal?.removeEventListener('abort', abortRead);
                parent.signal.removeEventListener('abort', abortParent);
                if (!succeeded) read.abort(new DOMException('Atmospheric frame refused', 'AbortError'));
                // Successful cleanup never synthesizes cancellation; the returned
                // proof remains valid until source retirement or a new selection.
            }
        },
    });
}

/** An indicative point saturation proxy, never a fog probability or observed visibility. */
export function atmosDewpointSpread(view: AtmosView, lon: number, lat: number): number | null {
    if (!view.isCurrent() || view.dataset !== 'gfs-atmos') return null;
    const temperature = view.fields.temperature,
        dewpoint = view.fields.dewpoint;
    if (!temperature || !dewpoint) return null;
    const t = sampleScalarGrid(temperature, lon, lat),
        td = sampleScalarGrid(dewpoint, lon, lat);
    if (t === null || td === null || td > t) return null;
    return t - td;
}
