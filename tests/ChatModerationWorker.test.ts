// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CHAT_MODERATION_MAX_OUTPUT_TOKENS,
    CHAT_MODERATION_TIMEOUT_MS,
    DEFAULT_CHAT_MODERATION_MODEL,
    type ChatModerationFetch,
} from '../supabase/functions/moderate-chat-message/moderation';
import {
    createChatModerationHandler,
    CHAT_MODERATION_HEALTH_MESSAGE,
    MAX_CHAT_MODERATION_ATTEMPTS,
    RECOVERY_GENERAL_CHANNEL_ID,
    type ChatModerationDiagnostic,
    type ChatModerationGateway,
    type ChatModerationRow,
} from '../supabase/functions/moderate-chat-message/worker';

// Synthetic credentials/content only; every provider request is injected.
const ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_KEY = 'synthetic-service-secret';
const API_KEY = 'synthetic-provider-secret';
const NOW = '2026-10-02T02:00:00.000Z';
const MESSAGE = 'Synthetic private text: which anchorage is sheltered?';

const verdict = (overrides: Record<string, unknown> = {}) => ({
    verdict: 'clean',
    reason: 'Normal sailing discussion',
    confidence: 0.99,
    category: 'none',
    ...overrides,
});
const envelope = (value: unknown = verdict()) => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});
const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
const request = (body: unknown = { record: { id: ID } }, auth = `Bearer ${SERVICE_KEY}`, method = 'POST') =>
    new Request('https://edge.invalid/moderate-chat-message', {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) }),
    });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function harness(envOverrides: Record<string, string | undefined> = {}, rowOverrides: Partial<ChatModerationRow> = {}) {
    const env: Record<string, string | undefined> = {
        SUPABASE_URL: 'https://database.invalid',
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        GEMINI_API_KEY: API_KEY,
        ...envOverrides,
    };
    const state: { row: ChatModerationRow | null; patch: Record<string, unknown> } = {
        row: {
            id: ID,
            message: MESSAGE,
            moderation_status: 'pending',
            moderation_attempts: 0,
            moderation_reason: null,
            deleted_at: null,
            channel_id: RECOVERY_GENERAL_CHANNEL_ID,
            user_id: '22222222-2222-4222-8222-222222222222',
            created_at: '2026-10-01T01:00:00.000Z',
            ...rowOverrides,
        },
        patch: {},
    };
    const matchesHold = (snapshot: ChatModerationRow, attempts: number) =>
        Boolean(
            state.row &&
            ['id', 'channel_id', 'user_id', 'message', 'created_at'].every(
                (key) => state.row![key as keyof ChatModerationRow] === snapshot[key as keyof ChatModerationRow],
            ) &&
            state.row.moderation_status === 'held' &&
            state.row.moderation_attempts === attempts &&
            state.row.moderation_reason === 'Moderation unavailable' &&
            state.row.deleted_at === null,
        );
    const gateway: ChatModerationGateway = {
        // Snapshot the read, like a completed SELECT; later state changes must
        // not silently mutate the handler's already-read moderation status.
        lookup: vi.fn<ChatModerationGateway['lookup']>(async () => ({
            row: state.row ? { ...state.row } : null,
            error: null,
        })),
        updatePending: vi.fn<ChatModerationGateway['updatePending']>(async (id, patch) => {
            if (state.row?.id === id && state.row.moderation_status === 'pending') {
                Object.assign(state.row, patch);
                Object.assign(state.patch, patch);
            }
            return { error: null };
        }),
        claimUnavailableHold: vi.fn<ChatModerationGateway['claimUnavailableHold']>(async (snapshot) => {
            const matched = matchesHold(snapshot, 5);
            if (matched) {
                state.row!.moderation_attempts = 6;
                state.patch.moderation_attempts = 6;
            }
            return { matched, error: null };
        }),
        settleUnavailableHold: vi.fn<ChatModerationGateway['settleUnavailableHold']>(async (snapshot, patch) => {
            const matched = matchesHold(snapshot, 6);
            if (matched) {
                Object.assign(state.row!, patch);
                Object.assign(state.patch, patch);
            }
            return { matched, error: null };
        }),
    };
    const createGateway = vi.fn(() => gateway);
    const fetcher = vi.fn<ChatModerationFetch>().mockImplementation(async () => json(envelope()));
    const diagnostic = vi.fn<(event: ChatModerationDiagnostic) => void>();
    const handler = createChatModerationHandler({
        env: (key) => env[key],
        createGateway,
        fetcher,
        now: () => NOW,
        diagnostic,
    });
    return { handler, env, state, gateway, createGateway, fetcher, diagnostic };
}

afterEach(() => {
    try {
        if (vi.isFakeTimers()) vi.clearAllTimers();
    } finally {
        vi.useRealTimers();
    }
});

describe('moderation worker authorization and request boundary', () => {
    it.each([
        { auth: `Bearer ${SERVICE_KEY}`, method: 'GET', status: 405 },
        { auth: `Bearer ${SERVICE_KEY}`, method: 'OPTIONS', status: 405 },
        { auth: '', method: 'POST', status: 401 },
        { auth: 'Bearer synthetic-user-jwt', method: 'POST', status: 401 },
        { auth: `bearer ${SERVICE_KEY}`, method: 'POST', status: 401 },
        { auth: `Bearer ${SERVICE_KEY}-extra`, method: 'POST', status: 401 },
    ])('denies $method / $auth before database or provider work', async ({ auth, method, status }) => {
        const h = harness();
        const response = await h.handler(request(undefined, auth, method));
        expect(response.status).toBe(status);
        expect(h.createGateway).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('no-store');
        if (status === 405) expect(response.headers.get('allow')).toBe('POST');
    });

    it.each(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'])('fails closed when %s is absent', async (key) => {
        const h = harness({ [key]: undefined });
        expect((await h.handler(request())).status).toBe(500);
        expect(h.createGateway).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it.each([null, [], { id: 'not-a-uuid' }, { record: {} }])(
        'validates webhook/RPC input before lookup: %j',
        async (body) => {
            const h = harness();
            expect((await h.handler(request(body))).status).toBe(400);
            expect(h.createGateway).not.toHaveBeenCalled();
            expect(h.fetcher).not.toHaveBeenCalled();
        },
    );

    it('accepts the id-only service retry body, with the same guard', async () => {
        const h = harness();
        expect((await h.handler(request({ id: ID }))).status).toBe(200);
        expect(h.gateway.lookup).toHaveBeenCalledExactlyOnceWith(ID);
    });

    it('uses the webhook record id, not a conflicting top-level id', async () => {
        const h = harness();
        expect((await h.handler(request({ record: { id: ID }, id: 'not-a-uuid' }))).status).toBe(200);
        expect(h.gateway.lookup).toHaveBeenCalledExactlyOnceWith(ID);
    });

    it.each(['{', 'x'.repeat(16_385)])('rejects malformed or oversized request bodies without lookup', async (body) => {
        const h = harness();
        const req = new Request('https://edge.invalid/moderate-chat-message', {
            method: 'POST',
            headers: { Authorization: `Bearer ${SERVICE_KEY}` },
            body,
        });
        expect((await h.handler(req)).status).toBe(400);
        expect(h.createGateway).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it.each(['approved', 'rejected', 'held'])('never reprocesses a terminal %s row', async (moderation_status) => {
        const h = harness({}, { moderation_status });
        expect(await (await h.handler(request())).json()).toEqual({ skipped: true });
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
    });

    it('skips an absent row', async () => {
        const h = harness();
        h.state.row = null;
        expect(await (await h.handler(request())).json()).toEqual({ skipped: true });
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
    });
});

describe('complete Gemini verdicts through the deployed handler logic', () => {
    it('approves clean content and uses the supported default with key only in a header', async () => {
        const h = harness();
        const response = await h.handler(request());
        expect(await response.json()).toEqual({ ok: true, verdict: 'clean' });
        expect(h.state.patch).toEqual({ moderation_status: 'approved', moderation_reason: null, moderated_at: NOW });
        expect(h.createGateway).toHaveBeenCalledExactlyOnceWith('https://database.invalid', SERVICE_KEY);
        const [url, init] = h.fetcher.mock.calls[0];
        expect(url).toBe(
            `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_CHAT_MODERATION_MODEL}:generateContent`,
        );
        expect(new URL(url).search).toBe('');
        expect(url).not.toContain(API_KEY);
        expect(new Headers(init.headers).get('x-goog-api-key')).toBe(API_KEY);
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        expect(body.generationConfig).toEqual({
            maxOutputTokens: CHAT_MODERATION_MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: false },
            responseMimeType: 'application/json',
        });
        expect(body.contents[0].parts[0].text).toBe(`Classify this message JSON string:\n${JSON.stringify(MESSAGE)}`);
        expect(init.body).not.toContain(API_KEY);
        expect(init.body).not.toContain(SERVICE_KEY);
        expect(h.diagnostic).not.toHaveBeenCalled();
    });

    it('publishes a warning with a bounded flag reason, without soft-delete', async () => {
        const h = harness();
        h.fetcher.mockResolvedValueOnce(
            json(envelope(verdict({ verdict: 'warning', reason: 'x'.repeat(400), category: 'harassment' }))),
        );
        expect(await (await h.handler(request())).json()).toEqual({ ok: true, verdict: 'warning' });
        expect(h.state.patch).toEqual({
            moderation_status: 'approved',
            moderated_at: NOW,
            moderation_reason: `Flagged: ${'x'.repeat(280)}`,
        });
    });

    it.each(['remove', 'escalate'])('soft-rejects %s, never approves', async (action) => {
        const h = harness();
        const reason = 'Synthetic prohibited content';
        h.fetcher.mockResolvedValueOnce(json(envelope(verdict({ verdict: action, reason, category: 'threats' }))));
        expect(await (await h.handler(request())).json()).toEqual({ ok: true, verdict: action });
        expect(h.state.patch).toEqual({
            moderation_status: 'rejected',
            moderated_at: NOW,
            deleted_at: NOW,
            moderation_reason: action === 'escalate' ? `Escalated: ${reason}` : reason,
        });
        expect(JSON.stringify(h.diagnostic.mock.calls)).not.toContain(reason);
        if (action === 'escalate')
            expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'escalated', messageId: ID });
    });

    it('uses configured low thinking for a supported model that has no minimal mode', async () => {
        const h = harness({ CHAT_MODERATION_GEMINI_MODEL: ' gemini-3.7-flash ' });
        expect((await h.handler(request())).status).toBe(200);
        const [url, init] = h.fetcher.mock.calls[0];
        expect(url).toContain('/gemini-3.7-flash:generateContent');
        expect(JSON.parse(String(init.body)).generationConfig.thinkingConfig.thinkingLevel).toBe('low');
    });

    it('uses final JSON, not a separate thought part, as the verdict', async () => {
        const h = harness();
        h.fetcher.mockResolvedValueOnce(
            json({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: {
                            parts: [
                                { thought: true, text: JSON.stringify(verdict({ verdict: 'clean' })) },
                                {
                                    text: JSON.stringify(verdict({ verdict: 'remove', category: 'harassment' })),
                                    thoughtSignature: 'opaque-synthetic-signature',
                                },
                            ],
                        },
                    },
                ],
            }),
        );
        expect(await (await h.handler(request())).json()).toEqual({ ok: true, verdict: 'remove' });
        expect(h.state.row?.moderation_status).toBe('rejected');
    });
});

describe('fail-closed provider and configuration failures', () => {
    it.each([
        'gemini-2.0-flash',
        'gemini-2.0-flash-001',
        'gemini-2.5-flash',
        'gemini-3.6-flash-preview',
        '',
        '../gemini-3.6-flash?key=x',
        'models/gemini-3.6-flash',
    ])('rejects unsupported/deprecated model %j without an HTTP request', async (model) => {
        const h = harness({ CHAT_MODERATION_GEMINI_MODEL: model });
        expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'model_not_supported', messageId: ID });
    });

    it.each([undefined, '', '   ', 'synthetic\nsecret'])(
        'does not approve or call Gemini without a usable API key',
        async (key) => {
            const h = harness({ GEMINI_API_KEY: key });
            expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
            expect(h.fetcher).not.toHaveBeenCalled();
            expect(h.state.patch).toEqual({ moderation_attempts: 1 });
            expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'api_key_missing', messageId: ID });
        },
    );

    it.each([404, 429, 500])(
        'keeps a provider HTTP %i failure pending without logging its body/key',
        async (status) => {
            const h = harness();
            h.fetcher.mockResolvedValueOnce(json({ error: `${API_KEY} ${MESSAGE}` }, status));
            expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
            expect(h.state.patch).toEqual({ moderation_attempts: 1 });
            expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({
                code: 'provider_http_error',
                messageId: ID,
                httpStatus: status,
            });
            expect(JSON.stringify(h.diagnostic.mock.calls)).not.toContain(API_KEY);
            expect(JSON.stringify(h.diagnostic.mock.calls)).not.toContain(MESSAGE);
        },
    );

    it('treats a transport exception as unavailable without exposing its raw exception', async () => {
        const h = harness();
        h.fetcher.mockRejectedValueOnce(new Error(`${API_KEY} ${MESSAGE}`));
        expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'provider_transport_error', messageId: ID });
    });

    it.each([
        { label: 'not JSON', body: '{', mime: 'application/json' },
        { label: 'HTML', body: '<html>clean</html>', mime: 'text/html' },
        { label: 'array envelope', body: '[]', mime: 'application/json' },
        { label: 'oversized envelope', body: JSON.stringify({ text: 'x'.repeat(65_537) }), mime: 'application/json' },
        { label: 'no candidates', body: '{}', mime: 'application/json' },
    ])('does not approve a malformed $label HTTP success', async ({ body, mime }) => {
        const h = harness();
        h.fetcher.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': mime } }));
        expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'provider_malformed', messageId: ID });
    });

    it.each([
        verdict({ verdict: 'approve' }),
        verdict({ confidence: '0.99' }),
        verdict({ confidence: 2 }),
        verdict({ reason: '' }),
        verdict({ reason: null }),
        verdict({ category: 'invented' }),
        { verdict: 'clean' },
        [verdict()],
        verdict({ extra: 'unrecognized' }),
    ])('never publishes an invalid verdict payload %j', async (value) => {
        const h = harness();
        h.fetcher.mockResolvedValueOnce(json(envelope(value)));
        expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'provider_malformed', messageId: ID });
    });

    it.each([
        { promptFeedback: { blockReason: 'SAFETY' }, ...envelope() },
        { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: JSON.stringify(verdict()) }] } }] },
        {
            candidates: [
                {
                    finishReason: 'STOP',
                    safetyRatings: [{ blocked: true }],
                    content: { parts: [{ text: JSON.stringify(verdict()) }] },
                },
            ],
        },
    ])('does not trust an apparent clean verdict inside a safety-blocked response', async (value) => {
        const h = harness();
        h.fetcher.mockResolvedValueOnce(json(value));
        expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'provider_blocked', messageId: ID });
    });

    it.each(['MAX_TOKENS', 'RECITATION', undefined])(
        'requires STOP even when %j includes valid-looking JSON',
        async (finishReason) => {
            const h = harness();
            h.fetcher.mockResolvedValueOnce(
                json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(verdict()) }] } }] }),
            );
            expect(await (await h.handler(request())).json()).toEqual({ pending: true, held: false });
            expect(h.state.patch).toEqual({ moderation_attempts: 1 });
            expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'provider_incomplete', messageId: ID });
        },
    );

    it('holds exactly the fifth failed check, without ever approving earlier failures', async () => {
        const h = harness({ GEMINI_API_KEY: undefined });
        for (let attempts = 1; attempts <= MAX_CHAT_MODERATION_ATTEMPTS; attempts++) {
            const response = await h.handler(request());
            expect(await response.json()).toEqual({
                pending: attempts < MAX_CHAT_MODERATION_ATTEMPTS,
                held: attempts === MAX_CHAT_MODERATION_ATTEMPTS,
            });
            expect(h.state.row?.moderation_attempts).toBe(attempts);
            expect(h.state.row?.moderation_status).toBe(attempts < MAX_CHAT_MODERATION_ATTEMPTS ? 'pending' : 'held');
        }
        expect(h.state.patch).toEqual({
            moderation_status: 'held',
            moderation_attempts: 5,
            moderation_reason: 'Moderation unavailable',
            moderated_at: NOW,
        });
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(await (await h.handler(request())).json()).toEqual({ skipped: true });
        expect(h.gateway.updatePending).toHaveBeenCalledTimes(5);
    });
});

describe('deadline and database races', () => {
    it('bounds an ignored-abort fetch and cannot approve its late clean answer', async () => {
        vi.useFakeTimers();
        const h = harness();
        const late = deferred<Response>();
        h.fetcher.mockImplementationOnce(() => late.promise);
        const pending = h.handler(request());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CHAT_MODERATION_TIMEOUT_MS);
        expect(await (await pending).json()).toEqual({ pending: true, held: false });
        expect(h.fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        late.resolve(json(envelope()));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.gateway.updatePending).toHaveBeenCalledTimes(1);
        expect(h.state.row?.moderation_status).toBe('pending');
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'provider_timeout', messageId: ID });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds a stalled response body, not just the initial HTTP response', async () => {
        vi.useFakeTimers();
        const h = harness();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        h.fetcher.mockResolvedValueOnce(
            new Response(
                new ReadableStream<Uint8Array>({
                    start: (value) => {
                        controller = value;
                    },
                }),
                {
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );
        const pending = h.handler(request());
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(CHAT_MODERATION_TIMEOUT_MS);
        expect(await (await pending).json()).toEqual({ pending: true, held: false });
        expect(h.state.patch).toEqual({ moderation_attempts: 1 });
        // This synthetic body ignores the aborted transport; release its late
        // reader explicitly and prove that it cannot publish after the deadline.
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope())));
        controller.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.gateway.updatePending).toHaveBeenCalledTimes(1);
        expect(h.state.row?.moderation_status).toBe('pending');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cannot overwrite a concurrent held row with a late clean verdict', async () => {
        const h = harness();
        const waiting = deferred<Response>();
        const started = deferred<void>();
        h.fetcher.mockImplementationOnce(() => {
            started.resolve();
            return waiting.promise;
        });
        const pending = h.handler(request());
        await started.promise;
        h.state.row!.moderation_status = 'held';
        waiting.resolve(json(envelope()));
        await pending;
        expect(h.gateway.updatePending).toHaveBeenCalledTimes(1);
        expect(h.state.row?.moderation_status).toBe('held');
        expect(h.state.patch).toEqual({});
    });

    it('reports a lookup failure without provider calls or raw database errors', async () => {
        const h = harness();
        vi.mocked(h.gateway.lookup).mockResolvedValueOnce({ row: null, error: new Error(MESSAGE) });
        expect((await h.handler(request())).status).toBe(500);
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
        expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith({ code: 'lookup_failed', messageId: ID });
    });

    it.each([true, false])('fails closed when an %s success/failure transition cannot persist', async (classified) => {
        const h = harness(classified ? {} : { GEMINI_API_KEY: undefined });
        vi.mocked(h.gateway.updatePending).mockResolvedValueOnce({ error: new Error(MESSAGE) });
        expect((await h.handler(request())).status).toBe(500);
        expect(h.state.row?.moderation_status).toBe('pending');
        expect(h.state.patch).toEqual({});
        expect(h.diagnostic).toHaveBeenCalledWith({ code: 'update_failed', messageId: ID });
        expect(JSON.stringify(h.diagnostic.mock.calls)).not.toContain(MESSAGE);
    });
});

describe('service-only provider canary and one-off General unavailable-hold rescue', () => {
    const recoveryRequest = () => request({ id: ID, retry_unavailable_hold: true });
    const held = () =>
        harness({}, { moderation_status: 'held', moderation_attempts: 5, moderation_reason: 'Moderation unavailable' });

    it('classifies only a fixed sailing greeting in healthcheck mode and never opens the database', async () => {
        const h = harness({ SUPABASE_URL: undefined });
        const response = await h.handler(request({ healthcheck: true }));
        expect(await response.json()).toEqual({ ok: true, verdict: 'clean' });
        expect(h.createGateway).not.toHaveBeenCalled();
        expect(h.gateway.lookup).not.toHaveBeenCalled();
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
        expect(h.gateway.claimUnavailableHold).not.toHaveBeenCalled();
        expect(h.gateway.settleUnavailableHold).not.toHaveBeenCalled();
        const body = JSON.parse(String(h.fetcher.mock.calls[0][1].body));
        expect(body.contents[0].parts[0].text).toBe(
            `Classify this message JSON string:\n${JSON.stringify(CHAT_MODERATION_HEALTH_MESSAGE)}`,
        );
        expect(JSON.stringify(body)).not.toContain(MESSAGE);
    });

    it('returns unavailable from the healthcheck without any database access or mutation', async () => {
        const h = harness({ GEMINI_API_KEY: undefined });
        const response = await h.handler(request({ healthcheck: true }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ok: false, unavailable: true, code: 'api_key_missing' });
        expect(h.createGateway).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(h.state.patch).toEqual({});
    });

    it.each([{ healthcheck: true }, { id: ID, retry_unavailable_hold: true }])(
        'applies exact service authorization to privileged mode %j',
        async (body) => {
            const h = held();
            expect((await h.handler(request(body, 'Bearer synthetic-user-jwt'))).status).toBe(401);
            expect(h.createGateway).not.toHaveBeenCalled();
            expect(h.fetcher).not.toHaveBeenCalled();
            expect(h.state.patch).toEqual({});
        },
    );

    it.each([
        { id: ID, retry_unavailable_hold: 'true' },
        { healthcheck: 'true' },
        { healthcheck: true, id: ID },
        { healthcheck: true, retry_unavailable_hold: true },
    ])('refuses malformed or ambiguous service mode %j', async (body) => {
        const h = held();
        expect((await h.handler(request(body))).status).toBe(400);
        expect(h.createGateway).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('CAS-claims attempts 5→6 while still held, then settles a fresh clean verdict', async () => {
        const h = held();
        h.fetcher.mockImplementationOnce(async () => {
            expect(h.state.row?.moderation_status).toBe('held');
            expect(h.state.row?.moderation_attempts).toBe(6);
            expect(h.gateway.claimUnavailableHold).toHaveBeenCalledTimes(1);
            return json(envelope());
        });
        expect(await (await h.handler(recoveryRequest())).json()).toEqual({ ok: true, verdict: 'clean' });
        expect(h.state.patch).toEqual({
            moderation_attempts: 6,
            moderation_status: 'approved',
            moderation_reason: null,
            moderated_at: NOW,
        });
        expect(h.gateway.settleUnavailableHold).toHaveBeenCalledTimes(1);
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
    });

    it('makes duplicate concurrent claims classify at most once', async () => {
        const h = held();
        const bothSnapshots = deferred<void>();
        let snapshots = 0;
        vi.mocked(h.gateway.lookup).mockImplementation(async () => {
            const row = { ...h.state.row! };
            if (++snapshots === 2) bothSnapshots.resolve();
            await bothSnapshots.promise;
            return { row, error: null };
        });
        const responses = await Promise.all([h.handler(recoveryRequest()), h.handler(recoveryRequest())]);
        const results = await Promise.all(responses.map((response) => response.json()));
        expect(results).toContainEqual({ skipped: true });
        expect(results).toContainEqual({ ok: true, verdict: 'clean' });
        expect(h.gateway.claimUnavailableHold).toHaveBeenCalledTimes(2);
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        expect(h.gateway.settleUnavailableHold).toHaveBeenCalledTimes(1);
    });

    it.each([
        { channel_id: '33333333-3333-4333-8333-333333333333' },
        { moderation_reason: 'Manual moderation hold' },
        { moderation_attempts: 4 },
        { moderation_attempts: 6 },
        { moderation_status: 'pending' },
        { moderation_status: 'approved' },
        { moderation_status: 'rejected' },
        { deleted_at: NOW },
        { message: '' },
        { user_id: 'not-a-uuid' },
        { created_at: 'not-a-date' },
    ])('does not claim a nonmatching rescue target %j', async (overrides) => {
        const h = harness(
            {},
            {
                moderation_status: 'held',
                moderation_attempts: 5,
                moderation_reason: 'Moderation unavailable',
                ...overrides,
            },
        );
        expect(await (await h.handler(recoveryRequest())).json()).toEqual({ skipped: true });
        expect(h.gateway.claimUnavailableHold).not.toHaveBeenCalled();
        expect(h.gateway.settleUnavailableHold).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(h.state.patch).toEqual({});
    });

    it('preserves an unavailable retry as terminal held6 rather than requeueing it', async () => {
        const h = held();
        h.fetcher.mockResolvedValueOnce(json({ error: 'synthetic failure' }, 500));
        expect(await (await h.handler(recoveryRequest())).json()).toEqual({
            held: true,
            unavailable: true,
            code: 'provider_http_error',
        });
        expect(h.state.row?.moderation_status).toBe('held');
        expect(h.state.row?.moderation_attempts).toBe(6);
        expect(h.state.row?.moderation_reason).toBe('Moderation unavailable');
        expect(h.state.patch).toEqual({ moderation_attempts: 6 });
        expect(h.gateway.settleUnavailableHold).not.toHaveBeenCalled();
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
        expect(await (await h.handler(recoveryRequest())).json()).toEqual({ skipped: true });
        expect(h.fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(['remove', 'escalate'])(
        'reclassifies and soft-rejects a rescued %s verdict rather than blindly approving',
        async (action) => {
            const h = held();
            h.fetcher.mockResolvedValueOnce(
                json(envelope(verdict({ verdict: action, reason: 'Synthetic violation', category: 'threats' }))),
            );
            expect(await (await h.handler(recoveryRequest())).json()).toEqual({ ok: true, verdict: action });
            expect(h.state.row?.moderation_status).toBe('rejected');
            expect(h.state.patch).toMatchObject({
                moderation_attempts: 6,
                moderation_status: 'rejected',
                deleted_at: NOW,
            });
            expect(h.gateway.updatePending).not.toHaveBeenCalled();
        },
    );

    it.each([
        { moderation_status: 'rejected' },
        { moderation_attempts: 7 },
        { moderation_reason: 'Manual moderation hold' },
        { deleted_at: NOW },
        { message: 'Changed synthetic content' },
        { channel_id: '33333333-3333-4333-8333-333333333333' },
        { user_id: '44444444-4444-4444-8444-444444444444' },
        { id: '55555555-5555-4555-8555-555555555555' },
        { created_at: '2026-10-02T01:00:00.000Z' },
    ])('skips settlement after a concurrent authority/content/status change %j', async (changes) => {
        const h = held();
        const waiting = deferred<Response>();
        const started = deferred<void>();
        h.fetcher.mockImplementationOnce(() => {
            started.resolve();
            return waiting.promise;
        });
        const pending = h.handler(recoveryRequest());
        await started.promise;
        Object.assign(h.state.row!, changes);
        waiting.resolve(json(envelope()));
        expect(await (await pending).json()).toEqual({ skipped: true });
        expect(h.state.row).toMatchObject(changes);
        expect(h.state.patch).toEqual({ moderation_attempts: 6 });
        expect(h.gateway.updatePending).not.toHaveBeenCalled();
    });

    it('does not call the provider after a zero-row or failed claim', async () => {
        for (const result of [
            { matched: false, error: null },
            { matched: false, error: new Error(MESSAGE) },
        ]) {
            const h = held();
            vi.mocked(h.gateway.claimUnavailableHold).mockResolvedValueOnce(result);
            expect((await h.handler(recoveryRequest())).status).toBe(result.error ? 500 : 200);
            expect(h.fetcher).not.toHaveBeenCalled();
            expect(h.gateway.settleUnavailableHold).not.toHaveBeenCalled();
            expect(h.state.patch).toEqual({});
        }
    });

    it('does not report a successful recovery if settlement fails', async () => {
        const h = held();
        vi.mocked(h.gateway.settleUnavailableHold).mockResolvedValueOnce({ matched: false, error: new Error(MESSAGE) });
        const response = await h.handler(recoveryRequest());
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ ok: false, verdict: 'clean' });
        expect(h.state.row?.moderation_status).toBe('held');
        expect(h.state.patch).toEqual({ moderation_attempts: 6 });
    });
});
