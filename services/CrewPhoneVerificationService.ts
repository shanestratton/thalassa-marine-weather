import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import { supabase } from './supabase';

const FUNCTION_NAME = 'crew-phone-verification';

export interface CrewPhoneVerificationStatus {
    verified: boolean;
    last4: string | null;
    verifiedAt: string | null;
    emailVerified: boolean;
}

export interface CrewPhoneVerificationPending {
    status: 'pending';
    last4: string;
    retryAfterSeconds: number;
    expiresAt: string;
}

export interface CrewPhoneVerificationComplete {
    verified: true;
    last4: string;
    verifiedAt: string;
}

interface VerificationErrorPayload {
    error?: unknown;
    code?: unknown;
    retryAfterSeconds?: unknown;
}

export class CrewPhoneVerificationError extends Error {
    readonly code: string;
    readonly retryAfterSeconds?: number;

    constructor(message: string, code = 'UNKNOWN', retryAfterSeconds?: number) {
        super(message);
        this.name = 'CrewPhoneVerificationError';
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.ceil(value);
}

function errorFromPayload(
    payload: unknown,
    fallback = 'Phone verification could not be completed',
): CrewPhoneVerificationError {
    const parsed = payload && typeof payload === 'object' ? (payload as VerificationErrorPayload) : {};
    const message = typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : fallback;
    const code = typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code.trim() : 'UNKNOWN';
    return new CrewPhoneVerificationError(message, code, finiteNonNegativeInteger(parsed.retryAfterSeconds));
}

async function payloadFromInvokeError(error: unknown): Promise<unknown> {
    if (!error || typeof error !== 'object') return null;
    const context = (error as { context?: unknown }).context;
    if (!context || typeof context !== 'object') return null;
    const response = context as { clone?: () => unknown; json?: () => Promise<unknown> };
    try {
        const clone = typeof response.clone === 'function' ? response.clone() : response;
        if (clone && typeof clone === 'object' && typeof (clone as { json?: unknown }).json === 'function') {
            return await (clone as { json: () => Promise<unknown> }).json();
        }
    } catch {
        // The response body may already have been consumed by supabase-js.
    }
    return null;
}

function isLast4(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

async function invokeVerification(body: Record<string, string>): Promise<unknown> {
    if (!supabase) throw new CrewPhoneVerificationError('Phone verification is unavailable', 'NOT_CONFIGURED');

    const scope = getAuthIdentityScope();
    if (!scope.userId) throw new CrewPhoneVerificationError('Sign in before verifying your mobile', 'AUTH_REQUIRED');

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || user?.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new CrewPhoneVerificationError('Your account changed. Please try again.', 'AUTH_CHANGED');
    }

    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });
    if (!isAuthIdentityScopeCurrent(scope)) {
        throw new CrewPhoneVerificationError('Your account changed. Please try again.', 'AUTH_CHANGED');
    }
    if (error) {
        const payload = await payloadFromInvokeError(error);
        throw errorFromPayload(payload, error.message || 'Phone verification could not be completed');
    }
    if (data && typeof data === 'object' && typeof (data as VerificationErrorPayload).error === 'string') {
        throw errorFromPayload(data);
    }
    return data;
}

function parseStatus(value: unknown): CrewPhoneVerificationStatus {
    if (!value || typeof value !== 'object') throw errorFromPayload(null, 'Invalid verification response');
    const result = value as Record<string, unknown>;
    if (
        typeof result.verified !== 'boolean' ||
        typeof result.emailVerified !== 'boolean' ||
        (result.last4 !== null && !isLast4(result.last4)) ||
        (result.verifiedAt !== null && !isIsoDate(result.verifiedAt))
    ) {
        throw errorFromPayload(null, 'Invalid verification response');
    }
    return {
        verified: result.verified,
        last4: result.last4 as string | null,
        verifiedAt: result.verifiedAt as string | null,
        emailVerified: result.emailVerified,
    };
}

function parsePending(value: unknown): CrewPhoneVerificationPending {
    if (!value || typeof value !== 'object') throw errorFromPayload(null, 'Invalid verification response');
    const result = value as Record<string, unknown>;
    const retryAfterSeconds = finiteNonNegativeInteger(result.retryAfterSeconds);
    if (
        result.status !== 'pending' ||
        !isLast4(result.last4) ||
        retryAfterSeconds === undefined ||
        !isIsoDate(result.expiresAt)
    ) {
        throw errorFromPayload(null, 'Invalid verification response');
    }
    return {
        status: 'pending',
        last4: result.last4,
        retryAfterSeconds,
        expiresAt: result.expiresAt,
    };
}

function parseComplete(value: unknown): CrewPhoneVerificationComplete {
    if (!value || typeof value !== 'object') throw errorFromPayload(null, 'Invalid verification response');
    const result = value as Record<string, unknown>;
    if (result.verified !== true || !isLast4(result.last4) || !isIsoDate(result.verifiedAt)) {
        throw errorFromPayload(null, 'Invalid verification response');
    }
    return { verified: true, last4: result.last4, verifiedAt: result.verifiedAt };
}

export const CrewPhoneVerificationService = {
    async getStatus(): Promise<CrewPhoneVerificationStatus> {
        return parseStatus(await invokeVerification({ action: 'status' }));
    },

    async start(phone: string, countryCode: string): Promise<CrewPhoneVerificationPending> {
        const normalizedPhone = phone.trim();
        const normalizedCountry = countryCode.trim().toUpperCase();
        if (!/^[0-9()+\-\s]{5,24}$/.test(normalizedPhone) || (normalizedPhone.match(/[0-9]/g) ?? []).length < 5) {
            throw new CrewPhoneVerificationError('Enter a valid mobile number', 'INVALID_PHONE');
        }
        if (!/^[A-Z]{2}$/.test(normalizedCountry)) {
            throw new CrewPhoneVerificationError('Choose a valid country', 'INVALID_COUNTRY');
        }
        return parsePending(
            await invokeVerification({ action: 'start', phone: normalizedPhone, countryCode: normalizedCountry }),
        );
    },

    async check(code: string): Promise<CrewPhoneVerificationComplete> {
        const normalizedCode = code.trim();
        if (!/^\d{6}$/.test(normalizedCode)) {
            throw new CrewPhoneVerificationError('Enter the six-digit code', 'INVALID_CODE');
        }
        return parseComplete(await invokeVerification({ action: 'check', code: normalizedCode }));
    },

    async remove(): Promise<boolean> {
        if (!supabase) throw new CrewPhoneVerificationError('Phone verification is unavailable', 'NOT_CONFIGURED');
        const scope = getAuthIdentityScope();
        if (!scope.userId) {
            throw new CrewPhoneVerificationError('Sign in before changing your verified mobile', 'AUTH_REQUIRED');
        }
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();
        if (authError || user?.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new CrewPhoneVerificationError('Your account changed. Please try again.', 'AUTH_CHANGED');
        }

        const { data, error } = await supabase.rpc('revoke_current_crew_phone_identity');
        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new CrewPhoneVerificationError('Your account changed. Please try again.', 'AUTH_CHANGED');
        }
        if (error || data !== true) {
            throw new CrewPhoneVerificationError(
                'Could not change your verified mobile. Please try again.',
                'REMOVE_FAILED',
            );
        }
        return true;
    },
};
