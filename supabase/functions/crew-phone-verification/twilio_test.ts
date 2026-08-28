import {
    checkVerification,
    classifyTwilioProviderError,
    lookupPhone,
    startVerification,
    type TwilioConfig,
    TwilioProviderError,
} from './twilio.ts';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const config: TwilioConfig = {
    apiKeySid: `SK${'a'.repeat(32)}`,
    apiKeySecret: 'test-api-secret-that-is-not-real',
    verifyServiceSid: `VA${'b'.repeat(32)}`,
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

Deno.test('Twilio Lookup canonicalizes national input and uses authenticated direct fetch', async () => {
    let requestedUrl = '';
    let requestedAuth = '';
    const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedAuth = new Headers(init?.headers).get('authorization') ?? '';
        return Promise.resolve(json({ valid: true, phone_number: '+61412345678' }));
    }) as typeof fetch;

    const result = await lookupPhone('0412 345 678', 'AU', config, fetcher);
    assert(result.e164 === '+61412345678', 'Lookup canonical result should be returned');
    assert(requestedUrl.startsWith('https://lookups.twilio.com/v2/PhoneNumbers/'), 'Lookup host/path mismatch');
    assert(requestedUrl.includes('CountryCode=AU'), 'national input country hint missing');
    assert(requestedAuth.startsWith('Basic '), 'Twilio API key must stay in Basic auth');
    assert(!requestedUrl.includes(config.apiKeySecret), 'secret must never enter the URL');
});

Deno.test('Twilio Verify start sends SMS with pseudonymous service-rate-limit keys', async () => {
    let body = '';
    const fetcher = ((_input: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body ?? '');
        return Promise.resolve(json({ sid: `VE${'c'.repeat(32)}`, status: 'pending' }));
    }) as typeof fetch;

    const digest = 'd'.repeat(64);
    const result = await startVerification(
        '+61412345678',
        { crew_user: digest, crew_phone: digest, crew_ip: digest },
        config,
        fetcher,
    );
    const form = new URLSearchParams(body);
    assert(result.status === 'pending', 'only pending starts should be accepted');
    assert(form.get('To') === '+61412345678', 'provider must receive canonical E.164');
    assert(form.get('Channel') === 'sms', 'beta channel must stay SMS-only');
    assert(
        form.get('RateLimits[crew_user]') === digest,
        'user rate key missing',
    );
    assert(
        form.get('RateLimits[crew_phone]') === digest,
        'phone rate key missing',
    );
    assert(
        form.get('RateLimits[crew_ip]') === digest,
        'IP rate key missing',
    );
});

Deno.test('Twilio Verify checks by verification SID rather than resending the phone number', async () => {
    let body = '';
    const sid = `VE${'e'.repeat(32)}`;
    const fetcher = ((_input: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body ?? '');
        return Promise.resolve(json({ status: 'approved' }));
    }) as typeof fetch;

    const result = await checkVerification(sid, '123456', config, fetcher);
    const form = new URLSearchParams(body);
    assert(result.status === 'approved', 'approved status should pass through');
    assert(form.get('VerificationSid') === sid, 'check must use the stored verification SID');
    assert(form.get('Code') === '123456', 'code missing');
    assert(!form.has('To'), 'check must not require retaining or resubmitting the phone number');
});

Deno.test('Twilio errors retain only bounded numeric diagnostics', async () => {
    const fetcher =
        (() => Promise.resolve(json({ code: 60410, message: 'attacker/provider detail' }, 400))) as typeof fetch;
    try {
        await lookupPhone('0412 345 678', 'AU', config, fetcher);
        throw new Error('expected provider error');
    } catch (error) {
        assert(error instanceof TwilioProviderError, 'provider failure should use the safe error type');
        assert(error.providerCode === 60410, 'bounded numeric provider code should remain available');
        assert(!error.message.includes('attacker/provider detail'), 'provider response text must not escape');
    }
});

Deno.test('Twilio Verify public failures avoid futile retries without exposing provider text', () => {
    for (const providerCode of [60205, 60238, 60412]) {
        const error = new TwilioProviderError('start', 400, providerCode);
        assert(
            classifyTwilioProviderError(error) === 'sms_unavailable',
            `Verify ${providerCode} should be a stable SMS-unavailable result`,
        );
        assert(error.message === 'Twilio request failed', 'provider text must not be retained');
    }
    assert(
        classifyTwilioProviderError(new TwilioProviderError('start', 400, 60245)) === 'rate_limited',
        'Verify messaging-limit error should be a public rate limit',
    );
    assert(
        classifyTwilioProviderError(new TwilioProviderError('lookup', 429, null)) === 'rate_limited',
        'Lookup HTTP rate limit must not be misclassified as an invalid number',
    );
});
