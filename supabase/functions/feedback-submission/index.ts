import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { validateProductFeedback } from './validation.ts';

const ALLOWED_ORIGINS = new Set([
    'https://www.thalassawx.app',
    'https://thalassawx.app',
    'https://www.thalassawx.com',
    'https://thalassawx.com',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
]);
const REFERENCE = /^FB-[0-9A-F]{8}$/u;

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

function runInBackground(task: Promise<void>): void {
    const runtime = (globalThis as typeof globalThis & {
        EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }).EdgeRuntime;
    if (runtime) runtime.waitUntil(task);
    else void task;
}

async function wakeEmailWorker(supabaseUrl: string, anonKey: string, workerKey: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch(`${supabaseUrl.replace(/\/$/u, '')}/functions/v1/feedback-email-worker`, {
            method: 'POST',
            headers: {
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
                'Content-Type': 'application/json',
                'X-Thalassa-Worker-Key': workerKey,
            },
            body: '{}',
            signal: controller.signal,
        });
        if (!response.ok) console.warn(`[feedback-submission] email worker wake failed (${response.status})`);
    } catch {
        // The transactional outbox and scheduled worker remain the durable
        // delivery path. A failed fast wake never makes a stored report look
        // unsuccessful to its sender.
        console.warn('[feedback-submission] email worker wake failed');
    } finally {
        clearTimeout(timeout);
    }
}

function feedbackReference(value: unknown): string | null {
    const row = Array.isArray(value) ? value[0] : value;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const reference = (row as Record<string, unknown>).reference;
    return typeof reference === 'string' && REFERENCE.test(reference) ? reference : null;
}

Deno.serve(async (req: Request) => {
    const origin = req.headers.get('origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) return respond(req, { error: 'Origin not allowed' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== 'POST') return respond(req, { error: 'POST required' }, 405, { Allow: 'POST, OPTIONS' });
    if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') ?? '')) {
        return respond(req, { error: 'JSON required' }, 415);
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'product_feedback_submit', 20, 5, 3_600, true);
    if (caller instanceof Response) return withCors(caller, corsHeaders(req));

    // The byte cap accommodates every valid maximum-length UTF-8 payload,
    // including four-byte Unicode, while remaining a small fixed boundary.
    const body = await readJsonObject(req, 65_536);
    if (!body) return respond(req, { error: 'Please check the highlighted fields' }, 400);

    const validated = validateProductFeedback(body);
    if (!validated.value) {
        return respond(req, { error: 'Please check the highlighted fields', fields: validated.fields }, 400);
    }

    // Silently accept bot-filled traps without retaining or emailing any of
    // their payload. The deliberately generic reference cannot identify a row.
    if (validated.value.honeypotTriggered) {
        return respond(req, { ok: true, reference: 'FB-RECEIVED' }, 202);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        return respond(req, { error: 'Feedback is temporarily unavailable. Please try again.' }, 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const feedback = validated.value;
    const { data, error } = await admin.rpc('submit_product_feedback', {
        p_client_submission_id: feedback.clientSubmissionId,
        p_kind: feedback.kind,
        p_name: feedback.name,
        p_email: feedback.email,
        p_area: feedback.area,
        p_title: feedback.title,
        p_details: feedback.details,
        p_impact: feedback.impact,
        p_steps_to_reproduce: feedback.stepsToReproduce,
        p_expected_result: feedback.expectedResult,
        p_actual_result: feedback.actualResult,
        p_problem_to_solve: feedback.problemToSolve,
        p_ideal_outcome: feedback.idealOutcome,
        p_device: feedback.device,
        p_app_version: feedback.appVersion,
        p_app_build: feedback.appBuild,
        p_app_platform: feedback.appPlatform,
        p_diagnostics: feedback.diagnostics,
        p_source: feedback.source,
        p_consent_version: feedback.consentVersion,
    });
    if (error) {
        console.error('[feedback-submission] storage failed');
        const status = error.code === '22023' ? 409 : 503;
        const message = status === 409
            ? 'That submission could not be safely retried. Please reload the page and try again.'
            : 'Feedback is temporarily unavailable. Please try again.';
        return respond(req, { error: message }, status);
    }

    const reference = feedbackReference(data);
    if (!reference) {
        console.error('[feedback-submission] invalid storage response');
        return respond(req, { error: 'Feedback is temporarily unavailable. Please try again.' }, 503);
    }

    runInBackground(wakeEmailWorker(supabaseUrl, anonKey, serviceRoleKey));
    return respond(req, { ok: true, reference }, 202);
});
