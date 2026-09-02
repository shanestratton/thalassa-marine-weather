/**
 * apple-server-notification — verified Sign in with Apple event receiver.
 *
 * Apple cannot send a Supabase JWT, so the gateway is public. Trust comes only
 * from RS256 verification of the JWS against Apple's live JWKS plus exact
 * issuer/audience validation. Destructive events are durably queued before a
 * narrowly authenticated call into the same resumable deletion workflow used
 * by the app. Apple receives success only after durable deletion completes.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sha256Hex, verifyAppleServerNotification } from '../_shared/apple-auth.ts';
import { jsonResponse, readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';

const json = (body: unknown, status = 200): Response => jsonResponse(body, status);

serve(async (req: Request) => {
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const body = await readJsonObject(req, 65_536);
    const signedPayload = body?.payload;
    if (typeof signedPayload !== 'string' || signedPayload.length < 64 || signedPayload.length > 64_000) {
        return json({ error: 'A signed Apple payload is required' }, 400);
    }

    const clientId = Deno.env.get('APPLE_SIGN_IN_CLIENT_ID')?.trim();
    const processorSecret = Deno.env.get('APPLE_NOTIFICATION_PROCESSOR_SECRET')?.trim();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!clientId || !processorSecret || !supabaseUrl || !serviceRoleKey) {
        return json({ error: 'Apple server notifications are not configured' }, 503);
    }

    let event;
    try {
        event = await verifyAppleServerNotification(signedPayload, clientId);
    } catch (error) {
        console.error(
            '[apple-server-notification] signature/claim verification failed:',
            error instanceof Error ? error.message : 'unknown error',
        );
        return json({ error: 'Invalid Apple server notification' }, 401);
    }

    if (event.eventType === 'email-enabled' || event.eventType === 'email-disabled') {
        return json({ accepted: true, action: 'not_required' });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const subjectSha256 = await sha256Hex(event.subject);
    const { data: tokenOwner, error: ownerError } = await admin
        .from('apple_sign_in_tokens')
        .select('user_id')
        .eq('apple_subject_sha256', subjectSha256)
        .maybeSingle();
    if (ownerError) {
        console.error('[apple-server-notification] subject resolution failed:', ownerError.message);
        return json({ error: 'Apple notification could not be queued' }, 503);
    }
    // A subject with no retained token has no live Thalassa account action.
    // Do not create an ownerless queue row containing a provider identifier
    // after account deletion; acknowledge the signed event so Apple need not
    // retry it indefinitely.
    if (!tokenOwner?.user_id) {
        return json({ accepted: true, action: 'already_unlinked' });
    }

    const { error: queueError } = await admin.from('apple_server_notification_queue').upsert(
        {
            jti: event.jti,
            event_type: event.eventType,
            apple_subject_sha256: subjectSha256,
            user_id: tokenOwner.user_id,
            event_time: event.eventTime.toISOString(),
            issued_at: event.issuedAt.toISOString(),
            status: 'pending',
        },
        { onConflict: 'jti', ignoreDuplicates: true },
    );
    if (queueError) {
        console.error('[apple-server-notification] durable queue write failed:', queueError.message);
        return json({ error: 'Apple notification could not be queued' }, 503);
    }

    let processorResponse: Response;
    try {
        processorResponse = await fetch(`${supabaseUrl}/functions/v1/delete-account`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
                'Content-Type': 'application/json',
                'X-Thalassa-Apple-Processor': processorSecret,
            },
            body: JSON.stringify({ appleNotificationJti: event.jti }),
        });
    } catch (error) {
        console.error(
            '[apple-server-notification] account processor request failed:',
            error instanceof Error ? error.message : 'unknown error',
        );
        await admin
            .from('apple_server_notification_queue')
            .update({ status: 'failed', last_error: 'processor_request_failed' })
            .eq('jti', event.jti);
        return json({ error: 'Apple notification account action is pending retry' }, 503);
    }

    const processorText = await readResponseTextLimited(processorResponse, 8_192);
    let processorBody: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = processorText ? JSON.parse(processorText) : null;
        processorBody = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        processorBody = null;
    }
    if (!processorResponse.ok || processorBody?.deleted !== true) {
        const failureCode = `processor_http_${processorResponse.status}`;
        console.error('[apple-server-notification] account processor did not complete:', failureCode);
        await admin
            .from('apple_server_notification_queue')
            .update({ status: 'failed', last_error: failureCode })
            .eq('jti', event.jti);
        return json({ error: 'Apple notification account action is pending retry' }, 503);
    }

    return json({ accepted: true, action: 'account_deleted' });
});
