import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { type FeedbackEmailConfig } from './email.ts';
import {
    FEEDBACK_EMAIL_WORKER_BATCH_LIMIT,
    FEEDBACK_EMAIL_WORKER_LEASE_SECONDS,
    type FeedbackEmailQueueGateway,
    parseClaimedFeedbackEmailJob,
    requireAppliedFeedbackEmailCheckpoint,
    requireFeedbackEmailWorkerRequest,
    runFeedbackEmailWorker,
} from './worker.ts';

const leaseToken = '0198da8b-1ed2-4000-8000-000000000011';
const config: FeedbackEmailConfig = {
    apiKey: 'resend-test-key',
    alertTo: 'beta@thalassawx.com',
    alertFrom: 'Thalassa Beta <beta@thalassawx.com>',
    submitterFrom: 'Thalassa Feedback <beta@thalassawx.com>',
    replyTo: 'beta@thalassawx.com',
};
const claimedRow = {
    job_id: '0198da8b-1ed2-4000-8000-000000000010',
    lease_token: leaseToken,
    submission_id: '0198da8b-1ed2-4000-8000-000000000001',
    message_kind: 'operator_new_v1',
    attempts: 1,
    reference: 'FB-0198DA8B',
    kind: 'bug',
    name: 'Casey Skipper',
    email: 'casey@example.com',
    area: 'weather',
    title: 'Wind observation stays stale',
    details: 'The time updates but the wind value remains from the earlier observation.',
    impact: 'annoying',
    steps_to_reproduce: 'Open the Glass and pull to refresh.',
    expected_result: 'The time and wind update together.',
    actual_result: 'Only the time updates.',
    problem_to_solve: null,
    ideal_outcome: null,
    device: 'iPhone 17 Pro',
    app_version: '1.2.0',
    app_build: '42',
    app_platform: 'iOS',
    diagnostics: {
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0',
        screen: '402x874',
        viewport: '402x750',
        language: 'en-AU',
        online: true,
        currentPath: '/feedback',
    },
    source: 'direct',
    consent_version: 'product-feedback-v1',
    submission_status: 'new',
};

interface GatewayEvents {
    finish: Array<[string, string, string]>;
    retry: Array<[string, string, string, number, boolean]>;
    claimArgs?: [string, number, number];
}

function fakeGateway(rows: unknown[]): { gateway: FeedbackEmailQueueGateway; events: GatewayEvents } {
    const events: GatewayEvents = { finish: [], retry: [] };
    return {
        events,
        gateway: {
            claim(token, limit, leaseSeconds) {
                events.claimArgs = [token, limit, leaseSeconds];
                return Promise.resolve(rows);
            },
            finish(jobId, token, providerMessageId) {
                events.finish.push([jobId, token, providerMessageId]);
                return Promise.resolve();
            },
            retry(jobId, token, code, delay, terminal) {
                events.retry.push([jobId, token, code, delay, terminal]);
                return Promise.resolve();
            },
        },
    };
}

Deno.test('worker requires POST and an exact internal credential or verified service-role JWT', async () => {
    const serviceKey = 'service-role-test-key';
    const getFailure = requireFeedbackEmailWorkerRequest(
        new Request('https://example.test', { method: 'GET', headers: { Authorization: `Bearer ${serviceKey}` } }),
        serviceKey,
    );
    assertEquals(getFailure?.status, 405);

    const authFailure = requireFeedbackEmailWorkerRequest(
        new Request('https://example.test', { method: 'POST', headers: { Authorization: 'Bearer user-token' } }),
        serviceKey,
    );
    assertEquals(authFailure?.status, 401);
    assertEquals(
        requireFeedbackEmailWorkerRequest(
            new Request('https://example.test', {
                method: 'POST',
                headers: { Authorization: 'Bearer public-jwt', 'X-Thalassa-Worker-Key': serviceKey },
            }),
            serviceKey,
        ),
        null,
    );

    const encode = (value: unknown) =>
        btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const legacyJwt = `${encode({ alg: 'HS256' })}.${encode({ role: 'service_role' })}.gateway-signature`;
    assertEquals(
        requireFeedbackEmailWorkerRequest(
            new Request('https://example.test', {
                method: 'POST',
                headers: { Authorization: `Bearer ${legacyJwt}` },
            }),
            'different-modern-key',
        ),
        null,
    );

    await getFailure?.body?.cancel();
    await authFailure?.body?.cancel();
});

Deno.test('queue checkpoints fail closed on stale leases and database errors', () => {
    requireAppliedFeedbackEmailCheckpoint(true, null, 'finish_failed');
    assertThrows(() => requireAppliedFeedbackEmailCheckpoint(false, null, 'checkpoint_failed'));
    assertThrows(() =>
        requireAppliedFeedbackEmailCheckpoint(null, { message: 'database failure' }, 'checkpoint_failed')
    );
});

Deno.test('claimed rows strictly validate lease, headers and diagnostics path', () => {
    assert(parseClaimedFeedbackEmailJob(claimedRow, leaseToken));
    assertEquals(parseClaimedFeedbackEmailJob(claimedRow, crypto.randomUUID()), null);
    assertEquals(
        parseClaimedFeedbackEmailJob(
            { ...claimedRow, email: 'casey@example.com\r\nBcc: attacker@example.com' },
            leaseToken,
        ),
        null,
    );
    assertEquals(
        parseClaimedFeedbackEmailJob(
            { ...claimedRow, diagnostics: { ...claimedRow.diagnostics, currentPath: '/plan?private=yes' } },
            leaseToken,
        ),
        null,
    );
});

Deno.test('successful delivery claims a bounded batch and checkpoints the provider id', async () => {
    const { gateway, events } = fakeGateway([claimedRow]);
    const result = await runFeedbackEmailWorker(
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

    assertEquals(events.claimArgs, [
        leaseToken,
        FEEDBACK_EMAIL_WORKER_BATCH_LIMIT,
        FEEDBACK_EMAIL_WORKER_LEASE_SECONDS,
    ]);
    assertEquals(events.finish, [[claimedRow.job_id, leaseToken, 'resend-provider-id']]);
    assertEquals(result, { claimed: 1, sent: 1, retried: 0, dead: 0, checkpointFailures: 0 });
});

Deno.test('provider failures checkpoint bounded codes without retaining provider content', async () => {
    const unavailable = fakeGateway([claimedRow]);
    await runFeedbackEmailWorker(
        unavailable.gateway,
        config,
        () => Promise.resolve(new Response('private provider body', { status: 503 })),
        leaseToken,
    );
    assertEquals(unavailable.events.retry, [[claimedRow.job_id, leaseToken, 'resend_unavailable', 30, false]]);

    const rejected = fakeGateway([claimedRow]);
    const result = await runFeedbackEmailWorker(
        rejected.gateway,
        config,
        () => Promise.resolve(new Response('private provider body', { status: 400 })),
        leaseToken,
    );
    assertEquals(rejected.events.retry, [[claimedRow.job_id, leaseToken, 'resend_http_400', 0, true]]);
    assertEquals(result.dead, 1);
});

Deno.test('invalid persisted payload is dead-lettered without contacting Resend', async () => {
    const { gateway, events } = fakeGateway([{ ...claimedRow, diagnostics: { secret: 'bad' } }]);
    let providerCalls = 0;
    const result = await runFeedbackEmailWorker(
        gateway,
        config,
        () => {
            providerCalls += 1;
            return Promise.resolve(new Response(null, { status: 200 }));
        },
        leaseToken,
    );
    assertEquals(providerCalls, 0);
    assertEquals(events.retry, [[claimedRow.job_id, leaseToken, 'invalid_job_payload', 0, true]]);
    assertEquals(result.dead, 1);
});
