/**
 * register-apple-token — retain a revocable Apple credential after native auth.
 *
 * The native client invokes this only after Supabase has authenticated Apple's
 * ID token. This function independently authenticates that session, exchanges
 * the one-time authorization code with Apple, verifies the signed Apple
 * subject belongs to the caller, encrypts the refresh token, and stores it in
 * a service-role-only table. Authorization codes and tokens are never logged.
 *
 * The decisions (and why a repeat sign-in must never revoke anything) live in
 * registration.ts; this file is the HTTP and Supabase wiring.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    appleIdentityLinkedAt,
    type AppleServerConfig,
    appleSubjectForAuthenticatedUser,
    encryptAppleRefreshToken,
    exchangeAppleAuthorizationCode,
    readAppleServerConfig,
    revokeAppleRefreshToken,
    sha256Hex,
    verifyAppleIdTokenSubject,
} from '../_shared/apple-auth.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { registerAppleRefreshToken, type StoredAppleToken } from './registration.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200): Response => jsonResponse(body, status, CORS);

interface StoredAppleTokenColumns {
    apple_subject_sha256: string;
    updated_at: string;
}

function storedToken(row: StoredAppleTokenColumns): StoredAppleToken {
    return { appleSubjectSha256: row.apple_subject_sha256, updatedAt: row.updated_at };
}

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const authorization = req.headers.get('authorization');
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) {
        return json({ error: 'Authentication required' }, 401);
    }

    const body = await readJsonObject(req, 10_240);
    const authorizationCode = body?.authorizationCode;
    if (
        typeof authorizationCode !== 'string' ||
        authorizationCode.length < 8 ||
        authorizationCode.length > 8_192 ||
        /[\0\r\n]/.test(authorizationCode)
    ) {
        return json({ error: 'A valid Apple authorization code is required' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        return json({ error: 'Apple token registration is not configured' }, 503);
    }

    const caller = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
        data: { user },
        error: authError,
    } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Invalid or expired session' }, 401);

    const callerAppleSubject = appleSubjectForAuthenticatedUser(user);
    if (!callerAppleSubject) return json({ error: 'The authenticated account is not linked to Apple' }, 403);

    let configured: AppleServerConfig | null;
    try {
        configured = await readAppleServerConfig();
    } catch (error) {
        console.error('[register-apple-token] invalid server credential configuration:', error);
        return json({ error: 'Apple token registration is not configured' }, 503);
    }
    if (!configured) return json({ error: 'Apple token registration is not configured' }, 503);
    const appleConfig = configured;

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await registerAppleRefreshToken(authorizationCode, callerAppleSubject, appleIdentityLinkedAt(user), {
        exchangeAuthorizationCode: (authorizationCode) =>
            exchangeAppleAuthorizationCode(appleConfig, authorizationCode),
        verifyIdTokenSubject: (idToken) => verifyAppleIdTokenSubject(idToken, appleConfig.clientId),
        sha256Hex,
        encryptRefreshToken: async (refreshToken, subjectSha256) =>
            await encryptAppleRefreshToken(refreshToken, appleConfig, user.id, subjectSha256),
        loadStoredTokenForUser: async () => {
            const { data, error } = await admin
                .from('apple_sign_in_tokens')
                .select('apple_subject_sha256, updated_at')
                .eq('user_id', user.id)
                .maybeSingle();
            if (error) throw new Error(`Existing Apple token lookup failed: ${error.code ?? 'database_error'}`);
            return data ? storedToken(data as StoredAppleTokenColumns) : null;
        },
        loadStoredTokenForSubject: async (subjectSha256) => {
            const { data, error } = await admin
                .from('apple_sign_in_tokens')
                .select('apple_subject_sha256, updated_at')
                .eq('apple_subject_sha256', subjectSha256)
                .maybeSingle();
            if (error) throw new Error(`Apple subject lookup failed: ${error.code ?? 'database_error'}`);
            return data ? storedToken(data as StoredAppleTokenColumns) : null;
        },
        rotateStoredToken: async (expectedUpdatedAt, replacement) => {
            const { data, error } = await admin
                .from('apple_sign_in_tokens')
                .update(replacement)
                .eq('user_id', user.id)
                .eq('updated_at', expectedUpdatedAt)
                .select('user_id')
                .maybeSingle();
            if (error) throw new Error(`Apple token rotation failed: ${error.code ?? 'database_error'}`);
            return data !== null;
        },
        insertStoredToken: async (replacement) => {
            // Insert (not upsert): a concurrent first sign-in must never
            // overwrite the winner's row.
            const { error } = await admin.from('apple_sign_in_tokens').insert({ user_id: user.id, ...replacement });
            if (error) {
                console.error(
                    '[register-apple-token] encrypted token insert failed:',
                    error.code ?? 'database_error',
                );
            }
            return !error;
        },
        revokeRefreshToken: (refreshToken) => revokeAppleRefreshToken(appleConfig, refreshToken),
        now: () => new Date(),
        logError: (message) => console.error(message),
    });
    return json(result.body, result.status);
});
