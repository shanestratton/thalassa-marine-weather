// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseResearchAuthenticator } from '../experiments/scuttlebutt-e2ee/relay/supabaseAuth';

// Transport mocks only: these do not verify a real JWT, live Supabase Auth,
// server revocation behavior, production credentials or database authorization.
const ORIGIN = 'https://research-project.supabase.co';
const KEY = 'sb_publishable_public-research-fixture';
const TOKEN = 'supplied-user-token.fixture';
const USER = '12345678-1234-1234-1234-123456789abc';
const OTHER = 'abcdef12-1234-1234-1234-123456789abc';
const LIMIT = 512 * 1024;

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function harness(response: () => Response = () => json({ id: USER })) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const authenticate = createSupabaseResearchAuthenticator({ supabaseUrl: ORIGIN, publicApiKey: KEY, fetch });
    return { fetch, authenticate };
}
function legacyKey(role: string): string {
    return [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
        Buffer.from(JSON.stringify({ role })).toString('base64url'),
        'signature-fixture',
    ].join('.');
}
function byteStream(chunks: Uint8Array[]) {
    const cancel = vi.fn();
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (next < chunks.length) controller.enqueue(chunks[next++]);
            else controller.close();
        },
        cancel,
    });
    return { response: new Response(body, { headers: { 'content-type': 'application/json' } }), cancel };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('research Supabase Auth adapter with mocked HTTP transport', () => {
    it('sends a fresh request to only the fixed trusted project with explicit user and public credentials', async () => {
        const h = harness();
        await expect(h.authenticate(TOKEN)).resolves.toEqual({ userId: USER });
        await expect(h.authenticate(TOKEN)).resolves.toEqual({ userId: USER });
        expect(h.fetch).toHaveBeenCalledTimes(2);
        for (const [url, options] of h.fetch.mock.calls) {
            expect(url).toBe(`${ORIGIN}/auth/v1/user`);
            expect(options).toMatchObject({
                method: 'GET',
                headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}`, apikey: KEY },
                cache: 'no-store',
                redirect: 'error',
                credentials: 'omit',
            });
            expect(options?.body).toBeUndefined();
            expect(options?.signal).toBeInstanceOf(AbortSignal);
        }
        expect(h.fetch.mock.calls[0][1]?.signal).not.toBe(h.fetch.mock.calls[1][1]?.signal);
    });

    it('uses the latest server id and ignores all editable metadata and claimed actors', async () => {
        const h = harness();
        h.fetch
            .mockResolvedValueOnce(
                json({
                    id: USER,
                    actor: OTHER,
                    userId: OTHER,
                    sub: OTHER,
                    user_metadata: { id: OTHER, role: 'service_role' },
                    app_metadata: { actor: OTHER },
                }),
            )
            .mockResolvedValueOnce(json({ id: OTHER }));
        await expect(h.authenticate(TOKEN)).resolves.toEqual({ userId: USER });
        await expect(h.authenticate(TOKEN)).resolves.toEqual({ userId: OTHER });
    });

    it('captures config before requests and permits a canonical origin with one trailing slash', async () => {
        const h = harness();
        const config = { supabaseUrl: `${ORIGIN}/`, publicApiKey: KEY, fetch: h.fetch };
        const authenticate = createSupabaseResearchAuthenticator(config);
        config.supabaseUrl = 'https://different-project.supabase.co';
        config.publicApiKey = 'sb_publishable_different';
        await authenticate(TOKEN);
        expect(h.fetch).toHaveBeenCalledWith(
            `${ORIGIN}/auth/v1/user`,
            expect.objectContaining({
                headers: expect.objectContaining({ apikey: KEY }),
            }),
        );
    });

    it.each([
        'http://research-project.supabase.co',
        'http://localhost:54321',
        'https://user:password@research-project.supabase.co',
        `${ORIGIN}/auth/v1/user`,
        `${ORIGIN}/%2e`,
        `${ORIGIN}//`,
        `${ORIGIN}?project=other`,
        `${ORIGIN}?`,
        `${ORIGIN}#fragment`,
        `${ORIGIN}#`,
        ` ${ORIGIN}`,
        `${ORIGIN} `,
        'HTTPS://research-project.supabase.co',
        'https://RESEARCH-PROJECT.supabase.co',
        'not-a-url',
    ])('rejects a noncanonical or insecure project origin: %s', (supabaseUrl) => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(() => createSupabaseResearchAuthenticator({ supabaseUrl, publicApiKey: KEY, fetch })).toThrow(
            'Invalid research Supabase Auth configuration',
        );
        expect(fetch).not.toHaveBeenCalled();
    });

    it('allows a legacy anon key but rejects secret, service_role and malformed API keys', async () => {
        const h = harness();
        const key = legacyKey('anon');
        const authenticate = createSupabaseResearchAuthenticator({
            supabaseUrl: ORIGIN,
            publicApiKey: key,
            fetch: h.fetch,
        });
        await authenticate(TOKEN);
        expect(h.fetch.mock.calls[0][1]?.headers).toMatchObject({ apikey: key });
        for (const publicApiKey of [
            '',
            'sb_secret_private-fixture',
            legacyKey('service_role'),
            legacyKey('authenticated'),
            'sb_publishable_',
            `${KEY}\n`,
            `${KEY} `,
            'not-a-key',
            'e30.invalid.signature',
            'x'.repeat(8193),
        ]) {
            expect(() =>
                createSupabaseResearchAuthenticator({ supabaseUrl: ORIGIN, publicApiKey, fetch: h.fetch }),
            ).toThrow('Invalid research Supabase Auth configuration');
        }
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([0, -1, 10_001, 1.5, Infinity, NaN])(
        'rejects timeout outside the integer 1..10000 ms range: %s',
        (timeoutMs) => {
            expect(() =>
                createSupabaseResearchAuthenticator({ supabaseUrl: ORIGIN, publicApiKey: KEY, timeoutMs }),
            ).toThrow('Invalid research Supabase Auth configuration');
        },
    );

    it('rejects malformed credentials before any network request and accepts the exact length boundary', async () => {
        const h = harness();
        for (const credential of [
            '',
            ' ',
            'Bearer token',
            'a b',
            'a\tb',
            'a\rb',
            'a\nb',
            'a\u0000b',
            'a\u007fb',
            'tökén',
            'bad:token',
            'a=b',
            'x'.repeat(8193),
            null,
            undefined,
            5,
        ])
            await expect(h.authenticate(credential as string)).resolves.toBeNull();
        expect(h.fetch).not.toHaveBeenCalled();
        await expect(h.authenticate('x'.repeat(8192))).resolves.toEqual({ userId: USER });
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([201, 204, 301, 302, 307, 308, 400, 401, 403, 429, 500])(
        'fails closed on Auth HTTP status %s',
        async (status) => {
            const h = harness(
                () =>
                    new Response(status === 204 ? null : JSON.stringify({ id: USER }), {
                        status,
                        headers: {
                            'content-type': 'application/json',
                            Location: 'https://untrusted.invalid/auth/v1/user',
                        },
                    }),
            );
            await expect(h.authenticate(TOKEN)).resolves.toBeNull();
            expect(h.fetch).toHaveBeenCalledTimes(1);
        },
    );

    it('rejects a redirected response or a response from a different origin even if transport ignores redirect:error', async () => {
        for (const override of [
            { redirected: true },
            { url: 'https://untrusted.invalid/auth/v1/user' },
            { url: `${ORIGIN}/auth/v1/user?actor=other` },
        ]) {
            const response = json({ id: USER });
            for (const [key, value] of Object.entries(override)) Object.defineProperty(response, key, { value });
            await expect(harness(() => response).authenticate(TOKEN)).resolves.toBeNull();
        }
    });

    it('returns null for transport errors without exposing credentials or internal exception details', async () => {
        const h = harness();
        h.fetch.mockRejectedValue(new Error(`${TOKEN} PRIVATE transport detail`));
        const log = vi.spyOn(console, 'log');
        const warn = vi.spyOn(console, 'warn');
        const error = vi.spyOn(console, 'error');
        await expect(h.authenticate(TOKEN)).resolves.toBeNull();
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it.each([
        null,
        [],
        {},
        { user: { id: USER } },
        { id: 5 },
        { id: '' },
        { id: 'alice' },
        { id: USER.toUpperCase() },
        { id: `${USER}\n` },
        { id: ` ${USER}` },
        { id: `${USER} ` },
        { user_metadata: { id: USER }, sub: USER },
    ])('rejects a response lacking a canonical top-level Auth UUID: %j', async (value) => {
        await expect(harness(() => json(value)).authenticate(TOKEN)).resolves.toBeNull();
    });

    it('rejects malformed JSON, invalid UTF-8, missing body, or non-JSON content types', async () => {
        const responses = [
            new Response('{', { headers: { 'content-type': 'application/json' } }),
            new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
            new Response(null, { headers: { 'content-type': 'application/json' } }),
            new Response(JSON.stringify({ id: USER })),
            new Response(JSON.stringify({ id: USER }), { headers: { 'content-type': 'text/html' } }),
        ];
        for (const response of responses) await expect(harness(() => response).authenticate(TOKEN)).resolves.toBeNull();
    });

    it('rejects oversized declared bodies before consuming the stream', async () => {
        const getReader = vi.fn();
        for (const declaredLength of [String(LIMIT + 1), 'Infinity', '-1', 'abc', '01']) {
            const response = json({ id: USER });
            response.headers.set('content-length', declaredLength);
            Object.defineProperty(response.body!, 'getReader', { value: getReader });
            await expect(harness(() => response).authenticate(TOKEN)).resolves.toBeNull();
        }
        expect(getReader).not.toHaveBeenCalled();
    });

    it('enforces the streaming byte cap without trusting missing or understated Content-Length', async () => {
        for (const declaredLength of [null, '1']) {
            const stream = byteStream([new Uint8Array(LIMIT).fill(32), new Uint8Array([32]), new Uint8Array([32])]);
            if (declaredLength !== null) stream.response.headers.set('content-length', declaredLength);
            await expect(harness(() => stream.response).authenticate(TOKEN)).resolves.toBeNull();
            expect(stream.cancel).toHaveBeenCalledTimes(1);
        }
    });

    it('accepts exactly 512 KiB and decodes a valid multibyte value split across stream chunks', async () => {
        const body = JSON.stringify({ id: USER, ignoredMetadata: 'é' });
        const encoded = new TextEncoder().encode(body);
        const multiByteOffset = encoded.indexOf(0xc3);
        const padding = new Uint8Array(LIMIT - encoded.byteLength).fill(32);
        const stream = byteStream([encoded.slice(0, multiByteOffset + 1), encoded.slice(multiByteOffset + 1), padding]);
        await expect(harness(() => stream.response).authenticate(TOKEN)).resolves.toEqual({ userId: USER });
    });

    it('times out after the default five seconds and never accepts a late fetch result', async () => {
        vi.useFakeTimers();
        let resolve!: (response: Response) => void;
        const h = harness();
        h.fetch.mockImplementation(
            () =>
                new Promise<Response>((yes) => {
                    resolve = yes;
                }),
        );
        const result = h.authenticate(TOKEN);
        await vi.advanceTimersByTimeAsync(4999);
        expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBeNull();
        expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        resolve(json({ id: USER }));
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([1, 10_000])('supports the timeout boundary of %s ms', async (timeoutMs) => {
        vi.useFakeTimers();
        const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));
        const authenticate = createSupabaseResearchAuthenticator({
            supabaseUrl: ORIGIN,
            publicApiKey: KEY,
            fetch,
            timeoutMs,
        });
        const result = authenticate(TOKEN);
        await vi.advanceTimersByTimeAsync(timeoutMs);
        await expect(result).resolves.toBeNull();
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('applies the same deadline to a stalled response body and cancels it', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { 'content-type': 'application/json' },
        });
        const h = harness(() => response);
        const result = h.authenticate(TOKEN);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toBeNull();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('checks monotonic elapsed time before fetch even if the deadline timer has not had a turn', async () => {
        vi.useFakeTimers();
        vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(50);
        const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ id: USER }));
        const authenticate = createSupabaseResearchAuthenticator({
            supabaseUrl: ORIGIN,
            publicApiKey: KEY,
            fetch,
            timeoutMs: 50,
        });
        await expect(authenticate(TOKEN)).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a synchronously completed fetch after its elapsed deadline without advancing timers', async () => {
        vi.useFakeTimers();
        let monotonicNow = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
        const fetch = vi.fn<typeof globalThis.fetch>(async () => {
            monotonicNow = 50;
            return json({ id: USER });
        });
        const authenticate = createSupabaseResearchAuthenticator({
            supabaseUrl: ORIGIN,
            publicApiKey: KEY,
            fetch,
            timeoutMs: 50,
        });
        await expect(authenticate(TOKEN)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])(
        'enforces elapsed deadline during continuously replenished body microtasks (empty chunks: %s)',
        async (empty) => {
            vi.useFakeTimers();
            let monotonicNow = 0;
            vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
            const cancel = vi.fn();
            const bytes = new TextEncoder().encode(JSON.stringify({ id: USER }));
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
            const response = new Response(body, { headers: { 'content-type': 'application/json' } });
            const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
            const authenticate = createSupabaseResearchAuthenticator({
                supabaseUrl: ORIGIN,
                publicApiKey: KEY,
                fetch,
                timeoutMs: 50,
            });
            // No fake-clock/timer advance: body reads themselves move monotonic
            // time. Both tiny and zero-byte chunks must fail closed at the deadline.
            await expect(authenticate(TOKEN)).resolves.toBeNull();
            expect(monotonicNow).toBe(60);
            expect(cancel).toHaveBeenCalledOnce();
            expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('rechecks elapsed deadline after synchronous JSON parsing before confirming an Auth principal', async () => {
        vi.useFakeTimers();
        let monotonicNow = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
        const serialized = JSON.stringify({ id: USER });
        const response = new Response(serialized, { headers: { 'content-type': 'application/json' } });
        const parse = JSON.parse;
        vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
            const parsed: unknown = parse(text, reviver);
            if (text === serialized) monotonicNow = 50;
            return parsed;
        });
        const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
        const authenticate = createSupabaseResearchAuthenticator({
            supabaseUrl: ORIGIN,
            publicApiKey: KEY,
            fetch,
            timeoutMs: 50,
        });
        await expect(authenticate(TOKEN)).resolves.toBeNull();
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
