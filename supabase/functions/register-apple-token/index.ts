/**
 * register-apple-token — retain a revocable Apple credential after native auth.
 *
 * The native client invokes this only after Supabase has authenticated Apple's
 * ID token. This function independently authenticates that session, exchanges
 * the one-time authorization code with Apple, verifies the signed Apple
 * subject belongs to the caller, encrypts the refresh token, and stores it in
 * a service-role-only table. Authorization codes and tokens are never logged.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    appleSubjectForAuthenticatedUser,
    decryptAppleRefreshToken,
    encryptAppleRefreshToken,
    exchangeAppleAuthorizationCode,
    readAppleServerConfig,
    revokeAppleRefreshToken,
    sha256Hex,
    verifyAppleIdTokenSubject,
} from '../_shared/apple-auth.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200): Response => jsonResponse(body, status, CORS);

interface StoredAppleToken {
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    encryption_version: number;
    apple_subject_sha256: string;
    updated_at: string;
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

    let appleConfig;
    try {
        appleConfig = await readAppleServerConfig();
    } catch (error) {
        console.error('[register-apple-token] invalid server credential configuration:', error);
        return json({ error: 'Apple token registration is not configured' }, 503);
    }
    if (!appleConfig) return json({ error: 'Apple token registration is not configured' }, 503);

    let refreshToken: string | null = null;
    let refreshTokenNeedsCompensatingRevocation = false;
    try {
        const tokenExchange = await exchangeAppleAuthorizationCode(appleConfig, authorizationCode);
        refreshToken = tokenExchange.refreshToken;
        refreshTokenNeedsCompensatingRevocation = true;
        const exchangedSubject = await verifyAppleIdTokenSubject(tokenExchange.idToken, appleConfig.clientId);
        if (exchangedSubject !== callerAppleSubject) {
            await revokeAppleRefreshToken(appleConfig, refreshToken);
            refreshToken = null;
            refreshTokenNeedsCompensatingRevocation = false;
            return json({ error: 'Apple credential does not belong to the authenticated account' }, 403);
        }

        const subjectSha256 = await sha256Hex(exchangedSubject);
        const encrypted = await encryptAppleRefreshToken(refreshToken, appleConfig, user.id, subjectSha256);
        const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: existingToken, error: existingTokenError } = await admin
            .from('apple_sign_in_tokens')
            .select('refresh_token_ciphertext, refresh_token_iv, encryption_version, apple_subject_sha256, updated_at')
            .eq('user_id', user.id)
            .maybeSingle();
        if (existingTokenError) {
            throw new Error(`Existing Apple token lookup failed: ${existingTokenError.code ?? 'database_error'}`);
        }

        const replacement = {
            refresh_token_ciphertext: encrypted.ciphertext,
            refresh_token_iv: encrypted.iv,
            encryption_version: encrypted.encryptionVersion,
            apple_subject_sha256: subjectSha256,
            updated_at: new Date().toISOString(),
        };
        if (existingToken) {
            const previous = existingToken as StoredAppleToken;
            if (previous.apple_subject_sha256 !== subjectSha256) {
                throw new Error('Existing Apple credential belongs to a different provider subject');
            }
            const previousRefreshToken = await decryptAppleRefreshToken(
                previous.refresh_token_ciphertext,
                previous.refresh_token_iv,
                previous.encryption_version,
                appleConfig,
                user.id,
                previous.apple_subject_sha256,
            );
            // Apple may return the same refresh token on a repeated grant. Do
            // not revoke it in that case; just rotate its ciphertext/nonce.
            if (previousRefreshToken !== refreshToken) {
                await revokeAppleRefreshToken(appleConfig, previousRefreshToken);
            } else {
                // The existing row already tracks this exact token. If an
                // optimistic update loses a race, do not revoke the winner's
                // still-tracked credential in the compensating catch below.
                refreshTokenNeedsCompensatingRevocation = false;
            }

            // Optimistic concurrency prevents two simultaneous sign-ins from
            // overwriting each other and orphaning the losing refresh token.
            const { data: updated, error: updateError } = await admin
                .from('apple_sign_in_tokens')
                .update(replacement)
                .eq('user_id', user.id)
                .eq('updated_at', previous.updated_at)
                .select('user_id')
                .maybeSingle();
            if (updateError || !updated) {
                throw new Error(`Apple token rotation conflict: ${updateError?.code ?? 'concurrent_update'}`);
            }
        } else {
            // Insert (not upsert): a concurrent first sign-in must never
            // overwrite the winner. Apple can return the same refresh token
            // to both exchanges, though, so the loser must read the committed
            // row before deciding whether compensating revocation is safe.
            const { error: insertError } = await admin.from('apple_sign_in_tokens').insert({
                user_id: user.id,
                ...replacement,
            });
            if (insertError) {
                const { data: concurrentWinner, error: winnerLookupError } = await admin
                    .from('apple_sign_in_tokens')
                    .select('refresh_token_ciphertext, refresh_token_iv, encryption_version, apple_subject_sha256')
                    .eq('user_id', user.id)
                    .maybeSingle();
                if (!winnerLookupError && concurrentWinner) {
                    const winner = concurrentWinner as StoredAppleToken;
                    if (winner.apple_subject_sha256 === subjectSha256) {
                        const winnerRefreshToken = await decryptAppleRefreshToken(
                            winner.refresh_token_ciphertext,
                            winner.refresh_token_iv,
                            winner.encryption_version,
                            appleConfig,
                            user.id,
                            winner.apple_subject_sha256,
                        );
                        if (winnerRefreshToken === refreshToken) {
                            // This credential is already durably tracked by
                            // the concurrent winner. Revoking it here would
                            // invalidate the very row we just verified.
                            refreshToken = null;
                            refreshTokenNeedsCompensatingRevocation = false;
                            return json({ registered: true });
                        }
                    }
                }
                throw new Error(`Encrypted token persistence failed: ${insertError.code ?? 'database_error'}`);
            }
        }

        refreshToken = null;
        refreshTokenNeedsCompensatingRevocation = false;
        return json({ registered: true });
    } catch (error) {
        // Never include an authorization code, ID token, or refresh token in
        // logs or responses. The client signs its new local session out and
        // requires the sailor to start a fresh Apple authorization.
        console.error(
            '[register-apple-token] registration failed:',
            error instanceof Error ? error.message : 'unknown error',
        );
        if (refreshToken && refreshTokenNeedsCompensatingRevocation) {
            await revokeAppleRefreshToken(appleConfig, refreshToken).catch((revokeError) => {
                console.error(
                    '[register-apple-token] compensating revocation failed:',
                    revokeError instanceof Error ? revokeError.message : 'unknown error',
                );
            });
        }
        return json({ error: 'Apple token registration failed; start Sign in with Apple again' }, 502);
    }
});
