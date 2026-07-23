// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse } from '../_shared/http-security.ts';

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

    const caller = await requireAuthenticatedQuota(req, 'deepgram_ticket_edge', 60, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const authHeader = req.headers.get('authorization');
    if (!supabaseUrl || !anonKey || !authHeader) {
        console.error('[deepgram-token] Supabase authentication is not configured');
        return jsonResponse({ error: 'Voice service is not configured' }, 503, CORS);
    }
    const authClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: ticket, error: ticketError } = await authClient.rpc('create_deepgram_proxy_ticket');
    if (ticketError || !ticket) {
        const rateLimited = ticketError?.message?.toLowerCase().includes('rate limit');
        return jsonResponse(
            { error: rateLimited ? 'Voice session quota exceeded' : 'Ticket mint failed' },
            rateLimited ? 429 : 500,
            CORS,
        );
    }

    return jsonResponse({ access_token: ticket, kind: 'proxy-ticket', expires_in: 60 }, 200, CORS);
});
