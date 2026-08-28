import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, jsonResponse, readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';
import {
    type AutomatedModerationResult,
    buildGeminiModerationRequest,
    CREW_PUBLICATION_MODEL,
    CREW_PUBLICATION_RULES_VERSION,
    type ModerationImage,
    normalizeModerationImage,
    parseCrewPublicationProfile,
    parseGeminiModerationEnvelope,
    runCrewPublicationModerationWithRetry,
} from './moderation.ts';

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MODERATION_REQUEST_TIMEOUT_MS = 15_000;

type RpcRecord = Record<string, unknown>;

function reply(body: unknown, status = 200): Response {
    return jsonResponse(body, status, CORS_HEADERS);
}

function record(value: unknown): RpcRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as RpcRecord) : null;
}

function uuid(value: unknown): value is string {
    return typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function downloadImages(
    download: (path: string) => PromiseLike<{ data: Blob | null; error: unknown }>,
    photoPaths: string[],
): Promise<ModerationImage[] | null> {
    const images: ModerationImage[] = [];
    for (const path of photoPaths) {
        const { data, error } = await download(path);
        if (error || !data) return null;
        const image = normalizeModerationImage(
            data.type || 'application/octet-stream',
            new Uint8Array(await data.arrayBuffer()),
        );
        if (!image) return null;
        images.push(image);
    }
    return images;
}

async function moderate(
    key: string,
    requestBody: Record<string, unknown>,
): Promise<AutomatedModerationResult> {
    try {
        const response = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${CREW_PUBLICATION_MODEL}:generateContent?key=${key}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            },
            MODERATION_REQUEST_TIMEOUT_MS,
        );
        const responseText = await readResponseTextLimited(response, 1_000_000);
        if (!response.ok || responseText === null) {
            return {
                verdict: 'manual_review',
                reasonCode: response.status === 429 ? 'provider_rate_limited' : 'moderation_unavailable',
            };
        }
        return parseGeminiModerationEnvelope(JSON.parse(responseText));
    } catch {
        return { verdict: 'manual_review', reasonCode: 'moderation_unavailable' };
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return reply({ error: 'POST required', code: 'METHOD_NOT_ALLOWED' }, 405);

    const body = await readJsonObject(req, 1_024);
    if (!body || body.action !== 'submit' || Object.keys(body).some((key) => key !== 'action')) {
        return reply({ error: 'Invalid publication request', code: 'INVALID_REQUEST' }, 400);
    }

    const caller = await requireAuthenticatedQuota(req, 'crew_profile_publication', 10, 86_400);
    if (caller instanceof Response) return withCors(caller, CORS_HEADERS);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
        return reply({ error: 'Publication service is unavailable', code: 'SERVER_CONFIG' }, 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: beginData, error: beginError } = await admin.rpc('begin_crew_profile_publication', {
        p_user_id: caller.userId,
        p_moderation_version: CREW_PUBLICATION_RULES_VERSION,
    });
    const beginning = record(beginData);
    if (beginError || !beginning || typeof beginning.status !== 'string') {
        return reply({ error: 'Could not start the safety check', code: 'BEGIN_FAILED' }, 503);
    }

    if (beginning.status === 'published') return reply({ outcome: 'published' });
    if (beginning.status === 'manual_review') return reply({ outcome: 'manual_review' });
    if (beginning.status === 'verification_required') {
        return reply({ error: 'Verify your email and mobile first', code: 'VERIFICATION_REQUIRED' }, 403);
    }
    if (beginning.status === 'blocked') {
        return reply({ error: 'This account cannot publish a Crew List profile', code: 'ACCOUNT_RESTRICTED' }, 403);
    }
    if (beginning.status === 'incomplete' || beginning.status === 'missing') {
        return reply({ error: 'Complete your Crew List profile before publishing', code: 'PROFILE_INCOMPLETE' }, 422);
    }
    if (beginning.status !== 'checking' || !uuid(beginning.attempt_id)) {
        return reply({ error: 'Could not start the safety check', code: 'BEGIN_INVALID' }, 503);
    }

    const attemptId = beginning.attempt_id;
    let moderationResult: AutomatedModerationResult = {
        verdict: 'manual_review',
        reasonCode: 'moderation_unavailable',
    };
    try {
        const { data: profileData, error: profileError } = await admin
            .from('sailor_crew_profiles')
            .select(
                'listing_type,first_name,gender,age_range,has_partner,partner_details,skills,sailing_experience,sailing_region,available_from,available_to,bio,vibe,languages,interests,smoking,drinking,pets,location_state,location_country,crew_photo_path,crew_photo_paths',
            )
            .eq('user_id', caller.userId)
            .maybeSingle();
        const profile = profileError ? null : parseCrewPublicationProfile(profileData);
        const images = profile
            ? await downloadImages((path) => admin.storage.from('crew-list-photos').download(path), profile.photoPaths)
            : null;
        const moderationRequest = profile && images ? buildGeminiModerationRequest(profile, images) : null;
        const geminiKey = Deno.env.get('GEMINI_API_KEY');
        if (!profile || !images || !moderationRequest) {
            moderationResult = { verdict: 'manual_review', reasonCode: 'photo_unavailable' };
        } else if (!geminiKey) {
            moderationResult = { verdict: 'manual_review', reasonCode: 'moderation_unavailable' };
        } else {
            moderationResult = await runCrewPublicationModerationWithRetry(() =>
                moderate(geminiKey, moderationRequest)
            );
        }
    } catch {
        // Once begin has committed, always attempt the fail-closed finalizer so
        // an ordinary Storage/network exception enters the private queue rather
        // than silently stranding the profile in an in-flight state.
    }

    const { data: finalData, error: finalError } = await admin.rpc('finalize_crew_profile_publication', {
        p_user_id: caller.userId,
        p_attempt_id: attemptId,
        p_verdict: moderationResult.verdict,
        p_reason_code: moderationResult.reasonCode,
    });
    const finalResult = record(finalData);
    if (finalError || !finalResult || typeof finalResult.status !== 'string') {
        return reply({ error: 'Could not finish the safety check', code: 'FINALIZE_FAILED' }, 503);
    }
    if (finalResult.status === 'published') return reply({ outcome: 'published' });
    if (finalResult.status === 'manual_review') return reply({ outcome: 'manual_review' });
    if (finalResult.status === 'stale') {
        return reply(
            { error: 'Your profile changed during the safety check. Save it again.', code: 'PROFILE_CHANGED' },
            409,
        );
    }
    return reply({ error: 'Could not finish the safety check', code: 'FINALIZE_INVALID' }, 503);
});
