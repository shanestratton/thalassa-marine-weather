// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createResearchHttpGateway,
    MAX_RESEARCH_HTTP_RESPONSE_BYTES,
} from '../experiments/scuttlebutt-e2ee/relay/httpGateway';

// Fetch handler/dependency mocks only. This suite does not establish real TLS,
// live Auth, signature verification, a database commit or a physical phone.
const ORIGIN = 'https://research-relay.example';
const EDGE_BASE_PATH = '/functions/v1/scuttlebutt-e2ee-pilot';
const TOKEN = 'caller-access.token_~+/==';
const BODY = '{"version":1,"fixture":"public-wire"}';
const ERROR = { version: 1, error: 'request-unresolved' };

function harness(timeoutMs = 1000, serviceBasePath?: string) {
    const gateway = {
        register: vi.fn(async (_credential: string, _serialized: string): Promise<unknown> => ({ registered: true })),
        dispatch: vi.fn(async (_credential: string, _serialized: string): Promise<unknown> => ({ rows: [] })),
    };
    const handle = createResearchHttpGateway({ serviceOrigin: ORIGIN, serviceBasePath, gateway, timeoutMs });
    return { gateway, handle };
}
function request(path = '/v1/dispatch', init: RequestInit = {}): Request {
    const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return new Request(`${ORIGIN}${path}`, { method: 'POST', body: BODY, ...init, headers });
}
function streamedRequest(chunks: Uint8Array[], init: RequestInit = {}) {
    const cancel = vi.fn();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index < chunks.length) controller.enqueue(chunks[index++]);
            else controller.close();
        },
        cancel,
    });
    const req = request('/v1/dispatch', { ...init, body, duplex: 'half' } as RequestInit);
    return { req, cancel };
}
async function expectFailure(response: Response, status: number) {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(ERROR);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('research Fetch HTTP boundary with mocked signed gateway', () => {
    it('passes only the exact bearer credential and public wire to the appropriate signed gateway method', async () => {
        const h = harness();
        const register = await h.handle(request('/v1/register'));
        expect(register.status).toBe(200);
        expect(await register.json()).toEqual({ version: 1, result: { registered: true } });
        expect(h.gateway.register).toHaveBeenCalledExactlyOnceWith(TOKEN, BODY);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();

        const dispatch = await h.handle(request());
        expect(dispatch.status).toBe(200);
        expect(await dispatch.json()).toEqual({ version: 1, result: { rows: [] } });
        expect(h.gateway.dispatch).toHaveBeenCalledExactlyOnceWith(TOKEN, BODY);
        expect(dispatch.headers.get('cache-control')).toBe('no-store');
        expect(dispatch.headers.get('x-content-type-options')).toBe('nosniff');
        expect(dispatch.headers.get('access-control-allow-origin')).toBeNull();
        expect(dispatch.headers.get('set-cookie')).toBeNull();
        const responseHeaders: string[] = [];
        dispatch.headers.forEach((_value, key) => responseHeaders.push(key));
        expect(responseHeaders.sort()).toEqual(['cache-control', 'content-type', 'x-content-type-options']);
    });

    it('never derives an actor from a body or rewrites the canonical request bytes', async () => {
        const h = harness();
        const body = '{"userId":"attacker-selected-actor","payload":"[0,16]"}';
        await h.handle(request('/v1/dispatch', { body }));
        expect(h.gateway.dispatch).toHaveBeenCalledExactlyOnceWith(TOKEN, body);
    });

    it.each(['', '/functions/v1/a', EDGE_BASE_PATH, `/functions/v1/${'a'.repeat(64)}`])(
        'accepts only the two exact endpoints under the trusted mount: %s',
        async (serviceBasePath) => {
            const h = harness(1000, serviceBasePath);
            expect((await h.handle(request(`${serviceBasePath}/v1/register`))).status).toBe(200);
            expect((await h.handle(request(`${serviceBasePath}/v1/dispatch`))).status).toBe(200);
            expect(h.gateway.register).toHaveBeenCalledExactlyOnceWith(TOKEN, BODY);
            expect(h.gateway.dispatch).toHaveBeenCalledExactlyOnceWith(TOKEN, BODY);
        },
    );

    it('captures the trusted mount before subsequent config mutation', async () => {
        const h = harness();
        const config = { serviceOrigin: ORIGIN, serviceBasePath: EDGE_BASE_PATH, gateway: h.gateway };
        const handle = createResearchHttpGateway(config);
        config.serviceBasePath = '/functions/v1/other';
        expect((await handle(request(`${EDGE_BASE_PATH}/v1/dispatch`))).status).toBe(200);
        await expectFailure(await handle(request('/functions/v1/other/v1/dispatch')), 404);
        expect(h.gateway.dispatch).toHaveBeenCalledExactlyOnceWith(TOKEN, BODY);
    });

    it.each([
        null,
        1,
        '/',
        '/functions/v1/',
        '/functions/v1',
        '/functions/V1/pilot',
        '/Functions/v1/pilot',
        '//functions/v1/pilot',
        '/functions//v1/pilot',
        '/functions/v1/Pilot',
        '/functions/v1/1pilot',
        '/functions/v1/-pilot',
        '/functions/v1/pilot-',
        '/functions/v1/pilot--relay',
        '/functions/v1/pilot_relay',
        '/functions/v1/pilot.relay',
        '/functions/v1/pilot/',
        '/functions/v1/pilot//',
        '/functions/v1/./pilot',
        '/functions/v1/other/../pilot',
        '/functions/v1/%70ilot',
        '/functions/v1/pilot%2fother',
        '/functions/v1/%2e%2e/pilot',
        '/functions/v1/pilot\\other',
        '/functions/v1/pilot?project=other',
        '/functions/v1/pilot?',
        '/functions/v1/pilot#fragment',
        '/functions/v1/pilot#',
        '/functions/v1/pilot\n',
        ' /functions/v1/pilot',
        '/functions/v1/pilot ',
        '/functions/v1/pilót',
        'https://other.example/functions/v1/pilot',
        `/functions/v1/${'a'.repeat(65)}`,
    ])('rejects a noncanonical trusted mount before serving requests: %s', (serviceBasePath) => {
        expect(() =>
            createResearchHttpGateway({
                serviceOrigin: ORIGIN,
                serviceBasePath: serviceBasePath as never,
                gateway: harness().gateway,
            }),
        ).toThrow('Invalid research HTTP gateway configuration');
    });

    it.each([
        '/v1/dispatch',
        '/functions/v1/other/v1/dispatch',
        `${EDGE_BASE_PATH}/v1/dispatch/`,
        `${EDGE_BASE_PATH}//v1/dispatch`,
        `${EDGE_BASE_PATH}/v1/%64ispatch`,
        `${EDGE_BASE_PATH}/v1/dispatch?`,
        `${EDGE_BASE_PATH}/v1/dispatch?actor=other`,
        `${EDGE_BASE_PATH}/v1/dispatch#`,
        `${EDGE_BASE_PATH}/v1/dispatch#fragment`,
        '/functions/v1/%73cuttlebutt-e2ee-pilot/v1/dispatch',
        '/functions/v1/scuttlebutt-e2ee-pilot%2fv1/dispatch',
        '/functions/v1/other/../scuttlebutt-e2ee-pilot/v1/dispatch',
        `${EDGE_BASE_PATH}/other/../v1/dispatch`,
        `${EDGE_BASE_PATH}/%2e/v1/dispatch`,
        `${EDGE_BASE_PATH}/v1/register/../dispatch`,
        `${EDGE_BASE_PATH}\\v1/dispatch`,
    ])('does not normalize, decode, wildcard or rewrite a hosted endpoint: %s', async (path) => {
        const h = harness(1000, EDGE_BASE_PATH);
        const req = request(`${EDGE_BASE_PATH}/v1/dispatch`);
        // Fetch may normalize dot segments while constructing a Request. The
        // boundary matches only the exact URL delivered by its trusted host;
        // raw alternate forms are not routing hints and must not be rewritten.
        Object.defineProperty(req, 'url', { value: `${ORIGIN}${path}` });
        await expectFailure(await h.handle(req), 404);
        expect(h.gateway.register).not.toHaveBeenCalled();
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('does not use spoofed Host/forwarded headers to change the trusted mount or origin', async () => {
        const h = harness(1000, EDGE_BASE_PATH);
        const req = request('/v1/dispatch', {
            headers: {
                host: 'research-relay.example',
                'x-forwarded-host': 'research-relay.example',
                'x-forwarded-prefix': EDGE_BASE_PATH,
                'x-original-url': `${EDGE_BASE_PATH}/v1/dispatch`,
            },
        });
        await expectFailure(await h.handle(req), 404);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('captures endpoint, timeout and method dependencies before subsequent config mutation', async () => {
        const h = harness();
        const gateway = { ...h.gateway };
        const config = { serviceOrigin: `${ORIGIN}/`, gateway, timeoutMs: 1000 };
        const handle = createResearchHttpGateway(config);
        config.serviceOrigin = 'https://untrusted.example';
        config.timeoutMs = 1;
        gateway.dispatch = vi.fn(async () => 'changed');
        expect(await (await handle(request())).json()).toEqual({ version: 1, result: { rows: [] } });
        expect(h.gateway.dispatch).toHaveBeenCalledOnce();
        expect(gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each([
        'http://research-relay.example',
        'http://localhost:8443',
        'https://user:password@research-relay.example',
        `${ORIGIN}/v1/dispatch`,
        `${ORIGIN}//`,
        `${ORIGIN}/%2e`,
        `${ORIGIN}?`,
        `${ORIGIN}?project=other`,
        `${ORIGIN}#`,
        `${ORIGIN}#fragment`,
        ` ${ORIGIN}`,
        `${ORIGIN} `,
        'HTTPS://research-relay.example',
        'https://RESEARCH-RELAY.example',
        'not-a-url',
    ])('rejects a noncanonical/insecure service configuration: %s', (serviceOrigin) => {
        expect(() => createResearchHttpGateway({ serviceOrigin, gateway: harness().gateway })).toThrow(
            'Invalid research HTTP gateway configuration',
        );
    });

    it.each([0, -1, 10_001, 1.5, Infinity, NaN])('rejects an invalid deadline: %s', (timeoutMs) => {
        expect(() =>
            createResearchHttpGateway({ serviceOrigin: ORIGIN, gateway: harness().gateway, timeoutMs }),
        ).toThrow('Invalid research HTTP gateway configuration');
    });

    it('rejects missing/nonfunction gateway methods', () => {
        for (const gateway of [null, {}, { register: () => undefined }, { register: 1, dispatch: 2 }]) {
            expect(() => createResearchHttpGateway({ serviceOrigin: ORIGIN, gateway: gateway as never })).toThrow(
                'Invalid research HTTP gateway configuration',
            );
        }
    });

    it.each([
        '/v1/send',
        '/v1/revoke',
        '/v1/block',
        '/v1/claim',
        '/v1/list',
        '/v1/dispatch/',
        '/v1/dispatch?actor=other',
        '/v1/dispatch?',
        '/v1/dispatch#fragment',
        '/v1/dispatch#',
        '/V1/dispatch',
        '/v1/%64ispatch',
        '//v1/dispatch',
    ])('does not expose an alternate, unsigned or query/fragment endpoint: %s', async (path) => {
        const h = harness();
        await expectFailure(await h.handle(request(path)), 404);
        expect(h.gateway.register).not.toHaveBeenCalled();
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a request delivered for another origin or insecure HTTP instead of redirecting', async () => {
        const h = harness();
        for (const url of ['https://different.example/v1/dispatch', 'http://research-relay.example/v1/dispatch']) {
            const req = request();
            Object.defineProperty(req, 'url', { value: url });
            await expectFailure(await h.handle(req), 404);
        }
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('only accepts POST, not %s', async (method) => {
        const h = harness();
        await expectFailure(await h.handle(request('/v1/dispatch', { method, body: null })), 405);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each([
        '',
        'Basic secret',
        'bearer token',
        'Bearer ',
        'Bearer a b',
        'Bearer a\tb',
        'Bearer bad:token',
        'Bearer a=b',
        'Bearer tökén',
        'Bearer first, Bearer second',
        'Bearer a='.repeat(2),
        `Bearer ${'x'.repeat(8193)}`,
    ])('rejects malformed/multiple/oversized authorization without calling the gateway: %s', async (authorization) => {
        const h = harness();
        await expectFailure(await h.handle(request('/v1/dispatch', { headers: { authorization } })), 401);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('rejects a missing authorization header and collapsed duplicates', async () => {
        const h = harness();
        const missing = request();
        missing.headers.delete('authorization');
        await expectFailure(await h.handle(missing), 401);
        const duplicate = request();
        duplicate.headers.append('authorization', 'Bearer other');
        await expectFailure(await h.handle(duplicate), 401);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('accepts the exact 8192-character token boundary', async () => {
        const h = harness();
        const credential = 'x'.repeat(8192);
        expect(
            (await h.handle(request('/v1/dispatch', { headers: { authorization: `Bearer ${credential}` } }))).status,
        ).toBe(200);
        expect(h.gateway.dispatch).toHaveBeenCalledExactlyOnceWith(credential, BODY);
    });

    it.each(['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON; CHARSET=UTF-8'])(
        'accepts supported JSON media type: %s',
        async (contentType) => {
            expect(
                (await harness().handle(request('/v1/dispatch', { headers: { 'content-type': contentType } }))).status,
            ).toBe(200);
        },
    );

    it.each([
        '',
        'text/plain',
        'application/octet-stream',
        'application/json; charset=utf-16',
        'application/json; charset=utf-8; boundary=x',
        'application/json, application/json',
        'application/problem+json',
    ])('rejects unsupported, ambiguous or extra media parameters: %s', async (contentType) => {
        const h = harness();
        await expectFailure(await h.handle(request('/v1/dispatch', { headers: { 'content-type': contentType } })), 415);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('rejects missing media type, any content encoding and any cookie or Origin header', async () => {
        const h = harness();
        const missing = request();
        missing.headers.delete('content-type');
        await expectFailure(await h.handle(missing), 415);
        for (const headers of [{ 'content-encoding': 'gzip' }, { 'content-encoding': 'identity' }] as HeadersInit[]) {
            await expectFailure(await h.handle(request('/v1/dispatch', { headers })), 415);
        }
        for (const headers of [
            { cookie: 'session=secret' },
            { origin: ORIGIN },
            { origin: 'https://attacker.example' },
        ] as HeadersInit[]) {
            await expectFailure(await h.handle(request('/v1/dispatch', { headers })), 400);
        }
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each([
        '',
        'null',
        '1',
        '[]',
        'not-json',
        '{"a":1,"a":2}',
        '{ "a":1}',
        '{"a":"\\u0061"}',
        '{"a":"\\/"}',
        '{"a":1}\n',
        '{"a":"é"}',
    ])('rejects noncanonical, nonobject, control or non-ASCII bodies: %s', async (body) => {
        const h = harness();
        await expectFailure(await h.handle(request('/v1/dispatch', { body })), 400);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('rejects a missing body or one already consumed', async () => {
        const h = harness();
        await expectFailure(await h.handle(request('/v1/dispatch', { body: null })), 400);
        const consumed = request();
        await consumed.text();
        await expectFailure(await h.handle(consumed), 400);
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('reads split streamed bodies without changing their exact signed bytes', async () => {
        const h = harness();
        const bytes = new TextEncoder().encode(BODY);
        const { req } = streamedRequest([bytes.slice(0, 4), bytes.slice(4, 19), bytes.slice(19)]);
        expect((await h.handle(req)).status).toBe(200);
        expect(h.gateway.dispatch).toHaveBeenCalledExactlyOnceWith(TOKEN, BODY);
    });

    it('rejects malformed and incomplete UTF-8 before gateway invocation', async () => {
        const h = harness();
        for (const chunks of [
            [Uint8Array.from([0xff])],
            [Uint8Array.from([0xc3])],
            [Uint8Array.from([0xc3]), Uint8Array.from([0x28])],
        ]) {
            await expectFailure(await h.handle(streamedRequest(chunks).req), 400);
        }
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each([
        ['/v1/register', 4096],
        ['/v1/dispatch', 100 * 1024],
    ] as const)('enforces the exact byte limit for %s', async (path, limit) => {
        const h = harness();
        const body = JSON.stringify({ padding: 'x'.repeat(limit - 14) });
        expect(new TextEncoder().encode(body)).toHaveLength(limit);
        expect((await h.handle(request(path, { body }))).status).toBe(200);
        await expectFailure(
            await h.handle(request(path, { body: JSON.stringify({ padding: 'x'.repeat(limit - 13) }) })),
            413,
        );
        expect(path === '/v1/register' ? h.gateway.register : h.gateway.dispatch).toHaveBeenCalledOnce();
    });

    it('enforces body bounds while streaming even without a length header', async () => {
        const h = harness();
        const { req, cancel } = streamedRequest([new Uint8Array(100 * 1024).fill(32), Uint8Array.from([32])]);
        await expectFailure(await h.handle(req), 413);
        expect(cancel).toHaveBeenCalledOnce();
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each(['-1', '01', '1.5', 'NaN', 'Infinity', '1, 1', '+1'])(
        'rejects an invalid Content-Length: %s',
        async (length) => {
            const h = harness();
            await expectFailure(
                await h.handle(request('/v1/dispatch', { headers: { 'content-length': length } })),
                400,
            );
            expect(h.gateway.dispatch).not.toHaveBeenCalled();
        },
    );

    it('checks declared length before reading and requires it to match received bytes', async () => {
        const h = harness();
        await expectFailure(await h.handle(request('/v1/register', { headers: { 'content-length': '4097' } })), 413);
        await expectFailure(
            await h.handle(request('/v1/dispatch', { headers: { 'content-length': String(BODY.length - 1) } })),
            400,
        );
        await expectFailure(
            await h.handle(request('/v1/dispatch', { headers: { 'content-length': String(BODY.length + 1) } })),
            400,
        );
        expect(
            (await h.handle(request('/v1/dispatch', { headers: { 'content-length': String(BODY.length) } }))).status,
        ).toBe(200);
        expect(h.gateway.dispatch).toHaveBeenCalledOnce();
    });

    it('rejects ambiguous transfer-encoding plus content-length', async () => {
        const h = harness();
        await expectFailure(
            await h.handle(
                request('/v1/dispatch', {
                    headers: { 'content-length': String(BODY.length), 'transfer-encoding': 'chunked' },
                }),
            ),
            400,
        );
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('maps Auth/signature/SQL/unknown gateway failures identically without error details or terminal receipts', async () => {
        const h = harness();
        for (const error of [
            new Error(`private credential ${TOKEN} body ${BODY}`),
            { status: 401, reason: 'blocked' },
            'SQL secret',
            undefined,
        ]) {
            h.gateway.dispatch.mockRejectedValueOnce(error);
            const response = await h.handle(request());
            await expectFailure(response, 503);
        }
        h.gateway.register.mockRejectedValueOnce(new Error('registration details'));
        await expectFailure(await h.handle(request('/v1/register')), 503);
    });

    it('returns valid plain JSON values without invoking custom serializers/getters', async () => {
        const h = harness();
        const data = Object.assign(Object.create(null), { text: 'wind 🌊', number: 1.25, array: [true, false, null] });
        h.gateway.dispatch.mockResolvedValueOnce(data);
        expect(await (await h.handle(request())).json()).toEqual({ version: 1, result: data });
        const getter = vi.fn(() => 'secret');
        const toJSON = vi.fn(() => 'secret');
        const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });
        for (const result of [accessor, { toJSON }, new Date(), new Map()]) {
            h.gateway.dispatch.mockResolvedValueOnce(result);
            await expectFailure(await h.handle(request()), 503);
        }
        expect(getter).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
    });

    it('rejects non-JSON/cyclic/deep/sparse/accessor response values', async () => {
        const h = harness();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        let deep: unknown = null;
        for (let index = 0; index < 66; index++) deep = { value: deep };
        const sparse = new Array(2);
        const getter = vi.fn(() => 1);
        const accessor = Object.defineProperty([1], '0', { enumerable: true, get: getter });
        for (const result of [
            undefined,
            NaN,
            Infinity,
            1n,
            Symbol('secret'),
            cyclic,
            deep,
            sparse,
            accessor,
            new Array(32_769).fill(1),
        ]) {
            h.gateway.dispatch.mockResolvedValueOnce(result);
            await expectFailure(await h.handle(request()), 503);
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('bounds complete successful UTF-8 response bytes including the version envelope', async () => {
        const h = harness();
        const overhead = JSON.stringify({ version: 1, result: '' }).length;
        h.gateway.dispatch.mockResolvedValueOnce('x'.repeat(MAX_RESEARCH_HTTP_RESPONSE_BYTES - overhead));
        const exact = await h.handle(request());
        expect(exact.status).toBe(200);
        expect(new TextEncoder().encode(await exact.text())).toHaveLength(MAX_RESEARCH_HTTP_RESPONSE_BYTES);
        for (const result of [
            'x'.repeat(MAX_RESEARCH_HTTP_RESPONSE_BYTES - overhead + 1),
            '🌊'.repeat(MAX_RESEARCH_HTTP_RESPONSE_BYTES / 4),
            '\u0000'.repeat(MAX_RESEARCH_HTTP_RESPONSE_BYTES / 2),
        ]) {
            h.gateway.dispatch.mockResolvedValueOnce(result);
            await expectFailure(await h.handle(request()), 503);
        }
    });

    it('bounds a stalled body, cancels it and never starts gateway work', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const pending = h.handle(request('/v1/dispatch', { body, duplex: 'half' } as RequestInit));
        await vi.advanceTimersByTimeAsync(50);
        await expectFailure(await pending, 504);
        expect(cancel).toHaveBeenCalledOnce();
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'enforces elapsed deadline during continuously replenished microtasks (empty chunks: %s)',
        async (empty) => {
            vi.useFakeTimers();
            const h = harness(50);
            let monotonicNow = 0;
            vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
            const cancel = vi.fn();
            const bytes = new TextEncoder().encode(BODY);
            let index = 0;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        monotonicNow += 30;
                        const chunk = empty ? new Uint8Array() : bytes.slice(index, index + 1);
                        index++;
                        controller.enqueue(chunk);
                    },
                    cancel,
                },
                { highWaterMark: 0 },
            );
            const pending = h.handle(request('/v1/dispatch', { body, duplex: 'half' } as RequestInit));
            // No timer/event-loop advance: only stream reads/microtasks observe the
            // clock passing the full deadline. Empty chunks do not buy extra time.
            await expectFailure(await pending, 504);
            expect(monotonicNow).toBe(60);
            expect(cancel).toHaveBeenCalledOnce();
            expect(h.gateway.dispatch).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('checks monotonic deadline after synchronous gateway completion before accepting its outcome', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        let monotonicNow = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
        h.gateway.dispatch.mockImplementationOnce(async () => {
            monotonicNow = 50;
            return { accepted: true, possiblyCommittedOutcome: true };
        });
        await expectFailure(await h.handle(request()), 504);
        expect(h.gateway.dispatch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('checks monotonic deadline during synchronous response serialization without a timer turn', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        let monotonicNow = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
        const req = request();
        const encode = TextEncoder.prototype.encode;
        vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input) {
            if (input === '{"version":1,"result":') monotonicNow = 50;
            return encode.call(this, input);
        });
        await expectFailure(await h.handle(req), 504);
        expect(h.gateway.dispatch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds a gateway that ignores cancellation without inventing its final committed outcome', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        let complete!: (result: unknown) => void;
        h.gateway.dispatch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const pending = h.handle(request());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.gateway.dispatch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(50);
        const response = await pending;
        await expectFailure(response, 504);
        complete({ accepted: true, lateCommittedOutcome: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(response.status).toBe(504);
        // A caller must retry/reconcile the same durable request, not drop its
        // outbox because this HTTP deadline happened before commit became known.
    });

    it('observes a gateway rejection after its response deadline without leaking or an unhandled rejection', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        let reject!: (error: unknown) => void;
        h.gateway.dispatch.mockImplementationOnce(
            () =>
                new Promise((_resolve, fail) => {
                    reject = fail;
                }),
        );
        const pending = h.handle(request());
        await vi.advanceTimersByTimeAsync(50);
        await expectFailure(await pending, 504);
        reject(new Error(`late secret ${TOKEN}`));
        await vi.advanceTimersByTimeAsync(0);
    });

    it('stops a disconnected body read and refuses an already aborted request', async () => {
        const h = harness();
        const controller = new AbortController();
        controller.abort();
        await expectFailure(await h.handle(request('/v1/dispatch', { signal: controller.signal })), 503);
        const active = new AbortController();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const pending = h.handle(
            request('/v1/dispatch', { body, duplex: 'half', signal: active.signal } as RequestInit),
        );
        active.abort();
        await expectFailure(await pending, 503);
        expect(cancel).toHaveBeenCalledOnce();
        expect(h.gateway.dispatch).not.toHaveBeenCalled();
    });

    it('treats disconnect during gateway work as unresolved even when that work later commits', async () => {
        vi.useFakeTimers();
        const h = harness();
        const controller = new AbortController();
        let complete!: (result: unknown) => void;
        h.gateway.dispatch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const pending = h.handle(request('/v1/dispatch', { signal: controller.signal }));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.gateway.dispatch).toHaveBeenCalledOnce();
        controller.abort();
        await expectFailure(await pending, 503);
        complete({ accepted: true });
        await vi.advanceTimersByTimeAsync(0);
    });

    it('clears timer/listener state after a completed response', async () => {
        vi.useFakeTimers();
        const h = harness();
        const controller = new AbortController();
        const response = await h.handle(request('/v1/dispatch', { signal: controller.signal }));
        expect(response.status).toBe(200);
        expect(vi.getTimerCount()).toBe(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(2000);
        expect(await response.json()).toEqual({ version: 1, result: { rows: [] } });
    });
});
