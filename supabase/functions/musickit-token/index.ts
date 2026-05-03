// deno-lint-ignore-file
/**
 * musickit-token — Apple MusicKit developer token signer.
 *
 * Apple Music requires apps to authenticate to MusicKit with a JWT
 * signed by the developer's private key (ES256 algorithm). We hold
 * the private key here as a Supabase secret and sign tokens on
 * demand. Tokens are valid for up to 6 hours per Apple's spec; we
 * cache for 5 hours and let clients refresh from there.
 *
 * Why this lives server-side: the .p8 private key is a real
 * credential — anyone who has it can sign tokens that impersonate
 * Thalassa to Apple Music. Shipping it in the iOS bundle would let
 * any reverse-engineer extract it. Keeping it in Supabase secrets
 * means the iOS client just asks our server for a token; the key
 * itself never leaves Supabase.
 *
 * Apple JWT spec:
 *   - alg: ES256
 *   - kid: MusicKit Key ID (10-char alphanumeric from Apple Developer)
 *   - iss: Team ID (10-char alphanumeric — the Apple Developer team)
 *   - iat: now (unix seconds)
 *   - exp: now + 6 hours (max per Apple)
 *
 * Request: GET /functions/v1/musickit-token
 * Response: { token: string, expires_at: number, cached: boolean }
 *
 * Required Supabase secrets:
 *   - MUSICKIT_PRIVATE_KEY: full .p8 file contents including BEGIN/END lines
 *   - MUSICKIT_KEY_ID: 10-char Key ID from Apple Developer
 *   - MUSICKIT_TEAM_ID: 10-char Team ID from Apple Developer
 */

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { SignJWT, importPKCS8 } from 'npm:jose@5';

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

/** Module-level cache. Edge functions run as long-lived workers in
 *  Supabase; the cache survives across requests on the same warm
 *  instance. Cold starts re-sign — fine because signing is ~10ms. */
let cachedToken: { token: string; expiresAt: number } | null = null;

const SIX_HOURS_SEC = 6 * 60 * 60;
/** Refresh margin — return cached token if it's still valid for at
 *  least this many seconds. Below this threshold, sign a fresh one. */
const CACHE_REFRESH_MARGIN_SEC = 10 * 60; // 10 minutes

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    const now = Math.floor(Date.now() / 1000);

    // Return cached token if still fresh enough.
    if (cachedToken && cachedToken.expiresAt > now + CACHE_REFRESH_MARGIN_SEC) {
        return new Response(
            JSON.stringify({
                token: cachedToken.token,
                expires_at: cachedToken.expiresAt,
                cached: true,
            }),
            { headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
    }

    const privateKeyPem = Deno.env.get('MUSICKIT_PRIVATE_KEY');
    const keyId = Deno.env.get('MUSICKIT_KEY_ID');
    const teamId = Deno.env.get('MUSICKIT_TEAM_ID');

    if (!privateKeyPem || !keyId || !teamId) {
        const missing: string[] = [];
        if (!privateKeyPem) missing.push('MUSICKIT_PRIVATE_KEY');
        if (!keyId) missing.push('MUSICKIT_KEY_ID');
        if (!teamId) missing.push('MUSICKIT_TEAM_ID');
        return new Response(
            JSON.stringify({
                error: `MusicKit credentials not configured. Missing: ${missing.join(', ')}`,
            }),
            { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
    }

    try {
        // PKCS#8 PEM → CryptoKey for jose's SignJWT.
        const privateKey = await importPKCS8(privateKeyPem, 'ES256');
        const expiresAt = now + SIX_HOURS_SEC;

        const token = await new SignJWT({})
            .setProtectedHeader({ alg: 'ES256', kid: keyId })
            .setIssuer(teamId)
            .setIssuedAt(now)
            .setExpirationTime(expiresAt)
            .sign(privateKey);

        cachedToken = { token, expiresAt };

        return new Response(
            JSON.stringify({
                token,
                expires_at: expiresAt,
                cached: false,
            }),
            { headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
    } catch (err) {
        const e = err as Error;
        console.error('[musickit-token] signing failed:', e);
        return new Response(JSON.stringify({ error: `Token signing failed: ${e.message}` }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
});
