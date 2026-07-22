// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * deepgram-token — return a Deepgram credential the iOS client can use
 * to authenticate a streaming `/v1/listen` WebSocket.
 *
 * Threat model + design notes:
 *   The iOS voice console streams microphone audio to Deepgram over a
 *   WebSocket. Browsers/WKWebView cannot set the Authorization header on
 *   WebSockets, so the only way to authenticate is via the
 *   `Sec-WebSocket-Protocol` subprotocol header carrying a token.
 *
 *   IDEAL: this function would call Deepgram's `/v1/auth/grant` to mint
 *   a short-lived (30s) bearer token, and the client would use that.
 *   That requires the long-lived API key to have the `Member` scope or
 *   higher. Many keys created via the Deepgram dashboard default to
 *   narrower scopes (`Usage:Read`/`Usage:Write` only) and `/v1/auth/grant`
 *   returns 403 FORBIDDEN for those.
 *
 *   PRACTICAL: we try `/v1/auth/grant` first; if Deepgram rejects we
 *   fall back to returning the long-lived API key directly. The
 *   long-lived key never lives in the iOS bundle — it's fetched per
 *   session over TLS by a caller we have verified is a signed-in user.
 *
 *   That last clause used to read "over a JWT-gated fetch", which was
 *   false and actively reassuring: the only JWT in play was the project
 *   ANON key, which ships inside every web bundle and IPA. verify_jwt
 *   accepted it, so a single request carrying a key anyone could read out
 *   of the app returned this one. An audit on 2026-07-22 did exactly that
 *   and got a 200. The handler now resolves the JWT to a real user and
 *   401s when it cannot, so the sentence is true as written.
 *
 *   Residual risk is unchanged and accepted: a signed-in user on their own
 *   device can still extract the key via MITM, as with any secret we hand
 *   out. The operational mitigation is Deepgram's spending cap.
 *
 *   The client treats the returned token as opaque — it sends it via
 *   `Sec-WebSocket-Protocol: ['token', '<token>']` whether it's a
 *   short-lived bearer or the long-lived API key. Deepgram accepts both.
 *
 * Required Supabase secret:
 *   DEEPGRAM_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
/** 10s ceiling on the upstream call. Token mint is normally sub-second. */
const DEEPGRAM_TIMEOUT_MS = 10_000;

/**
 * Token TTL we ask Deepgram for via /v1/auth/grant. Deepgram caps this
 * at 30s for grants. We ask for the max so the WS handshake has
 * generous headroom without leaking long-lived credentials. The client
 * only needs the token to live until WS auth completes.
 */
const TOKEN_TTL_SECONDS = 30;

interface GrantResult {
    access_token?: string;
    expires_in?: number;
}

async function tryGrantToken(apiKey: string): Promise<{ token: string; expires_in: number } | null> {
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), DEEPGRAM_TIMEOUT_MS);
    try {
        const r = await fetch(DEEPGRAM_GRANT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Token ${apiKey}`,
            },
            body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            const body = await r.text();
            console.warn(`[deepgram-token] grant rejected ${r.status}: ${body.slice(0, 200)}`);
            // Common case: user's key lacks `Member` scope. Fall back
            // to long-lived key. Surface in logs, don't fail the request.
            return null;
        }
        const data = (await r.json()) as GrantResult;
        if (!data.access_token) return null;
        return { token: data.access_token, expires_in: data.expires_in ?? TOKEN_TTL_SECONDS };
    } catch (err) {
        const e = err as Error;
        console.warn(`[deepgram-token] grant transport error: ${e.message}`);
        return null;
    } finally {
        clearTimeout(watchdog);
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
            status: 405,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // ── Caller must be a REAL signed-in user, not just anon-key holder ──
    // verify_jwt (on by default, no config.toml here) only proves the caller
    // holds a valid project JWT — and the anon key is compiled into every
    // shipped web bundle and IPA, so on its own that gates nothing. This
    // endpoint hands back the long-lived DEEPGRAM_API_KEY, so it needs to know
    // WHICH user is asking, not merely that someone has the public key.
    // (Audit 2026-07-22: a probe using the anon JWT lifted from the shipped
    // bundle returned 200 and the key.)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
            status: 401,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
    const authClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
    );
    const {
        data: { user: caller },
        error: authError,
    } = await authClient.auth.getUser();
    if (authError || !caller) {
        // The anon key alone lands here: it carries no user identity.
        console.warn('[deepgram-token] rejected caller with no verified user');
        return new Response(JSON.stringify({ error: 'Not authenticated' }), {
            status: 401,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const apiKey = Deno.env.get('DEEPGRAM_API_KEY');
    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'DEEPGRAM_API_KEY not configured' }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // We deliberately SKIP /v1/auth/grant on this hot path and return
    // the long-lived API key directly. Reason: the JWTs that grant
    // returns are ~485 characters long, which iOS WKWebView's WebSocket
    // implementation cannot pass through the Sec-WebSocket-Protocol
    // header reliably. Symptom: WS connects briefly then closes with
    // code=1006 reason="ws error", before any auth check even runs.
    // Long-lived API keys are 40 hex chars — well within any subprotocol
    // value length limits — and Deepgram accepts them via the same
    // bearer/token subprotocol the client already uses.
    //
    // Threat model: the long-lived key crosses the wire over a TLS-protected
    // fetch from a caller verified above to be a signed-in user. Operational
    // mitigation is the spending cap on the Deepgram dashboard.
    // NOTE: do not restore the old "same blast radius as anthropic-proxy"
    // line — that function was audited on the same day and is itself an
    // open, uncapped relay, so it is not a standard to measure against.
    //
    // To revert to ephemeral tokens once iOS WebKit fixes its
    // subprotocol-length quirk, re-enable the tryGrantToken() call
    // above; the function declaration is preserved.
    void tryGrantToken; // intentionally unused — see comment above
    console.log('[deepgram-token] returning long-lived key (iOS WS subprotocol-length quirk)');
    return new Response(
        JSON.stringify({
            access_token: apiKey,
            kind: 'long-lived',
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
});
