/**
 * Research-only Fetch boundary; not mounted, deployed or connected to app chat.
 * The host must provide trusted HTTPS routing and a server-only signed gateway.
 * A lost/deadline response does NOT roll back a possibly committed operation:
 * callers must reconcile the exact durable request, never manufacture a receipt.
 */
import { MAX_RESEARCH_REQUEST_BYTES } from './signedRequest.ts';

export interface ResearchHttpGatewayConfig {
    readonly serviceOrigin: string;
    readonly gateway: {
        register(credential: string, serializedBundle: string): Promise<unknown>;
        dispatch(credential: string, serializedRequest: string): Promise<unknown>;
    };
    /** Bounds body reading plus all downstream work, without claiming SQL cancellation. */
    readonly timeoutMs?: number;
}

const MAX_BUNDLE_BYTES = 4096;
const MAX_CREDENTIAL_BYTES = 8192;
export const MAX_RESEARCH_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_NODES = 32_768;
const MAX_JSON_DEPTH = 64;
const AUTHORIZATION = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const CONTENT_LENGTH = /^(0|[1-9][0-9]*)$/;
const ERROR_WIRE = '{"version":1,"error":"request-unresolved"}';
const RESPONSE_HEADERS = Object.freeze({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
});

class BoundaryError extends Error {
    readonly status: number;
    constructor(status: number) {
        super('Research request unresolved');
        this.status = status;
    }
}
const invalidConfig = (): never => {
    throw new Error('Invalid research HTTP gateway configuration');
};
function serviceOrigin(value: unknown): string {
    if (typeof value !== 'string') return invalidConfig();
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/' ||
            (value !== url.origin && value !== `${url.origin}/`)
        )
            return invalidConfig();
        return url.origin;
    } catch {
        return invalidConfig();
    }
}
function failure(status: number): Response {
    return new Response(ERROR_WIRE, { status, headers: RESPONSE_HEADERS });
}

async function boundedWire(
    request: Request,
    limit: number,
    signal: AbortSignal,
    checkAvailable: () => void,
): Promise<string> {
    checkAvailable();
    const declared = request.headers.get('content-length');
    if (declared !== null && CONTENT_LENGTH.exec(declared)?.[0] !== declared) throw new BoundaryError(400);
    if (declared !== null && Number(declared) > limit) throw new BoundaryError(413);
    if (declared !== null && request.headers.has('transfer-encoding')) throw new BoundaryError(400);
    if (!request.body || request.bodyUsed) throw new BoundaryError(400);

    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const cancel = () => {
        void reader.cancel().catch(() => undefined);
    };
    let received = 0;
    let chunks = 0;
    let serialized = '';
    let complete = false;
    signal.addEventListener('abort', cancel, { once: true });
    try {
        for (;;) {
            checkAvailable();
            const { done, value } = await reader.read();
            checkAvailable();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw new BoundaryError(400);
            // Bound even zero-byte chunks: a synchronously replenished empty
            // stream can otherwise starve the deadline timer's event-loop turn.
            if (++chunks > MAX_RESEARCH_REQUEST_BYTES) throw new BoundaryError(413);
            received += value.byteLength;
            if (received > limit) throw new BoundaryError(413);
            serialized += decoder.decode(value, { stream: true });
        }
        serialized += decoder.decode();
        if (received === 0 || (declared !== null && received !== Number(declared)) || /[^\x20-\x7e]/.test(serialized))
            throw new BoundaryError(400);
        // Syntactic canonical framing only. Signed gateway alone authenticates
        // the account and verifies the exact field order, binding and signature.
        const parsed: unknown = JSON.parse(serialized);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed) !== serialized)
            throw new BoundaryError(400);
        checkAvailable();
        complete = true;
        return serialized;
    } catch (error) {
        if (error instanceof BoundaryError) throw error;
        throw new BoundaryError(400);
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!complete) cancel();
        reader.releaseLock();
    }
}

/** JSON-only values, bounded while encoding; never invoke custom getters/toJSON. */
function responseWire(result: unknown, checkAvailable: () => void): string {
    const fragments: string[] = [];
    let bytes = 0;
    let nodes = 0;
    const ancestors = new Set<object>();
    const encoder = new TextEncoder();
    function append(fragment: string) {
        checkAvailable();
        if (fragment.length > MAX_RESEARCH_HTTP_RESPONSE_BYTES) throw new BoundaryError(503);
        bytes += encoder.encode(fragment).byteLength;
        if (bytes > MAX_RESEARCH_HTTP_RESPONSE_BYTES) throw new BoundaryError(503);
        fragments.push(fragment);
    }
    function string(value: string) {
        // Prevent an oversized input allocation before escaping/byte counting.
        if (value.length > MAX_RESEARCH_HTTP_RESPONSE_BYTES) throw new BoundaryError(503);
        append(JSON.stringify(value));
    }
    function value(item: unknown, depth: number) {
        checkAvailable();
        if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new BoundaryError(503);
        if (item === null) return append('null');
        if (typeof item === 'string') return string(item);
        if (typeof item === 'boolean') return append(item ? 'true' : 'false');
        if (typeof item === 'number' && Number.isFinite(item)) return append(JSON.stringify(item));
        if (!item || typeof item !== 'object' || ancestors.has(item)) throw new BoundaryError(503);
        ancestors.add(item);
        try {
            if (Array.isArray(item)) {
                if (item.length > MAX_JSON_NODES) throw new BoundaryError(503);
                const keys = Reflect.ownKeys(item);
                if (keys.length !== item.length + 1) throw new BoundaryError(503);
                append('[');
                for (let index = 0; index < item.length; index++) {
                    const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new BoundaryError(503);
                    if (index) append(',');
                    value(descriptor.value, depth + 1);
                }
                append(']');
            } else {
                const prototype = Object.getPrototypeOf(item);
                if (prototype !== Object.prototype && prototype !== null) throw new BoundaryError(503);
                const keys = Reflect.ownKeys(item);
                if (keys.length > MAX_JSON_NODES) throw new BoundaryError(503);
                append('{');
                for (let index = 0; index < keys.length; index++) {
                    const key = keys[index];
                    if (typeof key !== 'string') throw new BoundaryError(503);
                    const descriptor = Object.getOwnPropertyDescriptor(item, key);
                    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new BoundaryError(503);
                    if (index) append(',');
                    string(key);
                    append(':');
                    value(descriptor.value, depth + 1);
                }
                append('}');
            }
        } finally {
            ancestors.delete(item);
        }
    }
    append('{"version":1,"result":');
    value(result, 0);
    append('}');
    const serialized = fragments.join('');
    checkAvailable();
    return serialized;
}

/** Exact two-endpoint native pilot boundary. No cookies, CORS or unsigned operations. */
export function createResearchHttpGateway(config: ResearchHttpGatewayConfig): (request: Request) => Promise<Response> {
    if (!config || typeof config !== 'object') return invalidConfig();
    const origin = serviceOrigin(config.serviceOrigin);
    const timeoutMs = config.timeoutMs === undefined ? 10_000 : config.timeoutMs;
    const gateway = config.gateway;
    if (
        !gateway ||
        typeof gateway.register !== 'function' ||
        typeof gateway.dispatch !== 'function' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 10_000
    )
        return invalidConfig();
    const register = gateway.register.bind(gateway);
    const dispatch = gateway.dispatch.bind(gateway);
    const endpoints = new Map([
        [`${origin}/v1/register`, { call: register, limit: MAX_BUNDLE_BYTES }],
        [`${origin}/v1/dispatch`, { call: dispatch, limit: MAX_RESEARCH_REQUEST_BYTES }],
    ]);

    return async (request) => {
        const startedAt = performance.now();
        const controller = new AbortController();
        let stopStatus: 503 | 504 | undefined;
        let stop!: (response: Response) => void;
        const stopped = new Promise<Response>((resolve) => {
            stop = resolve;
        });
        const stopRequest = (status: 503 | 504) => {
            if (stopStatus !== undefined) return;
            stopStatus = status;
            controller.abort();
            stop(failure(status));
        };
        const unavailableStatus = (): 503 | 504 | undefined => {
            if (stopStatus !== undefined) return stopStatus;
            if (request.signal.aborted) return 503;
            if (performance.now() - startedAt >= timeoutMs) return 504;
            return undefined;
        };
        const checkAvailable = () => {
            const status = unavailableStatus();
            if (status !== undefined) {
                stopRequest(status);
                throw new BoundaryError(status);
            }
        };
        const disconnect = () => stopRequest(503);
        request.signal.addEventListener('abort', disconnect, { once: true });
        const timer = setTimeout(() => stopRequest(504), timeoutMs);
        const operation = async (): Promise<Response> => {
            try {
                checkAvailable();
                const endpoint = endpoints.get(request.url);
                if (!endpoint) throw new BoundaryError(404);
                if (request.method !== 'POST') throw new BoundaryError(405);
                if (request.headers.has('cookie') || request.headers.has('origin')) throw new BoundaryError(400);
                const authorization = request.headers.get('authorization');
                const match = typeof authorization === 'string' ? AUTHORIZATION.exec(authorization) : null;
                if (!match || match[0] !== authorization || match[1].length > MAX_CREDENTIAL_BYTES)
                    throw new BoundaryError(401);
                const contentType = request.headers.get('content-type');
                if (
                    contentType === null ||
                    JSON_TYPE.exec(contentType)?.[0] !== contentType ||
                    request.headers.has('content-encoding')
                )
                    throw new BoundaryError(415);
                const serialized = await boundedWire(request, endpoint.limit, controller.signal, checkAvailable);
                checkAvailable();
                const result = await endpoint.call(match[1], serialized);
                checkAvailable();
                const serializedResponse = responseWire(result, checkAvailable);
                checkAvailable();
                const response = new Response(serializedResponse, { status: 200, headers: RESPONSE_HEADERS });
                checkAvailable();
                return response;
            } catch (error) {
                // Monotonic checks also fence errors and synchronous work when
                // an endless microtask turn prevents the timer from firing.
                const unavailable = unavailableStatus();
                if (unavailable !== undefined) stopRequest(unavailable);
                return failure(unavailable ?? (error instanceof BoundaryError ? error.status : 503));
            }
        };
        try {
            if (request.signal.aborted) disconnect();
            // Racing bounds adapters that ignore cancellation. It does not undo
            // work already dispatched, and its eventual outcome stays observed.
            return await Promise.race([operation(), stopped]);
        } finally {
            clearTimeout(timer);
            request.signal.removeEventListener('abort', disconnect);
            controller.abort();
            void request.body?.cancel().catch(() => undefined);
        }
    };
}
