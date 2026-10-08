/**
 * apple-server-notification — verified Sign in with Apple event receiver.
 *
 * Apple cannot send a Supabase JWT, so the gateway is public. Trust comes only
 * from RS256 verification of the JWS against Apple's live JWKS plus exact
 * issuer/audience validation. What each verified event does is decided in
 * notification.ts: consent-revoked signs the user out (it never deletes the
 * account), account-deleted is durably queued before a narrowly authenticated
 * call into the same resumable deletion workflow used by the app, and events
 * older than the user's latest Apple sign-in are acknowledged and ignored.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sha256Hex, verifyAppleServerNotification } from '../_shared/apple-auth.ts';
import { jsonResponse, readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';
import { handleVerifiedAppleNotification } from './notification.ts';
import { endUserSessionsStartedBy } from './sign-out.ts';

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

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await handleVerifiedAppleNotification(event, {
        sha256Hex,
        loadTokenOwner: async (subjectSha256) => {
            const { data, error } = await admin
                .from('apple_sign_in_tokens')
                .select('user_id, updated_at')
                .eq('apple_subject_sha256', subjectSha256)
                .maybeSingle();
            if (error) throw new Error(error.code ?? 'database_error');
            const row = data as { user_id?: unknown; updated_at?: unknown } | null;
            if (typeof row?.user_id !== 'string' || typeof row.updated_at !== 'string') return null;
            return { userId: row.user_id, updatedAt: row.updated_at };
        },
        accountDeletionInProgress: async (userId) => {
            const { data, error } = await admin
                .from('account_deletion_jobs')
                .select('user_id')
                .eq('user_id', userId)
                .maybeSingle();
            if (error) throw new Error(error.code ?? 'database_error');
            return data !== null;
        },
        signOutUserSessions: (userId, startedAtOrBefore) => {
            const databaseUrl = Deno.env.get('SUPABASE_DB_URL');
            if (!databaseUrl) return Promise.reject(new Error('SUPABASE_DB_URL is not configured'));
            return endUserSessionsStartedBy(databaseUrl, userId, startedAtOrBefore).then(() => undefined);
        },
        deleteStoredAppleToken: async (userId, subjectSha256, expectedUpdatedAt) => {
            // Only the row this event was judged against: a sign-in that rotated
            // it in the meantime holds fresh consent and keeps its token.
            const { error } = await admin
                .from('apple_sign_in_tokens')
                .delete()
                .eq('user_id', userId)
                .eq('apple_subject_sha256', subjectSha256)
                .eq('updated_at', expectedUpdatedAt);
            if (error) throw new Error(error.code ?? 'database_error');
        },
        queueAccountDeletion: async (row) => {
            const { error } = await admin.from('apple_server_notification_queue').upsert(
                { ...row, status: 'pending' },
                { onConflict: 'jti', ignoreDuplicates: true },
            );
            if (error) throw new Error(error.code ?? 'database_error');
        },
        runAccountDeletion: async (jti) => {
            const response = await fetch(`${supabaseUrl}/functions/v1/delete-account`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${serviceRoleKey}`,
                    apikey: serviceRoleKey,
                    'Content-Type': 'application/json',
                    'X-Thalassa-Apple-Processor': processorSecret,
                },
                body: JSON.stringify({ appleNotificationJti: jti }),
            });
            const text = await readResponseTextLimited(response, 8_192);
            let body: Record<string, unknown> | null = null;
            try {
                const parsed: unknown = text ? JSON.parse(text) : null;
                body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? (parsed as Record<string, unknown>)
                    : null;
            } catch {
                body = null;
            }
            return { ok: response.ok, status: response.status, deleted: body?.deleted === true };
        },
        markQueueFailed: async (jti, code) => {
            const { error } = await admin
                .from('apple_server_notification_queue')
                .update({ status: 'failed', last_error: code })
                .eq('jti', jti);
            if (error) console.error('[apple-server-notification] could not checkpoint queue failure:', error.code);
        },
        logError: (message) => console.error(message),
    });
    return json(result.body, result.status);
});
