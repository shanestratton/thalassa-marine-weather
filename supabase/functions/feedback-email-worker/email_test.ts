import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
    classifyFeedbackResendFailure,
    deliverFeedbackEmail,
    escapeFeedbackEmailHtml,
    escapeFeedbackEmailText,
    type FeedbackEmailConfig,
    type FeedbackEmailJob,
    readFeedbackEmailConfig,
    renderFeedbackEmail,
} from './email.ts';

const config: FeedbackEmailConfig = {
    apiKey: 'resend-test-key',
    alertTo: 'beta@thalassawx.com',
    alertFrom: 'Thalassa Beta <beta@thalassawx.com>',
    submitterFrom: 'Thalassa Feedback <beta@thalassawx.com>',
    replyTo: 'beta@thalassawx.com',
};

const job: FeedbackEmailJob = {
    jobId: '0198da8b-1ed2-4000-8000-000000000010',
    leaseToken: '0198da8b-1ed2-4000-8000-000000000011',
    submissionId: '0198da8b-1ed2-4000-8000-000000000001',
    messageKind: 'operator_new_v1',
    attempts: 1,
    reference: 'FB-0198DA8B',
    kind: 'bug',
    name: 'Casey Skipper',
    email: 'casey@example.com',
    area: 'weather',
    title: 'Wind observation stays stale',
    details: 'The time updates but the wind value remains from the earlier observation.',
    impact: 'annoying',
    stepsToReproduce: 'Open the Glass and pull to refresh.',
    expectedResult: 'The time and wind value update together.',
    actualResult: 'Only the time updates.',
    problemToSolve: null,
    idealOutcome: null,
    device: 'iPhone 17 Pro',
    appVersion: '1.2.0',
    appBuild: '42',
    appPlatform: 'iOS',
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
    consentVersion: 'product-feedback-v1',
    submissionStatus: 'new',
};

Deno.test('feedback email config reuses the existing server secrets and rejects header injection', () => {
    const configured = readFeedbackEmailConfig((name) =>
        ({
            RESEND_API_KEY: config.apiKey,
            FOUNDING_SKIPPER_ALERT_TO: config.alertTo,
            FOUNDING_SKIPPER_ALERT_FROM: config.alertFrom,
            FOUNDING_SKIPPER_APPLICANT_FROM: 'Thalassa Founding Skippers <beta@thalassawx.com>',
            FOUNDING_SKIPPER_REPLY_TO: config.replyTo,
        })[name]
    );
    assertEquals(configured, config);
    assertEquals(readFeedbackEmailConfig(() => undefined), null);
    assertEquals(
        readFeedbackEmailConfig((name) =>
            name === 'FOUNDING_SKIPPER_ALERT_TO' ? 'beta@thalassawx.com\r\nBcc: attacker@example.com' : ({
                RESEND_API_KEY: config.apiKey,
                FOUNDING_SKIPPER_ALERT_FROM: config.alertFrom,
                FOUNDING_SKIPPER_APPLICANT_FROM: 'Thalassa Founding Skippers <beta@thalassawx.com>',
                FOUNDING_SKIPPER_REPLY_TO: config.replyTo,
            })[name]
        ),
        null,
    );
});

Deno.test('operator rendering escapes every untrusted field', () => {
    assertEquals(
        escapeFeedbackEmailHtml(`<tag title="x">Tom & 'Sal'</tag>`),
        '&lt;tag title=&quot;x&quot;&gt;Tom &amp; &#39;Sal&#39;&lt;/tag&gt;',
    );
    assertEquals(escapeFeedbackEmailText('first\r\nsecond\u0000third'), 'first\nsecond�third');

    const rendered = renderFeedbackEmail(
        {
            ...job,
            name: '<img src=x onerror=alert(1)>',
            details: 'First\nSecond & <third>\u0000',
            diagnostics: { ...job.diagnostics!, userAgent: '<script>bad()</script>' },
        },
        config,
    );
    assert(!rendered.html.includes('<img src=x'));
    assert(!rendered.html.includes('<script>bad()'));
    assert(rendered.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert(rendered.html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
    assert(rendered.text.includes('Version: 1.2.0'));
    assert(rendered.text.includes('Build: 42'));
    assert(rendered.text.includes('Platform: iOS'));
});

Deno.test('submitter receipt contains its reference but does not echo report or diagnostics', () => {
    const rendered = renderFeedbackEmail({ ...job, messageKind: 'submitter_received_v1' }, config);
    assert(rendered.text.includes(job.reference));
    assert(rendered.text.includes('screenshot or short screen recording'));
    assert(rendered.text.includes('reply to this email and attach it'));
    for (
        const privateValue of [
            job.details,
            job.stepsToReproduce!,
            job.actualResult!,
            job.appVersion!,
            job.appBuild!,
            job.appPlatform!,
            job.diagnostics!.userAgent,
        ]
    ) {
        assert(!rendered.text.includes(privateValue));
        assert(!rendered.html.includes(privateValue));
    }
});

Deno.test('Resend delivery isolates recipients and uses a stable versioned idempotency key', async () => {
    const captures: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        captures.push({ input, init });
        return Promise.resolve(
            new Response(JSON.stringify({ id: `resend-message-${captures.length}` }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
    };

    assertEquals(await deliverFeedbackEmail(job, config, fetcher), {
        outcome: 'sent',
        providerMessageId: 'resend-message-1',
    });
    assertEquals(
        await deliverFeedbackEmail({ ...job, messageKind: 'submitter_received_v1' }, config, fetcher),
        { outcome: 'sent', providerMessageId: 'resend-message-2' },
    );

    const operatorHeaders = new Headers(captures[0].init?.headers);
    const operatorPayload = JSON.parse(String(captures[0].init?.body)) as Record<string, unknown>;
    assertEquals(captures[0].input, 'https://api.resend.com/emails');
    assertEquals(
        operatorHeaders.get('idempotency-key'),
        'product-feedback/0198da8b-1ed2-4000-8000-000000000001/operator_new_v1/v1',
    );
    assertEquals(operatorPayload.to, [config.alertTo]);
    assertEquals(operatorPayload.reply_to, job.email);
    assertEquals(operatorPayload.cc, undefined);
    assertEquals(operatorPayload.bcc, undefined);

    const submitterPayload = JSON.parse(String(captures[1].init?.body)) as Record<string, unknown>;
    assertEquals(submitterPayload.to, [job.email]);
    assertEquals(submitterPayload.reply_to, config.replyTo);
    assertEquals(submitterPayload.cc, undefined);
    assertEquals(submitterPayload.bcc, undefined);
});

Deno.test('retry classification retains only bounded machine errors', async () => {
    assertEquals(classifyFeedbackResendFailure(422, 1), { outcome: 'dead', errorCode: 'resend_http_422' });
    assertEquals(classifyFeedbackResendFailure(429, 1, '120'), {
        outcome: 'retry',
        errorCode: 'resend_rate_limited',
        retryAfterSeconds: 120,
        terminal: false,
    });
    assertEquals(classifyFeedbackResendFailure(503, 20), {
        outcome: 'retry',
        errorCode: 'resend_unavailable',
        retryAfterSeconds: 3600,
        terminal: true,
    });
    assertEquals(await deliverFeedbackEmail(job, null), {
        outcome: 'retry',
        errorCode: 'email_not_configured',
        retryAfterSeconds: 300,
        terminal: false,
    });
});
