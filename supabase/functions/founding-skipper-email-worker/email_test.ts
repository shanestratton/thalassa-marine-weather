import {
    classifyResendFailure,
    deliverFoundingSkipperEmail,
    escapeEmailHtml,
    escapeEmailText,
    type FoundingSkipperEmailConfig,
    type FoundingSkipperEmailJob,
    readFoundingSkipperEmailConfig,
    renderFoundingSkipperEmail,
} from './email.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const config: FoundingSkipperEmailConfig = {
    apiKey: 'resend-test-key',
    alertTo: 'beta@thalassawx.com',
    alertFrom: 'Thalassa Beta <beta@thalassawx.com>',
    applicantFrom: 'Thalassa Founding Skippers <beta@thalassawx.com>',
    replyTo: 'beta@thalassawx.com',
};

const job: FoundingSkipperEmailJob = {
    jobId: '0198da8b-1ed2-4000-8000-000000000010',
    leaseToken: '0198da8b-1ed2-4000-8000-000000000011',
    applicationId: '0198da8b-1ed2-4000-8000-000000000001',
    messageKind: 'operator_new_v1',
    attempts: 1,
    name: 'Casey Skipper',
    email: 'casey@example.com',
    boatType: 'sail_monohull',
    homeWaters: 'Moreton Bay',
    appleDevice: 'iphone_and_ipad',
    boatingFrequency: 'weekly_plus',
    interests: ['marine_weather', 'anchor_watch'],
    notes: 'Private answer about the boat.',
    source: 'personal-email',
    consentVersion: 'founding-skippers-v2',
    applicationStatus: 'new',
};

Deno.test('email configuration is server-only, complete, and rejects header injection', () => {
    const configured = readFoundingSkipperEmailConfig((name) =>
        ({
            RESEND_API_KEY: config.apiKey,
            FOUNDING_SKIPPER_ALERT_TO: config.alertTo,
            FOUNDING_SKIPPER_ALERT_FROM: config.alertFrom,
            FOUNDING_SKIPPER_APPLICANT_FROM: config.applicantFrom,
            FOUNDING_SKIPPER_REPLY_TO: config.replyTo,
        })[name]
    );
    assertEquals(configured, config);
    assertEquals(readFoundingSkipperEmailConfig(() => undefined), null);

    for (
        const attacked of [
            'RESEND_API_KEY',
            'FOUNDING_SKIPPER_ALERT_TO',
            'FOUNDING_SKIPPER_ALERT_FROM',
            'FOUNDING_SKIPPER_APPLICANT_FROM',
            'FOUNDING_SKIPPER_REPLY_TO',
        ]
    ) {
        const result = readFoundingSkipperEmailConfig((name) => {
            const values: Record<string, string> = {
                RESEND_API_KEY: config.apiKey,
                FOUNDING_SKIPPER_ALERT_TO: config.alertTo,
                FOUNDING_SKIPPER_ALERT_FROM: config.alertFrom,
                FOUNDING_SKIPPER_APPLICANT_FROM: config.applicantFrom,
                FOUNDING_SKIPPER_REPLY_TO: config.replyTo,
            };
            return name === attacked ? `${values[name]}\r\nBcc: attacker@example.com` : values[name];
        });
        assertEquals(result, null);
    }
});

Deno.test('renderers escape untrusted content and applicant messages do not echo application answers', () => {
    assertEquals(
        escapeEmailHtml(`<tag title="x">Tom & 'Sal'</tag>`),
        '&lt;tag title=&quot;x&quot;&gt;Tom &amp; &#39;Sal&#39;&lt;/tag&gt;',
    );
    assertEquals(escapeEmailText('first\r\nsecond\u0000third'), 'first\nsecond�third');

    const operator = renderFoundingSkipperEmail(
        { ...job, name: '<img src=x onerror=alert(1)>', notes: 'First\r\nSecond & <third>\u0000' },
        config,
    );
    assert(!operator.html.includes('<img src=x'), 'Raw applicant HTML reached operator HTML');
    assert(operator.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert(operator.html.includes('Second &amp; &lt;third&gt;�'));
    assert(operator.text.includes('Moreton Bay'));
    assert(operator.text.includes('Private answer') === false, 'Fixture override should be rendered instead');

    for (const messageKind of ['applicant_received_v1', 'applicant_accepted_v1'] as const) {
        const applicant = renderFoundingSkipperEmail({ ...job, messageKind, applicationStatus: 'accepted' }, config);
        for (
            const sensitive of [
                job.email,
                job.homeWaters,
                job.boatType,
                job.appleDevice,
                job.boatingFrequency,
                job.notes!,
                job.source,
                job.applicationId,
            ]
        ) {
            assert(!applicant.text.includes(sensitive), `Applicant text echoed ${sensitive}`);
            assert(!applicant.html.includes(sensitive), `Applicant HTML echoed ${sensitive}`);
        }
    }

    const received = renderFoundingSkipperEmail({ ...job, messageKind: 'applicant_received_v1' }, config);
    assert(received.text.includes('not an acceptance just yet'));
    const accepted = renderFoundingSkipperEmail(
        { ...job, messageKind: 'applicant_accepted_v1', applicationStatus: 'accepted' },
        config,
    );
    assert(accepted.text.includes('Welcome to the Thalassa beta program'));
    assert(accepted.text.includes('candid feedback'));
    assert(accepted.text.includes('official marine forecasts'));
    assert(accepted.text.includes('current approved charts'));
    assert(accepted.text.includes('emergency services'));
    assert(accepted.text.includes('your own judgement'));
});

Deno.test('Resend requests use isolated recipients and stable, versioned idempotency keys', async () => {
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

    assertEquals(await deliverFoundingSkipperEmail(job, config, fetcher), {
        outcome: 'sent',
        providerMessageId: 'resend-message-1',
    });
    assertEquals(
        await deliverFoundingSkipperEmail({ ...job, messageKind: 'applicant_received_v1' }, config, fetcher),
        { outcome: 'sent', providerMessageId: 'resend-message-2' },
    );

    const operatorHeaders = new Headers(captures[0].init?.headers);
    const operatorPayload = JSON.parse(String(captures[0].init?.body)) as Record<string, unknown>;
    assertEquals(captures[0].input, 'https://api.resend.com/emails');
    assertEquals(captures[0].init?.method, 'POST');
    assertEquals(operatorHeaders.get('authorization'), 'Bearer resend-test-key');
    assertEquals(operatorHeaders.get('user-agent'), 'thalassa-founding-skippers/2.0');
    assertEquals(
        operatorHeaders.get('idempotency-key'),
        'founding-skipper/0198da8b-1ed2-4000-8000-000000000001/operator_new_v1/v1',
    );
    assertEquals(operatorPayload.from, config.alertFrom);
    assertEquals(operatorPayload.to, [config.alertTo]);
    assertEquals(operatorPayload.reply_to, job.email);
    assertEquals(operatorPayload.cc, undefined);
    assertEquals(operatorPayload.bcc, undefined);
    assert(!(operatorPayload.to as string[]).includes(job.email));

    const applicantHeaders = new Headers(captures[1].init?.headers);
    const applicantPayload = JSON.parse(String(captures[1].init?.body)) as Record<string, unknown>;
    assertEquals(
        applicantHeaders.get('idempotency-key'),
        'founding-skipper/0198da8b-1ed2-4000-8000-000000000001/applicant_received_v1/v1',
    );
    assertEquals(applicantPayload.from, config.applicantFrom);
    assertEquals(applicantPayload.to, [job.email]);
    assertEquals(applicantPayload.reply_to, config.replyTo);
    assertEquals(applicantPayload.cc, undefined);
    assertEquals(applicantPayload.bcc, undefined);
    assert(!(applicantPayload.to as string[]).includes(config.alertTo));
});

Deno.test('invalid persisted recipient headers are terminal and never reach Resend', async () => {
    let calls = 0;
    const result = await deliverFoundingSkipperEmail(
        { ...job, email: 'casey@example.com\r\nBcc: attacker@example.com' },
        config,
        () => {
            calls += 1;
            return Promise.resolve(new Response(null, { status: 200 }));
        },
    );
    assertEquals(result, { outcome: 'dead', errorCode: 'invalid_email_headers' });
    assertEquals(calls, 0);
});

Deno.test('retry classification distinguishes network, rate limits, provider outages, and permanent 4xx', async () => {
    assertEquals(classifyResendFailure(422, 1), { outcome: 'dead', errorCode: 'resend_http_422' });
    assertEquals(classifyResendFailure(429, 1, '120'), {
        outcome: 'retry',
        errorCode: 'resend_rate_limited',
        retryAfterSeconds: 120,
        terminal: false,
    });
    assertEquals(classifyResendFailure(503, 20), {
        outcome: 'retry',
        errorCode: 'resend_unavailable',
        retryAfterSeconds: 3600,
        terminal: true,
    });

    assertEquals(await deliverFoundingSkipperEmail(job, null), {
        outcome: 'retry',
        errorCode: 'email_not_configured',
        retryAfterSeconds: 300,
        terminal: false,
    });
    assertEquals(
        await deliverFoundingSkipperEmail(job, config, () => Promise.reject(new Error('must never be logged'))),
        {
            outcome: 'retry',
            errorCode: 'resend_network_error',
            retryAfterSeconds: 30,
            terminal: false,
        },
    );
});
