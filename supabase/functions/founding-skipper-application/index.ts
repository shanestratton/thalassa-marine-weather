import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { validateFoundingSkipperApplication } from './validation.ts';

const ALLOWED_ORIGINS = new Set([
    'https://www.thalassawx.app',
    'https://thalassawx.app',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
]);

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    return {
        ...(origin && ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin',
    };
}

function respond(req: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return withCors(jsonResponse(body, status, extraHeaders), corsHeaders(req));
}

Deno.serve(async (req: Request) => {
    const origin = req.headers.get('origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) return respond(req, { error: 'Origin not allowed' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== 'POST') return respond(req, { error: 'POST required' }, 405, { Allow: 'POST, OPTIONS' });
    if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') ?? '')) {
        return respond(req, { error: 'JSON required' }, 415);
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'founding_skipper_apply', 10, 5, 3600, true);
    if (caller instanceof Response) return withCors(caller, corsHeaders(req));

    const body = await readJsonObject(req, 8_192);
    if (!body) return respond(req, { error: 'Please check the highlighted fields' }, 400);

    const validated = validateFoundingSkipperApplication(body);
    if (!validated.value) {
        return respond(req, { error: 'Please check the highlighted fields', fields: validated.fields }, 400);
    }

    // Password managers should ignore this deliberately obscure field. If a
    // bot fills it, answer generically without writing its payload or exposing
    // the trap.
    if (validated.value.honeypotTriggered) return respond(req, { ok: true }, 202);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
        return respond(req, { error: 'Applications are temporarily unavailable. Please try again.' }, 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const application = validated.value;
    const { error } = await admin.rpc('submit_founding_skipper_application', {
        p_name: application.name,
        p_email: application.email,
        p_boat_type: application.boatType,
        p_home_waters: application.homeWaters,
        p_apple_device: application.appleDevice,
        p_boating_frequency: application.boatingFrequency,
        p_interests: application.interests,
        p_notes: application.notes,
        p_source: application.source,
    });
    if (error) {
        console.error('[founding-skipper-application] storage failed');
        return respond(req, { error: 'Applications are temporarily unavailable. Please try again.' }, 503);
    }

    // New and duplicate emails receive the same response to prevent address
    // enumeration. The database retains the first application only.
    return respond(req, { ok: true }, 202);
});
