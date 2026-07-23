/**
 * Compatibility wrapper for the bounded database lookup used by CrewService.
 *
 * New clients call `lookup_user_by_email` directly. Keeping this endpoint
 * avoids breaking older clients without exposing the Auth admin list API.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200): Response => jsonResponse(body, status, corsHeaders);

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const caller = await requireAuthenticatedQuota(req, 'lookup_user_edge', 60, 3600);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    const body = await readJsonObject(req, 2_048);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'A valid email address is required' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const authorization = req.headers.get('authorization');
    if (!supabaseUrl || !anonKey || !authorization) {
        return json({ error: 'Server authentication is not configured' }, 500);
    }

    try {
        // The RPC performs its own exact-email validation, self-check, quota,
        // and only returns the minimum identity required for an invitation.
        const client = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: authorization } },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data, error } = await client.rpc('lookup_user_by_email', {
            lookup_email: email,
        });
        if (error) {
            console.error(`[lookup-user] RPC failed: ${error.message}`);
            return json({ error: 'Lookup unavailable' }, 503);
        }
        return json(data ?? { found: false });
    } catch (error) {
        console.error('[lookup-user] Unhandled lookup failure:', error);
        return json({ error: 'Lookup unavailable' }, 503);
    }
});
