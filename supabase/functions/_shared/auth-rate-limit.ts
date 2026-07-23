import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse } from './http-security.ts';

export interface AuthenticatedCaller {
    userId: string;
}

export interface QuotaCaller {
    userId: string | null;
    kind: 'authenticated' | 'public';
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
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) {
        return jsonResponse({ error: 'Authentication required' }, 401, {
            'WWW-Authenticate': 'Bearer',
        });
    }

    const url = Deno.env.get('SUPABASE_URL');
    const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !publicKey) {
        return jsonResponse({ error: 'Server authentication is not configured' }, 500);
    }

    const client = createClient(url, publicKey, { global: { headers: { Authorization: authorization } } });
    const {
        data: { user },
        error: userError,
    } = await client.auth.getUser();
    if (userError || !user) {
        return jsonResponse({ error: 'Invalid or expired session' }, 401, {
            'WWW-Authenticate': 'Bearer',
        });
    }

    const { data: allowed, error: quotaError } = await client.rpc('consume_edge_quota', {
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
    });
    if (quotaError) {
        console.error(`[edge-quota] ${bucket}: ${quotaError.message}`);
        return jsonResponse({ error: 'Request quota service unavailable' }, 503, {
            'Retry-After': '60',
        });
    }
    if (!allowed) {
        return jsonResponse({ error: 'Request quota exceeded' }, 429, {
            'Retry-After': String(windowSeconds),
        });
    }

    return { userId: user.id };
}

function clientAddress(req: Request): string | null {
    const cloudflare = req.headers.get('cf-connecting-ip')?.trim();
    if (cloudflare && cloudflare.length <= 64) return cloudflare;

    const realIp = req.headers.get('x-real-ip')?.trim();
    if (realIp && realIp.length <= 64) return realIp;

    // Reverse proxies append their peer to X-Forwarded-For. Use the final
    // address, not the attacker-controlled first entry.
    const forwarded = req.headers.get('x-forwarded-for');
    const forwardedHops =
        forwarded
            ?.split(',')
            .map((value) => value.trim())
            .filter(Boolean) ?? [];
    const finalHop = forwardedHops[forwardedHops.length - 1];
    return finalHop && finalHop.length <= 64 ? finalHop : null;
}

async function hmacClientAddress(address: string, serviceRoleKey: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(serviceRoleKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`thalassa-edge-v1:${address}`)),
    );
    return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function consumePublicQuota(
    req: Request,
    bucket: string,
    limit: number,
    windowSeconds: number,
): Promise<Response | null> {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const address = clientAddress(req);
    if (!url || !serviceRoleKey || !address) {
        return jsonResponse({ error: 'Anonymous quota service unavailable' }, 503, {
            'Retry-After': '60',
        });
    }

    const clientHash = await hmacClientAddress(address, serviceRoleKey);
    const admin = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: allowed, error } = await admin.rpc('consume_public_edge_quota', {
        p_bucket: bucket,
        p_client_hash: clientHash,
        p_limit: limit,
        p_window_seconds: windowSeconds,
    });
    if (error) {
        console.error(`[public-edge-quota] ${bucket}: ${error.message}`);
        return jsonResponse({ error: 'Anonymous quota service unavailable' }, 503, {
            'Retry-After': '60',
        });
    }
    if (!allowed) {
        return jsonResponse({ error: 'Request quota exceeded' }, 429, {
            'Retry-After': String(windowSeconds),
        });
    }
    return null;
}

/**
 * Paid/public-read endpoints accept a real user session at the normal quota,
 * or the project's public anon credential at a deliberately lower per-client
 * quota. A malformed/expired user token never falls back to the public lane.
 */
export async function requireAuthenticatedOrPublicQuota(
    req: Request,
    bucket: string,
    authenticatedLimit: number,
    publicLimit: number,
    windowSeconds: number,
    allowCredentiallessPublic = false,
): Promise<QuotaCaller | Response> {
    const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!publicKey) return jsonResponse({ error: 'Server authentication is not configured' }, 500);

    const authorization = req.headers.get('authorization');
    const apiKey = req.headers.get('apikey');
    const bearer = authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? null;
    const isPublicCredential =
        bearer === publicKey ||
        (!bearer && apiKey === publicKey) ||
        (allowCredentiallessPublic && !authorization && !apiKey);

    if (!isPublicCredential) {
        const authenticated = await requireAuthenticatedQuota(req, bucket, authenticatedLimit, windowSeconds);
        return authenticated instanceof Response
            ? authenticated
            : { userId: authenticated.userId, kind: 'authenticated' };
    }

    const quotaFailure = await consumePublicQuota(req, `${bucket}_public`, publicLimit, windowSeconds);
    return quotaFailure ?? { userId: null, kind: 'public' };
}
