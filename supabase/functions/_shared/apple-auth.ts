/**
 * Server-only Sign in with Apple token lifecycle primitives.
 *
 * TN3194 expects apps with server infrastructure to exchange the one-time
 * authorization code, retain a refresh token securely, and revoke that token
 * when the account is deleted. None of the credentials consumed here may be
 * shipped in the web bundle or native app.
 */
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'npm:jose@5';
import { fetchWithTimeout, readResponseTextLimited } from './http-security.ts';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`;
const APPLE_KEYS_URL = `${APPLE_ISSUER}/auth/keys`;
const CLIENT_SECRET_LIFETIME_SECONDS = 5 * 60;
const TOKEN_RESPONSE_MAX_BYTES = 16_384;
const ENCRYPTION_VERSION = 1;
const APPLE_JWKS = createRemoteJWKSet(new URL(APPLE_KEYS_URL), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 10_000,
});

export interface AppleServerConfig {
    clientId: string;
    teamId: string;
    keyId: string;
    privateKeyPem: string;
    refreshTokenEncryptionKey: CryptoKey;
}

export interface AppleTokenExchange {
    refreshToken: string;
    idToken: string;
}

export interface EncryptedAppleRefreshToken {
    ciphertext: string;
    iv: string;
    encryptionVersion: typeof ENCRYPTION_VERSION;
}

export interface VerifiedAppleServerNotification {
    jti: string;
    eventType: 'consent-revoked' | 'account-deleted' | 'email-enabled' | 'email-disabled';
    subject: string;
    eventTime: Date;
    issuedAt: Date;
}

interface AppleTokenResponseBody {
    refresh_token?: unknown;
    id_token?: unknown;
    error?: unknown;
}

interface SupabaseIdentityLike {
    provider?: unknown;
    identity_id?: unknown;
    identity_data?: Record<string, unknown> | null;
}

interface SupabaseUserLike {
    identities?: SupabaseIdentityLike[] | null;
}

function decodeBase64(value: string): Uint8Array {
    const normalized = value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        throw new Error('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY must be standard base64');
    }
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
    const owned = new Uint8Array(value.byteLength);
    owned.set(value);
    return owned.buffer;
}

function encryptionContext(userId: string, subjectSha256: string): Uint8Array {
    return new TextEncoder().encode(`thalassa.apple-refresh-token.v1:${userId}:${subjectSha256}`);
}

function normalizedPrivateKey(value: string): string {
    return value.includes('\\n') ? value.replaceAll('\\n', '\n') : value;
}

/** Load and validate every Apple server credential without exposing its value. */
export async function readAppleServerConfig(): Promise<AppleServerConfig | null> {
    const clientId = Deno.env.get('APPLE_SIGN_IN_CLIENT_ID')?.trim();
    const teamId = Deno.env.get('APPLE_SIGN_IN_TEAM_ID')?.trim();
    const keyId = Deno.env.get('APPLE_SIGN_IN_KEY_ID')?.trim();
    const privateKey = Deno.env.get('APPLE_SIGN_IN_PRIVATE_KEY');
    const encryptionKey = Deno.env.get('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY');
    if (!clientId || !teamId || !keyId || !privateKey || !encryptionKey) return null;

    const rawEncryptionKey = decodeBase64(encryptionKey);
    if (rawEncryptionKey.byteLength !== 32) {
        throw new Error('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
    const refreshTokenEncryptionKey = await crypto.subtle.importKey(
        'raw',
        toArrayBuffer(rawEncryptionKey),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
    );
    rawEncryptionKey.fill(0);

    return {
        clientId,
        teamId,
        keyId,
        privateKeyPem: normalizedPrivateKey(privateKey),
        refreshTokenEncryptionKey,
    };
}

/** Return the provider-controlled Apple subject attached to a verified Supabase user. */
export function appleSubjectForAuthenticatedUser(user: SupabaseUserLike): string | null {
    const identity = user.identities?.find((candidate) => candidate.provider === 'apple');
    if (!identity) return null;
    const candidates = [identity.identity_data?.sub, identity.identity_data?.provider_id, identity.identity_id];
    return (
        candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0) ??
            null
    );
}

export async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createAppleClientSecret(config: AppleServerConfig): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(config.privateKeyPem, 'ES256');
    return await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
        .setIssuer(config.teamId)
        .setSubject(config.clientId)
        .setAudience(APPLE_ISSUER)
        .setIssuedAt(now)
        .setExpirationTime(now + CLIENT_SECRET_LIFETIME_SECONDS)
        .sign(key);
}

async function readAppleJson(response: Response): Promise<AppleTokenResponseBody | null> {
    const text = await readResponseTextLimited(response, TOKEN_RESPONSE_MAX_BYTES);
    if (text === null || !text) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as AppleTokenResponseBody)
            : null;
    } catch {
        return null;
    }
}

/** Exchange a one-time native authorization code. Never log the code or response. */
export async function exchangeAppleAuthorizationCode(
    config: AppleServerConfig,
    authorizationCode: string,
): Promise<AppleTokenExchange> {
    const clientSecret = await createAppleClientSecret(config);
    const response = await fetchWithTimeout(
        APPLE_TOKEN_URL,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: config.clientId,
                client_secret: clientSecret,
                code: authorizationCode,
                grant_type: 'authorization_code',
            }),
        },
        15_000,
    );
    const body = await readAppleJson(response);
    if (
        !response.ok ||
        typeof body?.refresh_token !== 'string' ||
        body.refresh_token.length === 0 ||
        typeof body.id_token !== 'string' ||
        body.id_token.length === 0
    ) {
        const appleError = typeof body?.error === 'string' ? body.error.replace(/[^a-z_]/gi, '') : 'invalid_response';
        throw new Error(`Apple authorization-code exchange failed (${response.status}:${appleError})`);
    }
    return { refreshToken: body.refresh_token, idToken: body.id_token };
}

/** Verify Apple's signature and claims, then return the signed provider subject. */
export async function verifyAppleIdTokenSubject(idToken: string, clientId: string): Promise<string> {
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
        issuer: APPLE_ISSUER,
        audience: clientId,
        algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('Apple identity token has no subject');
    }
    return payload.sub;
}

/** Verify and minimally project Apple's signed server-to-server event JWS. */
export async function verifyAppleServerNotification(
    signedPayload: string,
    clientId: string,
): Promise<VerifiedAppleServerNotification> {
    const { payload } = await jwtVerify(signedPayload, APPLE_JWKS, {
        issuer: APPLE_ISSUER,
        audience: clientId,
        algorithms: ['RS256'],
    });
    const events = payload.events;
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
        throw new Error('Apple server notification has no events claim');
    }
    const eventType = (events as Record<string, unknown>).type;
    const subject = (events as Record<string, unknown>).sub;
    const eventTimeRaw = (events as Record<string, unknown>).event_time;
    const allowedTypes = ['consent-revoked', 'account-deleted', 'email-enabled', 'email-disabled'] as const;
    if (!allowedTypes.some((candidate) => candidate === eventType)) {
        throw new Error('Apple server notification has an unsupported event type');
    }
    if (typeof subject !== 'string' || subject.length === 0 || subject.length > 1024) {
        throw new Error('Apple server notification has no valid subject');
    }
    if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 512) {
        throw new Error('Apple server notification has no valid event identifier');
    }
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
        throw new Error('Apple server notification has no valid issue time');
    }
    const numericEventTime = typeof eventTimeRaw === 'number'
        ? eventTimeRaw
        : typeof eventTimeRaw === 'string' && eventTimeRaw.trim()
        ? Number(eventTimeRaw)
        : Number.NaN;
    if (!Number.isFinite(numericEventTime)) throw new Error('Apple server notification has no valid event time');
    const eventTimeSeconds = numericEventTime > 10_000_000_000 ? numericEventTime / 1000 : numericEventTime;
    const nowSeconds = Date.now() / 1000;
    if (payload.iat > nowSeconds + 5 * 60 || eventTimeSeconds > nowSeconds + 5 * 60) {
        throw new Error('Apple server notification is dated in the future');
    }

    return {
        jti: payload.jti,
        eventType: eventType as VerifiedAppleServerNotification['eventType'],
        subject,
        eventTime: new Date(eventTimeSeconds * 1000),
        issuedAt: new Date(payload.iat * 1000),
    };
}

export async function encryptAppleRefreshToken(
    refreshToken: string,
    config: AppleServerConfig,
    userId: string,
    subjectSha256: string,
): Promise<EncryptedAppleRefreshToken> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(refreshToken);
    try {
        const encrypted = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: toArrayBuffer(iv),
                additionalData: toArrayBuffer(encryptionContext(userId, subjectSha256)),
                tagLength: 128,
            },
            config.refreshTokenEncryptionKey,
            toArrayBuffer(plaintext),
        );
        return {
            ciphertext: encodeBase64(new Uint8Array(encrypted)),
            iv: encodeBase64(iv),
            encryptionVersion: ENCRYPTION_VERSION,
        };
    } finally {
        plaintext.fill(0);
    }
}

export async function decryptAppleRefreshToken(
    ciphertext: string,
    iv: string,
    encryptionVersion: number,
    config: AppleServerConfig,
    userId: string,
    subjectSha256: string,
): Promise<string> {
    if (encryptionVersion !== ENCRYPTION_VERSION) throw new Error('Unsupported Apple token encryption version');
    const decrypted = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: toArrayBuffer(decodeBase64(iv)),
            additionalData: toArrayBuffer(encryptionContext(userId, subjectSha256)),
            tagLength: 128,
        },
        config.refreshTokenEncryptionKey,
        toArrayBuffer(decodeBase64(ciphertext)),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
}

/** Apple returns 200 both for a successful revocation and an already-revoked token. */
export async function revokeAppleRefreshToken(config: AppleServerConfig, refreshToken: string): Promise<void> {
    const clientSecret = await createAppleClientSecret(config);
    const response = await fetchWithTimeout(
        APPLE_REVOKE_URL,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: config.clientId,
                client_secret: clientSecret,
                token: refreshToken,
                token_type_hint: 'refresh_token',
            }),
        },
        15_000,
    );
    if (!response.ok) {
        await readResponseTextLimited(response, TOKEN_RESPONSE_MAX_BYTES);
        throw new Error(`Apple refresh-token revocation failed (${response.status})`);
    }
    await response.body?.cancel().catch(() => undefined);
}
