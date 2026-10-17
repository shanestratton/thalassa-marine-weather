/** Operator-configured Signal K origin; never a caller-supplied URL proxy. */
export type SignalKClientFailure =
    | 'configuration'
    | 'auth'
    | 'request'
    | 'timeout'
    | 'cancelled'
    | 'unavailable'
    | 'response';
export class SignalKClientError extends Error {
    constructor(
        public readonly code: SignalKClientFailure,
        public readonly status?: number,
    ) {
        super(`Signal K ${code}`);
        this.name = 'SignalKClientError';
    }
}
export interface SignalKReply {
    status: number;
    body: unknown;
}
export interface SignalKCourseRequest {
    method: 'GET' | 'PUT' | 'DELETE';
    target: 'activeRoute' | 'course' | 'route';
    routeId?: string;
    body?: unknown;
    signal?: AbortSignal;
}
export interface SignalKClient {
    origin: string;
    getSelf(options?: { signal?: AbortSignal }): Promise<SignalKReply>;
    /** Fixed read-only collection for the Pi's existing AIS reader. */
    getVessels(options?: { signal?: AbortSignal }): Promise<SignalKReply>;
    getDiscovery(options?: { signal?: AbortSignal }): Promise<SignalKReply>;
    requestCourse(options: SignalKCourseRequest): Promise<SignalKReply>;
}

const MAX_BODY = 65_536,
    MAX_REQUEST = 32_768;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredOrigin(raw: string, allowInsecureLan: boolean): string {
    try {
        if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
        const url = new URL(raw);
        if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/' ||
            !['http:', 'https:'].includes(url.protocol)
        )
            throw new Error();
        const host = url.hostname.toLowerCase();
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
        const octets = host.split('.').map(Number);
        const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && octets.every((part) => part >= 0 && part <= 255);
        const local =
            (ipv4 &&
                (octets[0] === 10 ||
                    (octets[0] === 192 && octets[1] === 168) ||
                    (octets[0] === 169 && octets[1] === 254) ||
                    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))) ||
            host.endsWith('.local');
        if (url.protocol === 'http:' && !loopback && !(allowInsecureLan && local)) throw new Error();
        return url.origin;
    } catch {
        throw new SignalKClientError('configuration');
    }
}

function requestBody(value: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(value, (key, item: unknown) => {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error();
            if (typeof item === 'number' && !Number.isFinite(item)) throw new Error();
            return item;
        });
    } catch {
        throw new SignalKClientError('request');
    }
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST)
        throw new SignalKClientError('request');
    return encoded;
}

/** No redirects/cookies, bounded time and bytes, no body/URL/token in errors. */
export function createSignalKClient(options: {
    origin: string;
    accessToken?: string;
    allowInsecureLan?: boolean;
    fetchImpl?: typeof fetch;
}): SignalKClient {
    const origin = configuredOrigin(options.origin, options.allowInsecureLan === true);
    const token = options.accessToken;
    if (
        token !== undefined &&
        (typeof token !== 'string' || token.length < 1 || token.length > 4096 || /[^\x21-\x7e]/.test(token))
    )
        throw new SignalKClientError('configuration');
    const fetchImpl = options.fetchImpl ?? fetch;
    async function request(
        path: string,
        method: 'GET' | 'PUT' | 'DELETE',
        body: unknown,
        signal?: AbortSignal,
        maxBody = MAX_BODY,
    ): Promise<SignalKReply> {
        if (method !== 'GET' && !token) throw new SignalKClientError('auth');
        if (signal?.aborted) throw new SignalKClientError('cancelled');
        const encoded = method === 'PUT' ? requestBody(body) : undefined;
        if (method !== 'PUT' && body !== undefined) throw new SignalKClientError('request');
        const controller = new AbortController();
        let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let rejectAbort!: (error: SignalKClientError) => void;
        const aborted = new Promise<never>((_, reject) => {
            rejectAbort = reject;
        });
        const stop = (code: 'timeout' | 'cancelled') => {
            rejectAbort(new SignalKClientError(code));
            controller.abort();
            void activeReader?.cancel().catch(() => undefined);
        };
        const cancel = () => stop('cancelled');
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => stop('timeout'), 10_000);
        const url = `${origin}${path}`;
        const read = async (): Promise<SignalKReply> => {
            let response: Response;
            try {
                response = await fetchImpl(url, {
                    method,
                    body: encoded,
                    signal: controller.signal,
                    redirect: 'error',
                    credentials: 'omit',
                    headers: {
                        Accept: 'application/json',
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                        ...(encoded !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    },
                });
            } catch {
                throw new SignalKClientError(
                    controller.signal.aborted ? (signal?.aborted ? 'cancelled' : 'timeout') : 'unavailable',
                );
            }
            if (
                (response.url && response.url !== url) ||
                response.type === 'opaqueredirect' ||
                (response.status >= 300 && response.status < 400)
            ) {
                void response.body?.cancel().catch(() => undefined);
                throw new SignalKClientError('response');
            }
            if (!response.ok) {
                void response.body?.cancel().catch(() => undefined);
                return { status: response.status, body: null };
            }
            if (response.status === 204) return { status: 204, body: null };
            if (
                response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
                Number(response.headers.get('content-length')) > maxBody ||
                !response.body
            ) {
                void response.body?.cancel().catch(() => undefined);
                throw new SignalKClientError('response');
            }
            const reader = response.body.getReader();
            activeReader = reader;
            let length = 0;
            let chunks = 0;
            const bytes = new Uint8Array(maxBody);
            try {
                for (;;) {
                    const item = await reader.read();
                    if (item.done) break;
                    if (++chunks > 4096 || length + item.value.byteLength > maxBody)
                        throw new SignalKClientError('response');
                    bytes.set(item.value, length);
                    length += item.value.byteLength;
                }
                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
                return { status: response.status, body: JSON.parse(text) as unknown };
            } catch (error) {
                throw error instanceof SignalKClientError ? error : new SignalKClientError('response');
            } finally {
                void reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        };
        try {
            return await Promise.race([read(), aborted]);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
        }
    }
    return {
        origin,
        getDiscovery: ({ signal } = {}) => request('/signalk', 'GET', undefined, signal),
        getSelf: ({ signal } = {}) => request('/signalk/v1/api/vessels/self', 'GET', undefined, signal, 1024 * 1024),
        getVessels: ({ signal } = {}) => request('/signalk/v1/api/vessels', 'GET', undefined, signal, 4 * 1024 * 1024),
        requestCourse: ({ method, target, routeId, body, signal }) => {
            if (
                !['GET', 'PUT', 'DELETE'].includes(method) ||
                !['activeRoute', 'course', 'route'].includes(target) ||
                (target === 'course' && method === 'PUT') ||
                (target === 'activeRoute' && method !== 'PUT') ||
                (target === 'route' && method === 'DELETE') ||
                (target === 'route' && (typeof routeId !== 'string' || !UUID.test(routeId))) ||
                (target !== 'route' && routeId !== undefined)
            )
                return Promise.reject(new SignalKClientError('request'));
            const path =
                target === 'route'
                    ? `/signalk/v2/api/resources/routes/${routeId}`
                    : `/signalk/v2/api/vessels/self/navigation/course${target === 'activeRoute' ? '/activeRoute' : ''}`;
            return request(path, method, body, signal);
        },
    };
}
