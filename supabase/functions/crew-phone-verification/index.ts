import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import {
    clientAddress,
    isUuid,
    keyedFingerprint,
    lastFour,
    parseAction,
    parsePhoneStart,
    parseVerificationCode,
    PHONE_HMAC_VERSION,
    VERIFICATION_TTL_SECONDS,
} from './protocol.ts';
import {
    checkVerification,
    classifyTwilioProviderError,
    lookupPhone,
    readTwilioConfig,
    startVerification,
    TwilioProviderError,
} from './twilio.ts';

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// A fixed, domain-separated sentinel detects accidental secret replacement.
// Rotate the secret/version only after the database guard confirms that no
// Crew phone identities or attempts remain.
const HMAC_KEY_SENTINEL = 'thalassa-crew-phone-hmac-key-check';

interface RpcResult {
    data: unknown;
    error: unknown;
}

interface RpcClient {
    rpc(name: string, parameters?: Record<string, unknown>): PromiseLike<RpcResult>;
}

interface Caller {
    userId: string;
    emailVerified: boolean;
    client: RpcClient;
}

interface PublicError {
    error: string;
    code: string;
    retryAfterSeconds?: number;
}

function reply(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return jsonResponse(body, status, { ...CORS_HEADERS, ...extraHeaders });
}

function publicError(
    error: string,
    code: string,
    status: number,
    retryAfterSeconds?: number,
): Response {
    const body: PublicError = { error, code };
    if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds;
    return reply(
        body,
        status,
        retryAfterSeconds === undefined ? {} : { 'Retry-After': String(retryAfterSeconds) },
    );
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function authenticate(req: Request, supabaseUrl: string, publicKey: string): Promise<Caller | Response> {
    const authorization = req.headers.get('authorization');
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) {
        return publicError('Authentication required', 'AUTH_REQUIRED', 401);
    }
    const client = createClient(supabaseUrl, publicKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
        data: { user },
        error,
    } = await client.auth.getUser();
    if (error || !user || !isUuid(user.id)) {
        return publicError('Session expired. Please sign in again.', 'AUTH_INVALID', 401);
    }
    return {
        userId: user.id,
        emailVerified: Boolean(user.email_confirmed_at),
        client: client as unknown as RpcClient,
    };
}

async function consumeUserQuota(
    client: RpcClient,
    bucket: string,
    limit: number,
    windowSeconds: number,
): Promise<Response | null> {
    const { data, error } = await client.rpc('consume_edge_quota', {
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
    });
    if (error) return publicError('Verification service is temporarily unavailable.', 'QUOTA_UNAVAILABLE', 503, 60);
    if (data !== true) return publicError('Too many verification requests. Please try later.', 'RATE_LIMITED', 429, 60);
    return null;
}

async function consumeHashQuota(
    admin: RpcClient,
    bucket: string,
    clientHash: string,
    limit: number,
    windowSeconds: number,
): Promise<Response | null> {
    const { data, error } = await admin.rpc('consume_public_edge_quota', {
        p_bucket: bucket,
        p_client_hash: clientHash,
        p_limit: limit,
        p_window_seconds: windowSeconds,
    });
    if (error) return publicError('Verification service is temporarily unavailable.', 'QUOTA_UNAVAILABLE', 503, 60);
    if (data !== true) return publicError('Too many verification requests. Please try later.', 'RATE_LIMITED', 429, 60);
    return null;
}

async function consumeQuotas(
    quotas: Array<() => Promise<Response | null>>,
): Promise<Response | null> {
    for (const consume of quotas) {
        const failure = await consume();
        if (failure) return failure;
    }
    return null;
}

function providerPublicError(error: TwilioProviderError): Response {
    switch (classifyTwilioProviderError(error)) {
        case 'phone_invalid':
            return publicError('Enter a valid mobile number.', 'PHONE_INVALID', 400);
        case 'code_expired':
            return publicError('That code has expired. Request a new code.', 'CODE_EXPIRED', 410);
        case 'rate_limited':
            return publicError('Too many verification requests. Please try later.', 'RATE_LIMITED', 429, 60);
        case 'sms_unavailable':
            return publicError('SMS verification is not available for that number.', 'SMS_UNAVAILABLE', 400);
        default:
            return publicError('Verification service is temporarily unavailable.', 'VERIFICATION_UNAVAILABLE', 503, 60);
    }
}

function internalProviderCode(error: TwilioProviderError, fallback: string): string {
    return error.providerCode === null ? fallback : `TWILIO_${error.providerCode}`.slice(0, 40);
}

async function markAttempt(
    admin: RpcClient,
    userId: string,
    attemptId: string,
    failureCode: string,
    finalStatus: 'failed' | 'expired' | 'conflict' | 'superseded' = 'failed',
): Promise<void> {
    await admin.rpc('fail_crew_phone_verification_attempt', {
        p_user_id: userId,
        p_attempt_id: attemptId,
        p_failure_code: failureCode,
        p_final_status: finalStatus,
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return publicError('POST required', 'METHOD_NOT_ALLOWED', 405);

    const body = await readJsonObject(req, 2_048);
    const action = parseAction(body?.action);
    if (!body || !action) return publicError('Invalid verification request.', 'INVALID_REQUEST', 400);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !publicKey) {
        return publicError('Verification service is temporarily unavailable.', 'SERVER_CONFIG', 503);
    }

    const authenticated = await authenticate(req, supabaseUrl, publicKey);
    if (authenticated instanceof Response) return authenticated;

    if (action === 'status') {
        const quotaFailure = await consumeUserQuota(authenticated.client, 'crew_phone_status', 120, 3_600);
        if (quotaFailure) return quotaFailure;
        const { data, error } = await authenticated.client.rpc('get_current_crew_phone_status');
        const status = record(data);
        if (error || !status) {
            return publicError('Verification status is temporarily unavailable.', 'STATUS_UNAVAILABLE', 503);
        }
        return reply({
            verified: status.verified === true,
            last4: typeof status.last4 === 'string' ? status.last4 : null,
            verifiedAt: typeof status.verified_at === 'string' ? status.verified_at : null,
            emailVerified: authenticated.emailVerified && status.email_verified === true,
        });
    }

    if (!authenticated.emailVerified) {
        return publicError('Verify your email before verifying a phone number.', 'EMAIL_NOT_VERIFIED', 403);
    }

    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const hmacSecret = Deno.env.get('CREW_PHONE_HMAC_KEY');
    const twilioConfig = readTwilioConfig(Deno.env);
    if (!serviceRoleKey || !hmacSecret || !twilioConfig) {
        return publicError('Verification service is temporarily unavailable.', 'SERVER_CONFIG', 503);
    }
    const address = clientAddress(req);
    if (!address) {
        return publicError('Verification service is temporarily unavailable.', 'CLIENT_ADDRESS_REQUIRED', 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RpcClient;
    let keyTag: string;
    try {
        keyTag = await keyedFingerprint(hmacSecret, 'crew-phone-key-tag', HMAC_KEY_SENTINEL);
    } catch {
        return publicError('Verification service is temporarily unavailable.', 'SERVER_CONFIG', 503);
    }
    const { data: keyAccepted, error: keyError } = await admin.rpc('assert_crew_phone_hmac_key', {
        p_hmac_version: PHONE_HMAC_VERSION,
        p_key_tag: keyTag,
    });
    if (keyError || keyAccepted !== true) {
        return publicError('Verification service is temporarily unavailable.', 'SERVER_CONFIG', 503);
    }

    let userHash: string;
    let ipHash: string;
    try {
        [userHash, ipHash] = await Promise.all([
            keyedFingerprint(hmacSecret, 'crew-phone-user', authenticated.userId),
            keyedFingerprint(hmacSecret, 'crew-phone-ip', address),
        ]);
    } catch {
        return publicError('Verification service is temporarily unavailable.', 'SERVER_CONFIG', 503);
    }

    if (action === 'start') {
        const input = parsePhoneStart(body.phone, body.countryCode);
        if (!input) return publicError('Enter a valid phone number and country.', 'PHONE_INVALID', 400);

        const quotaFailure = await consumeQuotas([
            () => consumeUserQuota(authenticated.client, 'crew_phone_start_10m', 3, 600),
            () => consumeUserQuota(authenticated.client, 'crew_phone_start_day', 10, 86_400),
            () => consumeHashQuota(admin, 'crew_phone_ip_hour', ipHash, 10, 3_600),
            () => consumeHashQuota(admin, 'crew_phone_ip_day', ipHash, 30, 86_400),
        ]);
        if (quotaFailure) return quotaFailure;

        let e164: string;
        try {
            e164 = (await lookupPhone(input.phone, input.countryCode, twilioConfig)).e164;
        } catch (error) {
            return error instanceof TwilioProviderError
                ? providerPublicError(error)
                : publicError('Verification service is temporarily unavailable.', 'VERIFICATION_UNAVAILABLE', 503);
        }

        let phoneHash: string;
        try {
            phoneHash = await keyedFingerprint(hmacSecret, 'crew-phone-number', e164);
        } catch {
            return publicError('Verification service is temporarily unavailable.', 'SERVER_CONFIG', 503);
        }
        const phoneQuotaFailure = await consumeQuotas([
            () => consumeHashQuota(admin, 'crew_phone_number_10m', phoneHash, 3, 600),
            () => consumeHashQuota(admin, 'crew_phone_number_day', phoneHash, 6, 86_400),
        ]);
        if (phoneQuotaFailure) return phoneQuotaFailure;

        const { data: reservationData, error: reservationError } = await admin.rpc(
            'reserve_crew_phone_verification_attempt',
            {
                p_user_id: authenticated.userId,
                p_phone_hmac: phoneHash,
                p_phone_last4: lastFour(e164),
                p_hmac_version: PHONE_HMAC_VERSION,
            },
        );
        const reservation = record(reservationData);
        if (reservationError || !reservation) {
            return publicError('Verification service is temporarily unavailable.', 'ATTEMPT_UNAVAILABLE', 503);
        }
        if (reservation.status === 'cooldown') {
            const retryAfter = typeof reservation.retry_after_seconds === 'number'
                ? Math.max(1, Math.min(60, Math.ceil(reservation.retry_after_seconds)))
                : 60;
            return publicError('Wait before requesting another code.', 'RESEND_COOLDOWN', 429, retryAfter);
        }
        if (reservation.status === 'already_verified') {
            return publicError('That phone number is already verified.', 'ALREADY_VERIFIED', 409);
        }
        if (reservation.status !== 'reserved' || !isUuid(reservation.attempt_id)) {
            return publicError('Verification service is temporarily unavailable.', 'ATTEMPT_UNAVAILABLE', 503);
        }
        const attemptId = reservation.attempt_id;

        let verificationSid: string;
        try {
            verificationSid = (
                await startVerification(
                    e164,
                    {
                        crew_user: userHash,
                        crew_phone: phoneHash,
                        crew_ip: ipHash,
                    },
                    twilioConfig,
                )
            ).sid;
        } catch (error) {
            if (error instanceof TwilioProviderError) {
                await markAttempt(
                    admin,
                    authenticated.userId,
                    attemptId,
                    internalProviderCode(error, 'PROVIDER_START'),
                );
                return providerPublicError(error);
            }
            await markAttempt(admin, authenticated.userId, attemptId, 'PROVIDER_START');
            return publicError('Verification service is temporarily unavailable.', 'VERIFICATION_UNAVAILABLE', 503);
        }

        const expiresAt = new Date(Date.now() + VERIFICATION_TTL_SECONDS * 1_000).toISOString();
        const { data: activated, error: activationError } = await admin.rpc(
            'activate_crew_phone_verification_attempt',
            {
                p_user_id: authenticated.userId,
                p_attempt_id: attemptId,
                p_twilio_verification_sid: verificationSid,
                p_expires_at: expiresAt,
            },
        );
        if (activationError || activated !== true) {
            await markAttempt(admin, authenticated.userId, attemptId, 'DATABASE_ACTIVATION');
            return publicError('Verification service is temporarily unavailable.', 'ATTEMPT_UNAVAILABLE', 503);
        }

        return reply({
            status: 'pending',
            last4: lastFour(e164),
            retryAfterSeconds: 60,
            expiresAt,
        });
    }

    const code = parseVerificationCode(body.code);
    if (!code) return publicError('Enter the six-digit verification code.', 'CODE_INVALID', 400);

    const quotaFailure = await consumeQuotas([
        () => consumeUserQuota(authenticated.client, 'crew_phone_check_10m', 12, 600),
        () => consumeUserQuota(authenticated.client, 'crew_phone_check_day', 30, 86_400),
        () => consumeHashQuota(admin, 'crew_phone_check_ip', ipHash, 60, 3_600),
    ]);
    if (quotaFailure) return quotaFailure;

    const { data: claimData, error: claimError } = await admin.rpc('claim_crew_phone_verification_check', {
        p_user_id: authenticated.userId,
    });
    const claim = record(claimData);
    if (claimError || !claim) {
        return publicError('Verification service is temporarily unavailable.', 'ATTEMPT_UNAVAILABLE', 503);
    }
    if (claim.status === 'max_checks') {
        return publicError('Too many incorrect codes. Request a new code.', 'TOO_MANY_CODES', 429, 60);
    }
    if (
        claim.status !== 'claimed' ||
        !isUuid(claim.attempt_id) ||
        typeof claim.verification_sid !== 'string'
    ) {
        return publicError('Request a new verification code.', 'NO_ACTIVE_VERIFICATION', 409);
    }
    const attemptId = claim.attempt_id;
    const verificationSid = claim.verification_sid;

    let checkedStatus: Awaited<ReturnType<typeof checkVerification>>['status'];
    try {
        checkedStatus = (await checkVerification(verificationSid, code, twilioConfig)).status;
    } catch (error) {
        if (error instanceof TwilioProviderError) {
            // Verify removes an approved challenge. A concurrent double tap can
            // therefore see 404 while the winning request is still completing;
            // do not terminalize the shared local attempt on provider absence.
            // Local expiry or the next activated challenge retires it safely.
            return providerPublicError(error);
        }
        return publicError('Verification service is temporarily unavailable.', 'VERIFICATION_UNAVAILABLE', 503);
    }

    if (checkedStatus === 'pending') {
        return publicError('That code is not correct.', 'CODE_INCORRECT', 400);
    }
    if (checkedStatus !== 'approved') {
        await markAttempt(
            admin,
            authenticated.userId,
            attemptId,
            `TWILIO_${checkedStatus.toUpperCase()}`.slice(0, 40),
            checkedStatus === 'expired' || checkedStatus === 'deleted' ? 'expired' : 'failed',
        );
        return publicError('That code has expired. Request a new code.', 'CODE_EXPIRED', 410);
    }

    const { data: completionData, error: completionError } = await admin.rpc(
        'complete_crew_phone_verification',
        {
            p_user_id: authenticated.userId,
            p_attempt_id: attemptId,
            p_twilio_verification_sid: verificationSid,
        },
    );
    const completion = record(completionData);
    if (completionError || !completion) {
        return publicError('Verification service is temporarily unavailable.', 'COMPLETION_UNAVAILABLE', 503);
    }
    if (completion.status === 'conflict') {
        return publicError('That phone number is already linked to another account.', 'PHONE_IN_USE', 409);
    }
    if (completion.status === 'email_unverified') {
        return publicError('Verify your email before verifying a phone number.', 'EMAIL_NOT_VERIFIED', 403);
    }
    if (completion.verified !== true) {
        return publicError('Request a new verification code.', 'NO_ACTIVE_VERIFICATION', 409);
    }

    return reply({
        verified: true,
        last4: typeof completion.last4 === 'string' ? completion.last4 : null,
        verifiedAt: typeof completion.verified_at === 'string' ? completion.verified_at : null,
    });
});
