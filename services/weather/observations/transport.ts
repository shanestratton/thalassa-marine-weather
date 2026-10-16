import { Capacitor, registerPlugin } from '@capacitor/core';
import { satelliteModeActive } from '../../networkPolicy';
import type { ObservationRequest } from './requests';

interface NativeReply {
    status: number;
    mime: string;
    data: string;
}
const native = registerPlugin<{
    read(options: { url: string; maxBytes: number; requestId: string }): Promise<NativeReply>;
    cancel(options: { requestId: string }): Promise<void>;
}>('ObservationHttp');
export class ObservationTransportError extends Error {
    constructor(
        readonly reason: 'native' | 'policy' | 'http' | 'invalid' | 'aborted',
        readonly status = 0,
    ) {
        super(`Observation request ${reason}${status ? ` (${status})` : ''}`);
    }
}
/** Defense in depth: both JS and the native reader enforce this exact public API surface. */
export function allowedObservationUrl(input: string): boolean {
    try {
        const u = new URL(input);
        if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash) return false;
        if (u.hostname === 'www.ndbc.noaa.gov')
            return (
                !u.search &&
                (u.pathname === '/data/latest_obs/latest_obs.txt' ||
                    /^\/data\/realtime2\/[A-Z0-9]{3,8}\.txt$/.test(u.pathname))
            );
        if (u.hostname !== 'aviationweather.gov') return false;
        if (u.pathname === '/data/cache/stations.cache.json.gz') return !u.search;
        const params = [...u.searchParams];
        const hours = u.searchParams.get('hours') ?? '';
        return (
            u.pathname === '/api/data/metar' &&
            params.length === 3 &&
            new Set(params.map(([k]) => k)).size === 3 &&
            u.searchParams.get('format') === 'json' &&
            /^(3|1[2-9]|[2-6]\d|7[0-2])$/.test(hours) &&
            (hours === '3' || !u.searchParams.get('ids')?.includes(',')) &&
            /^[A-Z0-9]{4}(,[A-Z0-9]{4}){0,19}$/.test(u.searchParams.get('ids') ?? '')
        );
    } catch {
        return false;
    }
}
export async function readObservation(request: ObservationRequest, signal?: AbortSignal): Promise<string> {
    if (!allowedObservationUrl(request.url) || request.maxBytes > 2 * 1024 * 1024 || request.maxBytes < 1)
        throw new ObservationTransportError('invalid');
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios')
        throw new ObservationTransportError('native');
    if (satelliteModeActive() || (typeof navigator !== 'undefined' && navigator.onLine === false))
        throw new ObservationTransportError('policy');
    if (signal?.aborted) throw new ObservationTransportError('aborted');
    const requestId = crypto.randomUUID();
    const cancel = () => {
        void native.cancel({ requestId }).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const reply = await native.read({ url: request.url, maxBytes: request.maxBytes, requestId });
        if (signal?.aborted) throw new ObservationTransportError('aborted');
        if (reply.status === 204) return '';
        if (reply.status !== 200) throw new ObservationTransportError('http', reply.status);
        if (typeof reply.data !== 'string') throw new ObservationTransportError('invalid');
        const gzip = request.url.endsWith('.gz');
        if (gzip) {
            if (!/^application\/(octet-stream|gzip|x-gzip)(?:;|$)/i.test(reply.mime))
                throw new ObservationTransportError('invalid');
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(reply.data) || reply.data.length > Math.ceil(request.maxBytes / 3) * 4)
                throw new ObservationTransportError('invalid');
            const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0));
            if (bytes.length > request.maxBytes || bytes[0] !== 31 || bytes[1] !== 139)
                throw new ObservationTransportError('invalid');
            const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
                while (true) {
                    if (signal?.aborted) throw new ObservationTransportError('aborted');
                    const { value, done } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    if (length > 3 * 1024 * 1024) throw new ObservationTransportError('invalid');
                    chunks.push(value);
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
            const all = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                all.set(chunk, offset);
                offset += chunk.length;
            }
            return new TextDecoder('utf-8', { fatal: true }).decode(all);
        }
        const json = request.url.includes('/api/data/metar');
        if (
            !(json ? /application\/(?:[^;]+\+)?json/i : /text\/(plain|csv)/i).test(reply.mime) ||
            new TextEncoder().encode(reply.data).length > request.maxBytes
        )
            throw new ObservationTransportError('invalid');
        return reply.data;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}
