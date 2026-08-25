import {
    escapeAlertHtml,
    escapeAlertText,
    type FoundingSkipperAlertApplication,
    type FoundingSkipperAlertConfig,
    readFoundingSkipperAlertConfig,
    renderFoundingSkipperAlert,
    sendFoundingSkipperAlert,
} from './alert.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const application: FoundingSkipperAlertApplication = {
    id: '0198da8b-1ed2-4000-8000-000000000001',
    name: 'Casey Skipper',
    email: 'casey@example.com',
    boatType: 'sail_monohull',
    homeWaters: 'Moreton Bay',
    appleDevice: 'iphone_and_ipad',
    boatingFrequency: 'weekly_plus',
    interests: ['marine_weather', 'anchor_watch'],
    notes: 'Straight-up feedback.',
    source: 'personal-email',
};

const config: FoundingSkipperAlertConfig = {
    apiKey: 'test-resend-key',
    from: 'Thalassa <alerts@notify.example.com>',
    to: 'shane@example.com',
};

Deno.test('alert configuration is server-only and fails closed when incomplete or header-like', () => {
    const configured = readFoundingSkipperAlertConfig((name) =>
        ({
            RESEND_API_KEY: 'test-resend-key',
            FOUNDING_SKIPPER_ALERT_FROM: 'Thalassa <alerts@notify.example.com>',
            FOUNDING_SKIPPER_ALERT_TO: 'shane@example.com',
        })[name]
    );
    assertEquals(configured, config);

    assertEquals(readFoundingSkipperAlertConfig(() => undefined), null);
    assertEquals(
        readFoundingSkipperAlertConfig((name) =>
            ({
                RESEND_API_KEY: 'test-resend-key',
                FOUNDING_SKIPPER_ALERT_FROM: 'Thalassa <alerts@notify.example.com>',
                FOUNDING_SKIPPER_ALERT_TO: 'shane@example.com\r\nBcc: attacker@example.com',
            })[name]
        ),
        null,
    );
});

Deno.test('alert renderer escapes HTML and normalises plain-text controls', () => {
    assertEquals(
        escapeAlertHtml(`<tag title="x">Tom & 'Sal'</tag>`),
        '&lt;tag title=&quot;x&quot;&gt;Tom &amp; &#39;Sal&#39;&lt;/tag&gt;',
    );
    assertEquals(escapeAlertText('first\r\nsecond\u0000third'), 'first\nsecond�third');

    const rendered = renderFoundingSkipperAlert({
        ...application,
        name: '<img src=x onerror=alert(1)>',
        notes: 'First line\r\nSecond & <third>\u0000',
    });

    assert(!rendered.html.includes('<img src=x'), 'Raw applicant HTML must not reach the HTML part');
    assert(rendered.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert(rendered.html.includes('Second &amp; &lt;third&gt;�'));
    assert(!rendered.text.includes('\r'));
    assert(!rendered.text.includes('\u0000'));
    assert(rendered.text.includes('Notes: First line\n  Second & <third>�'));
    assert(rendered.text.includes("Review and update the application in Thalassa's private Admin Panel."));
    assert(rendered.html.includes('Review and update the application in Thalassa&#39;s private Admin Panel.'));
    assert(!rendered.text.includes('Supabase'));
    assert(!rendered.html.includes('Supabase'));
});

Deno.test('Resend request uses fixed REST endpoint, bearer auth, user agent, and application idempotency key', async () => {
    let capturedInput: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const result = await sendFoundingSkipperAlert(application, config, (input, init) => {
        capturedInput = input;
        capturedInit = init;
        return Promise.resolve(new Response(JSON.stringify({ id: 'provider-message-id' }), { status: 202 }));
    });

    assertEquals(result, { status: 'sent' });
    assertEquals(capturedInput, 'https://api.resend.com/emails');
    assertEquals(capturedInit?.method, 'POST');

    const headers = new Headers(capturedInit?.headers);
    assertEquals(headers.get('authorization'), 'Bearer test-resend-key');
    assertEquals(headers.get('content-type'), 'application/json');
    assertEquals(headers.get('user-agent'), 'thalassa-founding-skippers/1.0');
    assertEquals(
        headers.get('idempotency-key'),
        'founding-skipper-application/0198da8b-1ed2-4000-8000-000000000001',
    );

    const payload = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assertEquals(payload.from, config.from);
    assertEquals(payload.to, [config.to]);
    assertEquals(payload.reply_to, application.email);
    assertEquals(payload.cc, undefined);
    assertEquals(payload.bcc, undefined);
    assert(!(payload.to as string[]).includes(application.email), 'The applicant must never be an alert recipient');
    assertEquals(payload.subject, 'New Founding Skipper application');
    assert(typeof payload.html === 'string' && payload.html.includes('Casey Skipper'));
    assert(typeof payload.text === 'string' && payload.text.includes('Casey Skipper'));
});

Deno.test('missing configuration and duplicate-invalid ids skip delivery without calling the provider', async () => {
    let calls = 0;
    const fetcher = (): Promise<Response> => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 202 }));
    };

    assertEquals(await sendFoundingSkipperAlert(application, null, fetcher), {
        status: 'skipped',
        reason: 'not_configured',
    });
    assertEquals(await sendFoundingSkipperAlert({ ...application, id: 'not-a-uuid' }, config, fetcher), {
        status: 'skipped',
        reason: 'invalid_application_id',
    });
    assertEquals(calls, 0);
});

Deno.test('an invalid applicant address is never promoted into a recipient or Reply-To header', async () => {
    let payload: Record<string, unknown> | undefined;
    const result = await sendFoundingSkipperAlert(
        { ...application, email: 'applicant@example.com\r\nBcc: attacker@example.com' },
        config,
        (_input, init) => {
            payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Promise.resolve(new Response(null, { status: 202 }));
        },
    );

    assertEquals(result, { status: 'sent' });
    assertEquals(payload?.to, [config.to]);
    assertEquals(payload?.reply_to, undefined);
    assertEquals(payload?.cc, undefined);
    assertEquals(payload?.bcc, undefined);
});

Deno.test('provider and network failures are bounded non-throwing outcomes', async () => {
    assertEquals(
        await sendFoundingSkipperAlert(application, config, () => Promise.resolve(new Response(null, { status: 503 }))),
        { status: 'failed', reason: 'provider_rejected', providerStatus: 503 },
    );
    assertEquals(
        await sendFoundingSkipperAlert(
            application,
            config,
            () => Promise.reject(new Error('provider unavailable with applicant data that must never be logged')),
        ),
        { status: 'failed', reason: 'network_error' },
    );
});
