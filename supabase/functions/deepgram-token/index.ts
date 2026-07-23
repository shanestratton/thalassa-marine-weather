// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * deepgram-token — mint a short-lived ticket for the Deepgram proxy.
 *
 * The caller must be a real signed-in Supabase user. The returned random
 * ticket expires after 60 seconds and can be consumed exactly once by the
 * Cloudflare or Supabase WebSocket proxy. Only the proxy ever reads the
 * long-lived Deepgram API key.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

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
    // endpoint creates billable proxy access, so it needs to know WHICH user
    // is asking, not merely that someone has the public project key.
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

    const { data: ticket, error: ticketError } = await authClient.rpc('create_deepgram_proxy_ticket');
    if (ticketError || !ticket) {
        const rateLimited = ticketError?.message?.toLowerCase().includes('rate limit');
        return new Response(
            JSON.stringify({ error: rateLimited ? 'Voice session quota exceeded' : 'Ticket mint failed' }),
            {
                status: rateLimited ? 429 : 500,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            },
        );
    }

    return new Response(JSON.stringify({ access_token: ticket, kind: 'proxy-ticket', expires_in: 60 }), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
});
