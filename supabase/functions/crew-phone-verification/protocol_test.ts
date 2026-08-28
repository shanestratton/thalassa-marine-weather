import {
    clientAddress,
    isE164,
    keyedFingerprint,
    parseAction,
    parsePhoneStart,
    parseVerificationCode,
} from './protocol.ts';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

Deno.test('phone protocol accepts bounded local/international input but only canonical E.164 output', () => {
    const local = parsePhoneStart(' 0412 345 678 ', 'au');
    assert(local?.phone === '0412 345 678', 'local phone should be trimmed');
    assert(local.countryCode === 'AU', 'country should be canonical ISO-2');
    assert(parsePhoneStart('+61 412 345 678', 'AU') !== null, 'international input should be accepted for Lookup');
    assert(parsePhoneStart('555 1234', 'VU') !== null, 'valid short Vanuatu local format should reach Lookup');
    assert(parsePhoneStart('5551234', 'VU') !== null, 'plain seven-digit Vanuatu number should reach Lookup');
    assert(parsePhoneStart('1234', 'VU') === null, 'implausibly short input must still fail locally');
    assert(parsePhoneStart('0412-CALL-ME', 'AU') === null, 'letters must be rejected');
    assert(parsePhoneStart('0412345678', 'AUS') === null, 'non ISO-2 country must be rejected');
    assert(isE164('+61412345678'), 'canonical E.164 should pass');
    assert(!isE164('0412345678'), 'local format is not canonical storage/provider output');
});

Deno.test('phone protocol permits only the fixed actions and a six-digit code', () => {
    assert(parseAction('status') === 'status', 'status action missing');
    assert(parseAction('start') === 'start', 'start action missing');
    assert(parseAction('check') === 'check', 'check action missing');
    assert(parseAction('revoke') === null, 'unknown action must fail closed');
    assert(parseVerificationCode(' 123456 ') === '123456', 'six-digit code should trim');
    assert(parseVerificationCode('12345') === null, 'short code must be rejected');
    assert(parseVerificationCode('12 3456') === null, 'formatted code must be rejected');
});

Deno.test('phone fingerprints are deterministic, domain separated, and never echo their input', async () => {
    const secret = 'test-secret-with-at-least-thirty-two-bytes';
    const phone = await keyedFingerprint(secret, 'crew-phone-number', '+61412345678');
    const user = await keyedFingerprint(secret, 'crew-phone-user', '+61412345678');
    assert(/^[0-9a-f]{64}$/.test(phone), 'fingerprint must be a SHA-256 HMAC hex digest');
    assert(phone !== user, 'domains must not be linkable by equal digest');
    assert(!phone.includes('412345678'), 'fingerprint must not echo the source');
    assert(
        phone === await keyedFingerprint(secret, 'crew-phone-number', '+61412345678'),
        'same version/domain/value must remain stable',
    );
});

Deno.test('client address accepts only a hosted trusted address header', () => {
    const forwarded = new Request('https://example.test', {
        headers: { 'x-forwarded-for': '198.51.100.4, 203.0.113.9' },
    });
    assert(clientAddress(forwarded) === null, 'caller-controlled forwarding chain must fail closed');
    const cloudflare = new Request('https://example.test', {
        headers: {
            'cf-connecting-ip': '192.0.2.5',
            'x-forwarded-for': '198.51.100.4, 203.0.113.9',
        },
    });
    assert(clientAddress(cloudflare) === '192.0.2.5', 'Cloudflare address should take precedence');
    const hosted = new Request('https://example.test', {
        headers: { 'x-real-ip': '203.0.113.9' },
    });
    assert(clientAddress(hosted) === '203.0.113.9', 'hosted real address should be accepted');
});
