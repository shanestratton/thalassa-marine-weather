import { type FoundingSkipperEmailConfig } from './email.ts';
import {
    EMAIL_WORKER_BATCH_LIMIT,
    EMAIL_WORKER_LEASE_SECONDS,
    type FoundingSkipperEmailQueueGateway,
    parseClaimedFoundingSkipperEmailJob,
    requireAppliedEmailQueueCheckpoint,
    requireFoundingSkipperEmailWorkerRequest,
    runFoundingSkipperEmailWorker,
} from './worker.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const leaseToken = '0198da8b-1ed2-4000-8000-000000000011';
const config: FoundingSkipperEmailConfig = {
    apiKey: 'resend-test-key',
    alertTo: 'beta@thalassawx.com',
    alertFrom: 'Thalassa Beta <beta@thalassawx.com>',
    applicantFrom: 'Thalassa Founding Skippers <beta@thalassawx.com>',
    replyTo: 'beta@thalassawx.com',
};
const claimedRow = {
    job_id: '0198da8b-1ed2-4000-8000-000000000010',
    lease_token: leaseToken,
    application_id: '0198da8b-1ed2-4000-8000-000000000001',
    message_kind: 'applicant_received_v1',
    attempts: 1,
    name: 'Casey Skipper',
    email: 'casey@example.com',
    boat_type: 'sail_monohull',
    home_waters: 'Moreton Bay',
    apple_device: 'iphone_and_ipad',
    boating_frequency: 'weekly_plus',
    interests: ['marine_weather', 'anchor_watch'],
    notes: null,
    source: 'personal-email',
    consent_version: 'founding-skippers-v2',
    application_status: 'new',
};

interface GatewayEvents {
    claim?: unknown[];
    fence: Array<[string, string, string]>;
    finish: Array<[string, string, string]>;
    retry: Array<[string, string, string, number, boolean]>;
    cancel: Array<[string, string, string]>;
    claimArgs?: [string, number, number];
}

function fakeGateway(
    rows: unknown[],
    fenceResult: 'ready' | 'cancel' | 'lost' = 'ready',
): { gateway: FoundingSkipperEmailQueueGateway; events: GatewayEvents } {
    const events: GatewayEvents = { fence: [], finish: [], retry: [], cancel: [] };
    const gateway: FoundingSkipperEmailQueueGateway = {
        claim(token, limit, leaseSeconds) {
            events.claimArgs = [token, limit, leaseSeconds];
            return Promise.resolve(rows);
        },
        confirmAcceptedLease(jobId, applicationId, token) {
            events.fence.push([jobId, applicationId, token]);
            return Promise.resolve(fenceResult);
        },
        finish(jobId, token, providerMessageId) {
            events.finish.push([jobId, token, providerMessageId]);
            return Promise.resolve();
        },
        retry(jobId, token, code, delay, terminal) {
            events.retry.push([jobId, token, code, delay, terminal]);
            return Promise.resolve();
        },
        cancel(jobId, token, code) {
            events.cancel.push([jobId, token, code]);
            return Promise.resolve();
        },
    };
    return { gateway, events };
}

Deno.test('worker requires POST and accepts its exact built-in service credential', async () => {
    const serviceKey = 'service-role-test-key';
    const getFailure = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', { method: 'GET', headers: { Authorization: `Bearer ${serviceKey}` } }),
        serviceKey,
    );
    assertEquals(getFailure?.status, 405);
    assertEquals(getFailure?.headers.get('allow'), 'POST');

    const authFailure = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', { method: 'POST', headers: { Authorization: 'Bearer user-token' } }),
        serviceKey,
    );
    assertEquals(authFailure?.status, 401);
    assertEquals(
        requireFoundingSkipperEmailWorkerRequest(
            new Request('https://example.test', {
                method: 'POST',
                headers: { Authorization: `Bearer ${serviceKey}` },
            }),
            serviceKey,
        ),
        null,
    );
    await getFailure?.body?.cancel();
    await authFailure?.body?.cancel();
});

Deno.test('worker fast wake requires the exact bounded internal header on POST', async () => {
    const serviceKey = 'modern-built-in-service-secret';
    const anonJwt = 'header.eyJyb2xlIjoiYW5vbiJ9.gateway-verified-signature';
    const accepted = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${anonJwt}`,
                'X-Thalassa-Worker-Key': serviceKey,
            },
        }),
        serviceKey,
    );
    assertEquals(accepted, null);

    const wrongKeyFailure = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${anonJwt}`,
                'X-Thalassa-Worker-Key': `${serviceKey}-wrong`,
            },
        }),
        serviceKey,
    );
    assertEquals(wrongKeyFailure?.status, 401);

    const oversizedKeyFailure = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${anonJwt}`,
                'X-Thalassa-Worker-Key': 'x'.repeat(1_025),
            },
        }),
        serviceKey,
    );
    assertEquals(oversizedKeyFailure?.status, 401);

    const methodFailure = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', {
            method: 'GET',
            headers: { 'X-Thalassa-Worker-Key': serviceKey },
        }),
        serviceKey,
    );
    assertEquals(methodFailure?.status, 405);

    await wrongKeyFailure?.body?.cancel();
    await oversizedKeyFailure?.body?.cancel();
    await methodFailure?.body?.cancel();
});

Deno.test('worker accepts a gateway-verified legacy service-role JWT when its built-in key differs', () => {
    const encode = (value: unknown) =>
        btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const legacyServiceRoleJwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${
        encode({ role: 'service_role', iss: 'supabase' })
    }.gateway-verified-signature`;

    assertEquals(
        requireFoundingSkipperEmailWorkerRequest(
            new Request('https://example.test', {
                method: 'POST',
                headers: { Authorization: `Bearer ${legacyServiceRoleJwt}` },
            }),
            'different-built-in-service-key',
        ),
        null,
    );
});

Deno.test('worker rejects malformed or non-service gateway bearer tokens', async () => {
    const encode = (value: unknown) =>
        btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const jwt = (payload: unknown) => `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
    const authorizations = [
        null,
        '',
        'bearer token',
        'Bearer not-a-jwt',
        'Bearer one.two.three.four',
        'Bearer header.%%%invalid%%%.signature',
        `Bearer header.${btoa('{not-json')}.signature`,
        `Bearer ${jwt(null)}`,
        `Bearer ${jwt([])}`,
        `Bearer ${jwt({ role: 'authenticated' })}`,
        `Bearer ${jwt({ role: 'service-role' })}`,
    ];

    for (const authorization of authorizations) {
        const headers = new Headers();
        if (authorization !== null) headers.set('Authorization', authorization);
        const failure = requireFoundingSkipperEmailWorkerRequest(
            new Request('https://example.test', { method: 'POST', headers }),
            'built-in-service-key',
        );
        assertEquals(failure?.status, 401);
        await failure?.body?.cancel();
    }
});

Deno.test('worker still fails closed when its built-in service credential is unavailable', async () => {
    const payload = btoa(JSON.stringify({ role: 'service_role' })).replaceAll('+', '-').replaceAll('/', '_')
        .replace(/=+$/u, '');
    const failure = requireFoundingSkipperEmailWorkerRequest(
        new Request('https://example.test', {
            method: 'POST',
            headers: { Authorization: `Bearer header.${payload}.signature` },
        }),
        undefined,
    );
    assertEquals(failure?.status, 500);
    await failure?.body?.cancel();
});

Deno.test('stale-lease false RPC results fail every queue checkpoint closed', () => {
    requireAppliedEmailQueueCheckpoint(true, null, 'finish_failed');
    for (const [data, error] of [[false, null], [null, { message: 'database failure' }]] as const) {
        let threw = false;
        try {
            requireAppliedEmailQueueCheckpoint(data, error, 'checkpoint_failed');
        } catch (caught) {
            threw = caught instanceof Error && caught.message === 'checkpoint_failed';
        }
        assert(threw, 'A false/error RPC result must not be counted as a completed checkpoint');
    }
});

Deno.test('claimed rows are strictly validated, including their expected lease and email headers', () => {
    assert(parseClaimedFoundingSkipperEmailJob(claimedRow, leaseToken));
    assertEquals(parseClaimedFoundingSkipperEmailJob(claimedRow, crypto.randomUUID()), null);
    assertEquals(
        parseClaimedFoundingSkipperEmailJob(
            { ...claimedRow, email: 'casey@example.com\r\nBcc: attacker@example.com' },
            leaseToken,
        ),
        null,
    );
});

Deno.test('successful delivery claims a bounded batch and checkpoints the provider id', async () => {
    const { gateway, events } = fakeGateway([claimedRow]);
    const result = await runFoundingSkipperEmailWorker(
        gateway,
        config,
        () =>
            Promise.resolve(
                new Response(JSON.stringify({ id: 'resend-provider-id' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        leaseToken,
    );

    assertEquals(events.claimArgs, [leaseToken, EMAIL_WORKER_BATCH_LIMIT, EMAIL_WORKER_LEASE_SECONDS]);
    assertEquals(events.finish, [[claimedRow.job_id, leaseToken, 'resend-provider-id']]);
    assertEquals(result, {
        claimed: 1,
        sent: 1,
        retried: 0,
        dead: 0,
        cancelled: 0,
        skipped: 0,
        checkpointFailures: 0,
    });
});

Deno.test('missing configuration keeps a claimed email retryable without contacting the provider', async () => {
    const { gateway, events } = fakeGateway([claimedRow]);
    let providerCalls = 0;
    const result = await runFoundingSkipperEmailWorker(
        gateway,
        null,
        () => {
            providerCalls += 1;
            return Promise.resolve(new Response(null, { status: 200 }));
        },
        leaseToken,
    );

    assertEquals(providerCalls, 0);
    assertEquals(events.retry, [[claimedRow.job_id, leaseToken, 'email_not_configured', 300, false]]);
    assertEquals(result.retried, 1);
});

Deno.test('accepted email rechecks application and current lease immediately before Resend', async () => {
    const accepted = { ...claimedRow, message_kind: 'applicant_accepted_v1', application_status: 'accepted' };
    for (
        const [fenceResult, expected] of [
            ['cancel', 'cancelled'],
            ['lost', 'skipped'],
        ] as const
    ) {
        const { gateway, events } = fakeGateway([accepted], fenceResult);
        let providerCalls = 0;
        const result = await runFoundingSkipperEmailWorker(
            gateway,
            config,
            () => {
                providerCalls += 1;
                return Promise.resolve(new Response(null, { status: 200 }));
            },
            leaseToken,
        );
        assertEquals(providerCalls, 0);
        assertEquals(events.fence, [[accepted.job_id, accepted.application_id, leaseToken]]);
        if (expected === 'cancelled') {
            assertEquals(events.cancel, [[accepted.job_id, leaseToken, 'application_not_accepted']]);
            assertEquals(result.cancelled, 1);
        } else {
            assertEquals(events.cancel, []);
            assertEquals(result.skipped, 1);
        }
    }

    const { gateway, events } = fakeGateway([accepted], 'ready');
    const sequence: string[] = [];
    gateway.confirmAcceptedLease = async (...args) => {
        events.fence.push(args);
        sequence.push('fence');
        return 'ready';
    };
    await runFoundingSkipperEmailWorker(
        gateway,
        config,
        () => {
            sequence.push('provider');
            return Promise.resolve(
                new Response(JSON.stringify({ id: 'resend-provider-id' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        },
        leaseToken,
    );
    assertEquals(sequence, ['fence', 'provider']);
});

Deno.test('returned non-accepted status cancels before the database fence and provider call', async () => {
    const accepted = { ...claimedRow, message_kind: 'applicant_accepted_v1', application_status: 'rejected' };
    const { gateway, events } = fakeGateway([accepted]);
    let providerCalls = 0;
    await runFoundingSkipperEmailWorker(
        gateway,
        config,
        () => {
            providerCalls += 1;
            return Promise.resolve(new Response(null, { status: 200 }));
        },
        leaseToken,
    );
    assertEquals(events.fence, []);
    assertEquals(events.cancel, [[accepted.job_id, leaseToken, 'application_not_accepted']]);
    assertEquals(providerCalls, 0);
});

Deno.test('legacy consent permits operator notice but fails applicant email closed', async () => {
    const legacyOperator = {
        ...claimedRow,
        message_kind: 'operator_new_v1',
        consent_version: 'founding-skippers-v1',
    };
    const parsed = parseClaimedFoundingSkipperEmailJob(legacyOperator, leaseToken);
    assertEquals(parsed?.consentVersion, 'founding-skippers-v1');

    const legacyApplicant = {
        ...claimedRow,
        message_kind: 'applicant_received_v1',
        consent_version: 'founding-skippers-v1',
    };
    const { gateway, events } = fakeGateway([legacyApplicant]);
    let providerCalls = 0;
    const result = await runFoundingSkipperEmailWorker(
        gateway,
        config,
        () => {
            providerCalls += 1;
            return Promise.resolve(new Response(null, { status: 200 }));
        },
        leaseToken,
    );
    assertEquals(providerCalls, 0);
    assertEquals(events.fence, []);
    assertEquals(events.cancel, [[legacyApplicant.job_id, leaseToken, 'applicant_email_not_consented']]);
    assertEquals(result.cancelled, 1);
});

Deno.test('retryable and permanent provider failures checkpoint without PII', async () => {
    const unavailable = fakeGateway([claimedRow]);
    await runFoundingSkipperEmailWorker(
        unavailable.gateway,
        config,
        () => Promise.resolve(new Response('private provider body', { status: 503 })),
        leaseToken,
    );
    assertEquals(unavailable.events.retry, [[claimedRow.job_id, leaseToken, 'resend_unavailable', 30, false]]);

    const rejected = fakeGateway([claimedRow]);
    const result = await runFoundingSkipperEmailWorker(
        rejected.gateway,
        config,
        () => Promise.resolve(new Response('private provider body', { status: 400 })),
        leaseToken,
    );
    assertEquals(rejected.events.retry, [[claimedRow.job_id, leaseToken, 'resend_http_400', 0, true]]);
    assertEquals(result.dead, 1);
});

Deno.test('a stale lease during finish is reported as a checkpoint failure, never sent', async () => {
    const { gateway } = fakeGateway([claimedRow]);
    gateway.finish = () => Promise.reject(new Error('email_queue_finish_failed'));
    const result = await runFoundingSkipperEmailWorker(
        gateway,
        config,
        () =>
            Promise.resolve(
                new Response(JSON.stringify({ id: 'resend-provider-id' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        leaseToken,
    );
    assertEquals(result.sent, 0);
    assertEquals(result.checkpointFailures, 1);
});
