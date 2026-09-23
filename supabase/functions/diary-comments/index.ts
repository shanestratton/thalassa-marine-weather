import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { validateGuestComment, validCommentTarget } from './validation.ts';
import { allowedDiaryCommentOrigin } from './origins.ts';

function cors(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    return {
        ...(origin && allowedDiaryCommentOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
        Vary: 'Origin',
    };
}
function respond(req: Request, value: unknown, status = 200): Response {
    // Public comments must disappear immediately when the entry/log is hidden.
    return withCors(jsonResponse(value, status, { 'Cache-Control': 'no-store' }), cors(req));
}
async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get('origin');
    if (origin && !allowedDiaryCommentOrigin(origin)) return respond(req, { error: 'Origin not allowed' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'GET' && req.method !== 'POST') return respond(req, { error: 'Method not allowed' }, 405);
    const post = req.method === 'POST';
    const caller = await requireAuthenticatedOrPublicQuota(
        req,
        post ? 'diary_guest_submit' : 'diary_guest_read',
        post ? 5 : 180,
        post ? 5 : 120,
        3600,
        true,
    );
    if (caller instanceof Response) return withCors(caller, cors(req));
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return respond(req, { error: 'Comments are temporarily unavailable.' }, 503);
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    if (!post) {
        const params = new URL(req.url).searchParams;
        const handle = params.get('handle'), entryId = params.get('entry_id');
        if (!validCommentTarget(handle, entryId)) return respond(req, { error: 'Invalid diary entry.' }, 400);
        const { data, error } = await admin.rpc('read_public_diary_comments', {
            p_handle: handle,
            p_entry_id: entryId,
        });
        if (error) return respond(req, { error: 'Comments are temporarily unavailable.' }, 503);
        return respond(req, { comments: data ?? [] });
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') ?? '')) {
        return respond(req, { error: 'JSON required.' }, 415);
    }
    const body = await readJsonObject(req, 16_384);
    const input = body ? validateGuestComment(body) : null;
    if (!input) {
        return respond(req, {
            error: 'Use a name up to 60 characters and a comment up to 2,000 characters, without links or markup.',
        }, 400);
    }
    if (input.honeypot) return respond(req, { ok: true, status: 'pending' }, 202);
    const { data, error } = await admin.rpc('submit_diary_guest_comment', {
        p_handle: input.handle,
        p_entry_id: input.entryId,
        p_submission_id: input.submissionId,
        p_guest_name: input.guestName,
        p_body: input.body,
    });
    if (error) {
        return respond(req, {
            error: error.code === '54000'
                ? 'The comment queue is full. Please try later.'
                : 'Your comment could not be submitted. Please try again.',
        }, error.code === '54000' ? 429 : error.code === '22023' ? 400 : 503);
    }
    if (data !== true) return respond(req, { error: 'This diary entry is not currently public.' }, 404);
    return respond(req, { ok: true, status: 'pending' }, 202);
}
Deno.serve(async (req: Request) => {
    try {
        return await handle(req);
    } catch {
        // Neither upstream errors nor database diagnostics belong in a guest response.
        return respond(req, { error: 'Comments are temporarily unavailable. Please try again.' }, 503);
    }
});
