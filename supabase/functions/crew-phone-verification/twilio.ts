import { readResponseJsonObjectLimited } from '../_shared/http-security.ts';
import { isE164 } from './protocol.ts';

const API_KEY_SID = /^SK[0-9A-Fa-f]{32}$/;
const VERIFY_SERVICE_SID = /^VA[0-9A-Fa-f]{32}$/;
const VERIFICATION_SID = /^VE[0-9A-Fa-f]{32}$/;

export interface TwilioConfig {
    apiKeySid: string;
    apiKeySecret: string;
    verifyServiceSid: string;
}

export interface LookupResult {
    e164: string;
}

export interface StartVerificationResult {
    sid: string;
    status: 'pending';
}

export type VerificationStatus =
    | 'pending'
    | 'approved'
    | 'canceled'
    | 'max_attempts_reached'
    | 'deleted'
    | 'failed'
    | 'expired';

export interface CheckVerificationResult {
    status: VerificationStatus;
}

export class TwilioProviderError extends Error {
    constructor(
        readonly operation: 'lookup' | 'start' | 'check',
        readonly httpStatus: number,
        readonly providerCode: number | null,
    ) {
        super('Twilio request failed');
        this.name = 'TwilioProviderError';
    }
}

export type TwilioPublicFailure =
    | 'phone_invalid'
    | 'code_expired'
    | 'rate_limited'
    | 'sms_unavailable'
    | 'unavailable';

export function classifyTwilioProviderError(
    error: Pick<TwilioProviderError, 'operation' | 'httpStatus' | 'providerCode'>,
): TwilioPublicFailure {
    if (error.operation === 'check' && (error.httpStatus === 404 || error.providerCode === 60202)) {
        return 'code_expired';
    }
    if (error.httpStatus === 429 || error.providerCode === 60203 || error.providerCode === 60245) {
        return 'rate_limited';
    }
    if (
        error.providerCode === 60205 ||
        error.providerCode === 60238 ||
        error.providerCode === 60250 ||
        error.providerCode === 60410 ||
        error.providerCode === 60412 ||
        error.providerCode === 60605
    ) {
        return 'sms_unavailable';
    }
    if (error.operation === 'lookup' && error.httpStatus >= 400 && error.httpStatus < 500) {
        return 'phone_invalid';
    }
    return 'unavailable';
}

export function readTwilioConfig(env: { get(name: string): string | undefined }): TwilioConfig | null {
    const apiKeySid = env.get('TWILIO_API_KEY_SID') ?? env.get('TWILIO_API_KEY');
    const apiKeySecret = env.get('TWILIO_API_KEY_SECRET') ?? env.get('TWILIO_API_SECRET');
    const verifyServiceSid = env.get('TWILIO_VERIFY_SERVICE_SID');
    if (
        !apiKeySid ||
        !API_KEY_SID.test(apiKeySid) ||
        !apiKeySecret ||
        apiKeySecret.length < 16 ||
        apiKeySecret.length > 256 ||
        !verifyServiceSid ||
        !VERIFY_SERVICE_SID.test(verifyServiceSid)
    ) {
        return null;
    }
    return { apiKeySid, apiKeySecret, verifyServiceSid };
}

function authorization(config: TwilioConfig): string {
    return `Basic ${btoa(`${config.apiKeySid}:${config.apiKeySecret}`)}`;
}

async function twilioJson(
    operation: TwilioProviderError['operation'],
    url: string,
    init: RequestInit,
    fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
        response = await fetcher(url, {
            ...init,
            headers: { Accept: 'application/json', ...(init.headers ?? {}) },
            signal: controller.signal,
        });
    } catch {
        throw new TwilioProviderError(operation, 503, null);
    } finally {
        clearTimeout(timeout);
    }

    const body = await readResponseJsonObjectLimited(response, 65_536);
    const providerCode = typeof body?.code === 'number' && Number.isInteger(body.code) ? body.code : null;
    if (!response.ok || !body) throw new TwilioProviderError(operation, response.status, providerCode);
    return body;
}

export async function lookupPhone(
    rawPhone: string,
    countryCode: string,
    config: TwilioConfig,
    fetcher: typeof fetch = fetch,
): Promise<LookupResult> {
    const url = new URL(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(rawPhone)}`);
    url.searchParams.set('CountryCode', countryCode);
    const body = await twilioJson(
        'lookup',
        url.toString(),
        { method: 'GET', headers: { Authorization: authorization(config) } },
        fetcher,
    );
    if (body.valid !== true || !isE164(body.phone_number)) {
        throw new TwilioProviderError('lookup', 400, null);
    }
    return { e164: body.phone_number };
}

export async function startVerification(
    e164: string,
    rateLimitKeys: Readonly<
        Record<'crew_user' | 'crew_phone' | 'crew_ip', string>
    >,
    config: TwilioConfig,
    fetcher: typeof fetch = fetch,
): Promise<StartVerificationResult> {
    if (!isE164(e164)) throw new TwilioProviderError('start', 400, null);
    const form = new URLSearchParams({ To: e164, Channel: 'sms' });
    for (const [name, value] of Object.entries(rateLimitKeys)) {
        if (!/^[0-9a-f]{64}$/.test(value)) throw new TwilioProviderError('start', 500, null);
        form.append(`RateLimits[${name}]`, value);
    }
    const body = await twilioJson(
        'start',
        `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/Verifications`,
        {
            method: 'POST',
            headers: {
                Authorization: authorization(config),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form,
        },
        fetcher,
    );
    if (!VERIFICATION_SID.test(String(body.sid ?? '')) || body.status !== 'pending') {
        throw new TwilioProviderError('start', 502, null);
    }
    return { sid: String(body.sid), status: 'pending' };
}

export async function checkVerification(
    verificationSid: string,
    code: string,
    config: TwilioConfig,
    fetcher: typeof fetch = fetch,
): Promise<CheckVerificationResult> {
    if (!VERIFICATION_SID.test(verificationSid) || !/^[0-9]{6}$/.test(code)) {
        throw new TwilioProviderError('check', 400, null);
    }
    const body = await twilioJson(
        'check',
        `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/VerificationCheck`,
        {
            method: 'POST',
            headers: {
                Authorization: authorization(config),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ VerificationSid: verificationSid, Code: code }),
        },
        fetcher,
    );
    const status = body.status;
    if (
        status !== 'pending' &&
        status !== 'approved' &&
        status !== 'canceled' &&
        status !== 'max_attempts_reached' &&
        status !== 'deleted' &&
        status !== 'failed' &&
        status !== 'expired'
    ) {
        throw new TwilioProviderError('check', 502, null);
    }
    return { status };
}
