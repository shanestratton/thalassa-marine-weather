/** Explicit caller-owned public read. Import performs no I/O and retains no global cache. */
import { assertNetworkAllowed } from '../networkPolicy';
import { decodeUtf8Json, readBoundedResponse, sha256Hex } from './api/cmemsGridTrust';
import {
    decodeEvidenceIndex,
    decodeEvidencePointer,
    decodeMeasuredBuoy,
    decodeStationSkill,
    EVIDENCE_LIMITS,
    EVIDENCE_PREFIX,
    type EvidenceIndex,
    type EvidenceKind,
    type MeasuredBuoyDetail,
    type StationSkillDetail,
} from './evidenceContract';

const BASE = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/weather/';
const LIFETIME = 15 * 60_000;
const REQUEST_MS = 15_000;
// Aborting a native fetch need not settle it. Its slot remains charged until
// the actual native promise settles, including across panel/layer remounts.
let outstandingFetches = 0;
function admittedFetch(url: string, options: RequestInit): Promise<Response> {
    if (outstandingFetches >= 4) return Promise.reject(new Error('Weather evidence request capacity unavailable'));
    outstandingFetches++;
    try {
        return Promise.resolve(fetch(url, options)).finally(() => {
            outstandingFetches--;
        });
    } catch (error) {
        outstandingFetches--;
        return Promise.reject(error);
    }
}
export type EvidenceDetail = MeasuredBuoyDetail | StationSkillDetail;
export interface WeatherEvidenceSession {
    readonly index: EvidenceIndex;
    readStation(key: string, signal?: AbortSignal): Promise<EvidenceDetail>;
    isCurrent(): boolean;
    close(): void;
}
function aborted(): DOMException {
    return new DOMException('Weather evidence owner retired', 'AbortError');
}
function owned<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => {
            if (!settled) {
                settled = true;
                reject(signal.reason ?? aborted());
            }
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        promise.then(
            (value) => {
                signal.removeEventListener('abort', abort);
                if (settled) {
                    late?.(value);
                    return;
                }
                settled = true;
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', abort);
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            },
        );
    });
}

export async function openWeatherEvidenceSession(
    kind: EvidenceKind,
    signal: AbortSignal,
    ownerCurrent: () => boolean = () => true,
): Promise<WeatherEvidenceSession> {
    if (kind !== 'buoys' && kind !== 'skill') throw new TypeError('Unsupported weather evidence product');
    const parent = new AbortController();
    const opened = Date.now();
    const monotonic = performance.now();
    let closed = false;
    let index: EvidenceIndex | null = null;
    let reserved = 0;
    let epoch = 0;
    let detailRequest: AbortController | null = null;
    const cache = new Map<string, EvidenceDetail>();
    const isCurrent = (): boolean => {
        try {
            assertNetworkAllowed('grib', 'Measured seas and issued forecast skill');
            const now = Date.now();
            return (
                !closed &&
                !signal.aborted &&
                !parent.signal.aborted &&
                ownerCurrent() === true &&
                now >= opened - 1000 &&
                performance.now() - monotonic < LIFETIME &&
                (!index || (now >= index.generatedAt * 1000 && now < index.expiresAt * 1000))
            );
        } catch {
            return false;
        }
    };
    const close = () => {
        if (closed) return;
        closed = true;
        epoch++;
        cache.clear();
        index = null;
        detailRequest?.abort(aborted());
        parent.abort(aborted());
        signal.removeEventListener('abort', close);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    const check = () => {
        if (!isCurrent()) {
            close();
            throw aborted();
        }
    };
    async function read(path: string, bytes: number, hash?: string, extra?: AbortSignal): Promise<unknown> {
        check();
        reserved += bytes;
        if (reserved > EVIDENCE_LIMITS.session) throw new TypeError('Weather evidence session byte budget exhausted');
        const request = new AbortController();
        const abort = () => request.abort(parent.signal.reason ?? extra?.reason ?? aborted());
        parent.signal.addEventListener('abort', abort, { once: true });
        extra?.addEventListener('abort', abort, { once: true });
        if (parent.signal.aborted || extra?.aborted) abort();
        const timeout = setTimeout(() => request.abort(new Error('Weather evidence request deadline')), REQUEST_MS);
        let response: Response | null = null;
        try {
            request.signal.throwIfAborted();
            response = await owned(
                admittedFetch(BASE + EVIDENCE_PREFIX[kind] + '/' + path + (hash ? '?v=' + hash : ''), {
                    cache: 'no-store',
                    credentials: 'omit',
                    redirect: 'error',
                    signal: request.signal,
                    headers: { Accept: 'application/json' },
                }),
                request.signal,
                (late) => {
                    void late.body?.cancel().catch(() => undefined);
                },
            );
            check();
            request.signal.throwIfAborted();
            if (
                response.status !== 200 ||
                response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
            ) {
                void response.body?.cancel().catch(() => undefined);
                throw new TypeError('Weather evidence HTTP or JSON type unavailable');
            }
            const raw = await readBoundedResponse(response, bytes, request.signal);
            check();
            request.signal.throwIfAborted();
            if (hash && (raw.length !== bytes || (await sha256Hex(raw)) !== hash))
                throw new TypeError('Weather evidence original bytes differ');
            check();
            request.signal.throwIfAborted();
            return decodeUtf8Json(raw);
        } catch (error) {
            void response?.body?.cancel().catch(() => undefined);
            throw error;
        } finally {
            clearTimeout(timeout);
            parent.signal.removeEventListener('abort', abort);
            extra?.removeEventListener('abort', abort);
        }
    }
    try {
        const pointer = decodeEvidencePointer(
            await read('latest.json', EVIDENCE_LIMITS.pointer),
            kind,
            Math.floor(Date.now() / 1000),
        );
        index = decodeEvidenceIndex(await read(pointer.indexPath, pointer.indexBytes, pointer.generation), pointer);
        check();
        return {
            get index() {
                check();
                return index!;
            },
            isCurrent,
            close,
            async readStation(key, signal) {
                check();
                signal?.throwIfAborted();
                const station = index!.stations.find((row) => row.key === key);
                if (!station || Date.now() >= station.expiresAt * 1000)
                    throw new TypeError('Station evidence is absent or expired');
                detailRequest?.abort(aborted());
                const token = ++epoch;
                if (cache.has(key)) return cache.get(key)!;
                const request = new AbortController();
                detailRequest = request;
                const abort = () => request.abort(signal?.reason ?? aborted());
                signal?.addEventListener('abort', abort, { once: true });
                try {
                    const value = await read(
                        `generations/${index!.generation}/${station.detailSha256}.json`,
                        station.detailBytes,
                        station.detailSha256,
                        request.signal,
                    );
                    check();
                    signal?.throwIfAborted();
                    if (token !== epoch || Date.now() >= station.expiresAt * 1000) throw aborted();
                    const parsed =
                        kind === 'buoys'
                            ? decodeMeasuredBuoy(value, station, index!.generatedAt)
                            : decodeStationSkill(value, station, index!.generatedAt);
                    if (cache.size >= 2) cache.delete(cache.keys().next().value!);
                    cache.set(key, parsed);
                    return parsed;
                } finally {
                    signal?.removeEventListener('abort', abort);
                    if (detailRequest === request) detailRequest = null;
                }
            },
        };
    } catch (error) {
        close();
        throw error;
    }
}
