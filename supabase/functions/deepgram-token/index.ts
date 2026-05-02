// deno-lint-ignore-file
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
 *   session over a JWT-gated TLS-protected fetch. A determined attacker
 *   on their own device could still extract it via MITM, same as with
 *   any other secret we surface; the operational mitigation is
 *   Deepgram's spending cap on the user's account.
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
    // Threat model: the long-lived key crosses the wire over an
    // authenticated, TLS-protected fetch from the iOS app per session.
    // Same blast radius as anthropic-proxy's pattern. Operational
    // mitigation is the spending cap on the Deepgram dashboard.
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
