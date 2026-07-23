import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface AuthenticatedCaller {
    userId: string;
}

/** Preserve auth/quota headers while adding the endpoint's CORS policy. */
export function withCors(response: Response, corsHeaders: Record<string, string>): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
}

/** Authenticate a real user JWT and atomically consume a server-defined quota. */
export async function requireAuthenticatedQuota(
    req: Request,
    bucket: string,
    limit: number,
    windowSeconds: number,
): Promise<AuthenticatedCaller | Response> {
    const authorization = req.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const url = Deno.env.get('SUPABASE_URL');
    const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !publicKey) {
        return new Response(JSON.stringify({ error: 'Server authentication is not configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const client = createClient(url, publicKey, { global: { headers: { Authorization: authorization } } });
    const {
        data: { user },
        error: userError,
    } = await client.auth.getUser();
    if (userError || !user) {
        return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const { data: allowed, error: quotaError } = await client.rpc('consume_edge_quota', {
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
    });
    if (quotaError) {
        console.error(`[edge-quota] ${bucket}: ${quotaError.message}`);
        return new Response(JSON.stringify({ error: 'Request quota service unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        });
    }
    if (!allowed) {
        return new Response(JSON.stringify({ error: 'Request quota exceeded' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(windowSeconds) },
        });
    }

    return { userId: user.id };
}
